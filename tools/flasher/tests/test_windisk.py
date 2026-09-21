import hashlib
import lzma
import os
import sys
import threading

import pytest

import windisk

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="live PowerShell")

IMG_SIZE = 3 * 1024 * 1024 + 100  # deliberately not a multiple of 512


@pytest.fixture(scope="module")
def image(tmp_path_factory):
    d = tmp_path_factory.mktemp("img")
    pattern = bytes(range(256)) * 16
    data = (pattern * (IMG_SIZE // len(pattern) + 1))[:IMG_SIZE]
    # Sprinkle some structure so xz does not collapse everything into one block.
    data = bytearray(data)
    for i in range(0, IMG_SIZE, 4099):
        data[i] = (i * 7) & 0xFF
    data = bytes(data)
    xz = d / "fake.img.xz"
    xz.write_bytes(lzma.compress(data, format=lzma.FORMAT_XZ))
    raw = d / "fake.img"
    raw.write_bytes(data)
    return data, xz, raw


def test_write_image_xz_matches_and_pads(image, tmp_path):
    data, xz, _ = image
    target = tmp_path / "card.bin"
    calls = []
    written = windisk.write_image(str(xz), str(target), progress_cb=lambda w, c, t: calls.append((w, c, t)),
                                  chunk=256 * 1024)
    out = target.read_bytes()
    assert written == len(out)
    assert len(out) % 512 == 0
    assert len(out) - len(data) == 512 - IMG_SIZE % 512
    assert out[:len(data)] == data
    assert out[len(data):] == b"\0" * (len(out) - len(data))
    assert calls, "progress callback never called"
    assert calls[-1][0] == written and calls[-1][1] == calls[-1][2] == xz.stat().st_size
    assert all(c[0] % 512 == 0 for c in calls)
    assert windisk.verify_head(str(xz), str(target))
    assert windisk.verify_head(str(xz), str(target), nbytes=1000)
    assert windisk.verify_image(str(xz), str(target))


def test_write_image_raw_img(image, tmp_path):
    data, _, raw = image
    target = tmp_path / "card.bin"
    windisk.write_image(str(raw), str(target))
    assert target.read_bytes()[:len(data)] == data
    assert target.stat().st_size % 512 == 0


def test_verify_head_detects_corruption(image, tmp_path):
    data, xz, _ = image
    target = tmp_path / "card.bin"
    windisk.write_image(str(xz), str(target))
    with open(target, "r+b") as f:
        f.seek(1234)
        f.write(b"\xff\xfe")
    assert not windisk.verify_head(str(xz), str(target))


def test_cancel_mid_write(image, tmp_path):
    data, xz, _ = image
    target = tmp_path / "card.bin"
    cancel = threading.Event()

    def progress(written, consumed, total):
        if written >= 512 * 1024:
            cancel.set()

    with pytest.raises(windisk.Cancelled):
        windisk.write_image(str(xz), str(target), progress_cb=progress, cancel_event=cancel, chunk=256 * 1024)
    size = target.stat().st_size
    assert 0 < size < len(data)


def test_truncated_xz_raises(image, tmp_path):
    _, xz, _ = image
    bad = tmp_path / "bad.img.xz"
    bad.write_bytes(xz.read_bytes()[:-200])
    with pytest.raises(windisk.DiskError):
        windisk.write_image(str(bad), str(tmp_path / "card.bin"))


def test_disk_label():
    assert windisk.disk_label({"number": 2, "name": "Generic MassStorageClass", "size": 31914983424}) == \
        "Disk 2  Generic MassStorageClass  29.7 GiB"
    assert windisk.disk_label({"number": 3, "name": "SD Reader", "size": 0}) == "Disk 3  SD Reader  (no card)"


@windows_only
def test_list_disks_runs_without_admin():
    # Live smoke test (no card inserted here): PowerShell enumeration must parse (may be empty).
    disks = windisk.list_disks()
    assert isinstance(disks, list)
    for d in disks:
        assert set(d) >= {"number", "name", "bus", "size", "sector", "unique_id", "signature", "label"}
        assert isinstance(d["size"], int) and d["sector"] >= 512


@windows_only
def test_partitions_query_runs_on_empty_disk():
    # Live: a reader with no card has no partitions; the query must return [] rather than exit 1.
    disks = [d for d in windisk.list_disks() if d["size"] == 0]
    if not disks:
        pytest.skip("no empty reader present")
    assert windisk._partitions(disks[0]["number"]) == []


def test_verify_head_with_unaligned_xz_chunks(tmp_path):
    # Incompressible data makes the decompressor hand out chunks of arbitrary length, so the
    # read-back offsets must be tracked across chunks rather than sector-aligned per chunk.
    data = os.urandom(2 * 1024 * 1024 + 300)
    xz = tmp_path / "rand.img.xz"
    xz.write_bytes(lzma.compress(data, format=lzma.FORMAT_XZ))
    lengths = [len(d) for d, _ in windisk.iter_image(str(xz), chunk=256 * 1024)]
    assert any(n % 512 for n in lengths[:-1]), "fixture must produce unaligned chunks"
    target = tmp_path / "card.bin"
    windisk.write_image(str(xz), str(target), chunk=256 * 1024)
    assert target.read_bytes()[:len(data)] == data
    assert windisk.verify_head(str(xz), str(target))
    assert windisk.verify_head(str(xz), str(target), nbytes=700 * 1024 + 13)
    with open(target, "r+b") as f:
        f.seek(len(data) - 5)
        f.write(b"\x00\x01\x02")
    assert not windisk.verify_head(str(xz), str(target))


def test_clear_disk_skips_raw(monkeypatch):
    scripts = []

    def fake_ps(script, timeout=120):
        scripts.append(script)
        return "RAW\n" if "Get-Disk" in script else ""

    monkeypatch.setattr(windisk, "_ps", fake_ps)
    windisk.clear_disk(2)
    assert not any("Clear-Disk" in s for s in scripts)

    scripts.clear()
    monkeypatch.setattr(windisk, "_ps", lambda script, timeout=120: (scripts.append(script), "MBR\n")[1])
    windisk.clear_disk(2)
    assert any(s.startswith("Clear-Disk -Number 2 -RemoveData -RemoveOEM") for s in scripts)
    scripts.clear()
    windisk.clear_disk(2, "USBSTOR\\DISK&VEN_X\\0'1&0:")
    assert any(s.startswith("Clear-Disk -UniqueId 'USBSTOR\\DISK&VEN_X\\0''1&0:' -RemoveData") for s in scripts)


GET_DISK_ROW = {"Number": 2, "FriendlyName": " Generic MassStorageClass ", "BusType": "USB", "Size": 31914983424,
                "LogicalSectorSize": 512, "UniqueId": "USBSTOR\\DISK&VEN_GENERIC\\000000001210&0:X",
                "SerialNumber": None, "Signature": 305419896, "Guid": None, "IsBoot": False, "IsSystem": False,
                "MediaType": "Removable Media"}


def test_list_disks_parses_rows_and_drops_hard_disks(monkeypatch):
    rows = [GET_DISK_ROW,
            dict(GET_DISK_ROW, Number=3, Size=None, LogicalSectorSize=0, MediaType=""),  # reader, no card
            dict(GET_DISK_ROW, Number=4, FriendlyName="Samsung T7", Size=500107862016,
                 MediaType="External hard disk media")]
    monkeypatch.setattr(windisk, "_ps_json", lambda script, timeout=120: rows)
    disks = windisk.list_disks()
    assert [d["number"] for d in disks] == [2, 3]
    assert disks[0] == {"number": 2, "name": "Generic MassStorageClass", "bus": "USB", "size": 31914983424,
                        "sector": 512, "unique_id": "USBSTOR\\DISK&VEN_GENERIC\\000000001210&0:X", "serial": "",
                        "signature": 305419896, "boot": False,
                        "label": "Disk 2  Generic MassStorageClass  29.7 GiB"}
    assert disks[1]["size"] == 0 and disks[1]["sector"] == 512 and disks[1]["label"].endswith("(no card)")
    assert windisk.MAX_CARD_BYTES == 256 * 1024 ** 3


def test_check_disk_detects_swapped_card(monkeypatch):
    d = windisk._disk_row(GET_DISK_ROW)
    monkeypatch.setattr(windisk, "_ps_json", lambda script, timeout=120: [GET_DISK_ROW])
    windisk.check_disk(d)  # unchanged: fine
    for change in ({"Size": 128035676160}, {"Signature": 1}, {"UniqueId": "USBSTOR\\X&1:X"}, {"BusType": "SATA"},
                   {"IsSystem": True}):
        monkeypatch.setattr(windisk, "_ps_json", lambda script, timeout=120, c=change: [dict(GET_DISK_ROW, **c)])
        with pytest.raises(windisk.DiskError):
            windisk.check_disk(d)
    monkeypatch.setattr(windisk, "_ps_json", lambda script, timeout=120: [])
    with pytest.raises(windisk.DiskError, match="gone"):
        windisk.check_disk(d)


def test_partitions_query_handles_empty_disk(monkeypatch):
    scripts = []
    monkeypatch.setattr(windisk, "_ps", lambda script, timeout=120: (scripts.append(script), "[]\n")[1])
    assert windisk._partitions(2) == []
    # The query must not let an empty Get-Partition turn into "PowerShell exit 1".
    assert "if (-not $p) { '[]'; exit 0 }" in scripts[0] and scripts[0].endswith("exit 0")


def test_find_boot_volume_assigns_letter_then_returns(monkeypatch):
    calls = []
    state = {"polls": 0}

    def fake_ps(script, timeout=120):
        calls.append(script)
        return ""

    def fake_partitions(number):
        state["polls"] += 1
        if state["polls"] == 1:
            return []  # provider has not re-enumerated yet
        if state["polls"] == 2:
            return [{"PartitionNumber": 1, "DriveLetter": "", "Label": "bootfs", "FS": "FAT32"},
                    {"PartitionNumber": 2, "DriveLetter": "", "Label": "rootfs", "FS": ""}]
        return [{"PartitionNumber": 1, "DriveLetter": "E", "Label": "bootfs", "FS": "FAT32"}]

    monkeypatch.setattr(windisk, "_ps", fake_ps)
    monkeypatch.setattr(windisk, "_partitions", fake_partitions)
    monkeypatch.setattr(windisk.time, "sleep", lambda s: None)
    assert windisk.find_boot_volume(2) == "E:/"  # a mount path, like macdisk's '/Volumes/bootfs'
    assert any(s.startswith("Add-PartitionAccessPath -DiskNumber 2 -PartitionNumber 1") for s in calls)

    monkeypatch.setattr(windisk, "_partitions", lambda number: [])
    with pytest.raises(windisk.DiskError, match="within 0 s"):
        windisk.find_boot_volume(2, timeout=0)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(windisk.Cancelled):
        windisk.find_boot_volume(2, cancel_event=cancel)


def test_volume_paths(monkeypatch):
    monkeypatch.setattr(windisk, "_partitions", lambda number: [
        {"PartitionNumber": 1, "AccessPaths": ["E:\\", "\\\\?\\Volume{19adc575-6bdf-4c12-8ab6-8589f39a5267}\\"]},
        {"PartitionNumber": 2, "AccessPaths": [None]},  # an MSR or bare Linux partition: @($null) -> [null]
        {"PartitionNumber": 3, "AccessPaths": []}])
    assert windisk.volume_paths(2) == ["\\\\?\\Volume{19adc575-6bdf-4c12-8ab6-8589f39a5267}\\"]


def test_ps_error_is_trimmed():
    rec = ("Clear-Disk : The requested operation cannot be performed.\nAt line:1 char:1\n+ Clear-Disk ...\n"
           "+ ~~~~~\n    + CategoryInfo : ...\n")
    assert windisk._ps_error(rec) == "Clear-Disk : The requested operation cannot be performed."
    if sys.platform == "win32":
        assert windisk.POWERSHELL.lower().endswith("\\system32\\windowspowershell\\v1.0\\powershell.exe")


@windows_only
def test_ps_live_utf8_and_timeout():
    # Live: non-ASCII output survives the round trip, and a hung command becomes a short DiskError.
    assert windisk._ps("Write-Output 'caf\u00e9 \u00fc'").strip() == "caf\u00e9 \u00fc"
    with pytest.raises(windisk.DiskError, match="did not finish"):
        windisk._ps("Start-Sleep 30", timeout=1)
    with pytest.raises(windisk.DiskError) as e:
        windisk._ps("Get-Item C:\\definitely\\not\\here -ErrorAction Stop")
    assert "At line:" not in str(e.value) and "not\\here" in str(e.value)


class FakeDrive:
    """PhysicalDrive-like target: sector-granular, bounded, with a read cursor (the non-path branch)."""

    def __init__(self, capacity):
        self.buf = bytearray(capacity)
        self.pos = 0

    def write(self, data):
        assert len(data) % 512 == 0, "raw writes must be whole sectors"
        if self.pos + len(data) > len(self.buf):
            raise windisk.DiskError("WriteFile failed: [27] The drive cannot find the sector requested.")
        self.buf[self.pos:self.pos + len(data)] = data
        self.pos += len(data)
        return len(data)

    def read(self, n):
        assert n % 512 == 0
        out = bytes(self.buf[self.pos:self.pos + n])
        self.pos += len(out)
        return out

    def seek(self, offset, whence=0):
        self.pos = offset

    def flush(self):
        pass


def test_write_and_verify_against_drive_like_target(image):
    data, xz, _ = image
    drive = FakeDrive(4 * 1024 * 1024)
    written = windisk.write_image(str(xz), drive, chunk=256 * 1024)
    assert written % 512 == 0 and bytes(drive.buf[:len(data)]) == data
    assert windisk.verify_image(str(xz), drive)
    assert windisk.verify_head(str(xz), drive, nbytes=1000)
    drive.buf[len(data) - 3] ^= 0xFF  # corruption near the end, well past any "head" check
    assert windisk.verify_head(str(xz), drive, nbytes=1024 * 1024)
    assert not windisk.verify_image(str(xz), drive)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(windisk.Cancelled):
        windisk.verify_image(str(xz), drive, cancel_event=cancel)


def test_oversized_image_is_refused_before_overflow(image, tmp_path):
    data, xz, raw = image
    for src in (xz, raw):
        drive = FakeDrive(2 * 1024 * 1024)
        with pytest.raises(windisk.DiskError, match="larger than the card"):
            windisk.write_image(str(src), drive, limit=2 * 1024 * 1024)
        assert drive.pos <= 2 * 1024 * 1024
    assert windisk.image_size(str(raw)) == len(data)
    assert windisk.image_size(str(xz)) == len(data)


def test_multistream_xz_is_written_completely(tmp_path):
    a = os.urandom(300000)
    b = bytes(range(256)) * 1200
    xz = tmp_path / "two.img.xz"
    xz.write_bytes(lzma.compress(a, format=lzma.FORMAT_XZ) + lzma.compress(b, format=lzma.FORMAT_XZ))
    assert lzma.open(xz).read() == a + b  # what the stdlib (and xz -d) produce
    assert windisk.image_size(str(xz)) == len(a) + len(b)
    out = b"".join(d for d, _ in windisk.iter_image(str(xz), chunk=65536))
    assert out == a + b
    # Stream padding (4-byte null groups) between streams is allowed by the xz format too.
    padded = tmp_path / "padded.img.xz"
    padded.write_bytes(lzma.compress(a, format=lzma.FORMAT_XZ) + b"\0" * 8 + lzma.compress(b, format=lzma.FORMAT_XZ))
    assert windisk.image_size(str(padded)) == len(a) + len(b)
    assert b"".join(d for d, _ in windisk.iter_image(str(padded), chunk=65536)) == a + b
    target = tmp_path / "card.bin"
    windisk.write_image(str(xz), str(target))
    assert target.read_bytes()[:len(a) + len(b)] == a + b
    assert windisk.verify_image(str(xz), str(target))
    garbage = tmp_path / "garbage.img.xz"
    garbage.write_bytes(lzma.compress(a, format=lzma.FORMAT_XZ) + b"not an xz stream")
    with pytest.raises(windisk.DiskError, match="trailing data"):
        windisk.write_image(str(garbage), str(tmp_path / "g.bin"))


def test_write_image_checks_sha256_of_source(image, tmp_path):
    data, xz, _ = image
    sha = hashlib.sha256(xz.read_bytes()).hexdigest()
    windisk.write_image(str(xz), str(tmp_path / "a.bin"), expected_sha256=sha.upper())
    with pytest.raises(windisk.DiskError, match="sha256"):
        windisk.write_image(str(xz), str(tmp_path / "b.bin"), expected_sha256="0" * 64)


def test_sector_size_padding(image, tmp_path):
    data, _, raw = image
    target = tmp_path / "card4k.bin"
    written = windisk.write_image(str(raw), str(target), sector=4096)
    assert written % 4096 == 0 and written - len(data) < 4096


def test_check_image_magic(tmp_path):
    for name, head in (("a.zip", b"PK\x03\x04junk"), ("b.img.gz", b"\x1f\x8b\x08junk"), ("c.7z", b"7z\xbc\xafjunk")):
        p = tmp_path / name
        p.write_bytes(head + b"\0" * 100)
        with pytest.raises(windisk.DiskError, match="archive"):
            windisk.check_image_magic(str(p))
    ok = tmp_path / "ok.img"
    ok.write_bytes(b"\0" * 100)
    windisk.check_image_magic(str(ok))


class _RecordingDrive(windisk.PhysicalDrive):
    """A PhysicalDrive stand-in backed by a bytearray that records every write's offset."""

    def __init__(self, size):
        self.buf = bytearray(size)
        self.pos = 0
        self.writes = []

    def write(self, data):
        self.writes.append((self.pos, len(data)))
        self.buf[self.pos:self.pos + len(data)] = data
        self.pos += len(data)
        return len(data)

    def seek(self, offset, whence=0):
        self.pos = offset

    def read(self, n):
        out = bytes(self.buf[self.pos:self.pos + n])
        self.pos += len(out)
        return out

    def flush(self):
        pass


def test_write_image_to_physical_drive_defers_the_first_mib(image, tmp_path):
    """Windows mounts the new partitions as soon as the partition table lands, then refuses raw
    writes inside them (error 5) and starts writing its own files there. So the first MiB is
    held back, the body is verified while the card is still blank, and commit_head() lands and
    checks the table last."""
    data, xz, _ = image
    drive = _RecordingDrive(IMG_SIZE + 4096)
    written = windisk.write_image(str(xz), drive, chunk=256 * 1024)
    assert written == len(data) + (512 - IMG_SIZE % 512)
    assert all(w[0] >= windisk.DEFER_FIRST_BYTES for w in drive.writes), drive.writes[:3]
    assert drive.deferred_head == data[:windisk.DEFER_FIRST_BYTES]
    assert bytes(drive.buf[:windisk.DEFER_FIRST_BYTES]) == b"\0" * windisk.DEFER_FIRST_BYTES
    # body verifies with the blank head skipped, and fails without the skip
    assert windisk.verify_image(str(xz), drive, skip=windisk.DEFER_FIRST_BYTES)
    assert not windisk.verify_image(str(xz), drive)
    assert drive.commit_head() == windisk.DEFER_FIRST_BYTES
    assert drive.writes[-1] == (0, windisk.DEFER_FIRST_BYTES)
    assert bytes(drive.buf[:len(data)]) == data
    assert drive.deferred_head == b""
    assert windisk.verify_image(str(xz), drive)


def test_commit_head_detects_a_card_that_drops_the_table(image):
    data, xz, _ = image
    drive = _RecordingDrive(IMG_SIZE + 4096)
    windisk.write_image(str(xz), drive, chunk=256 * 1024)
    real_write = drive.write

    def lossy_write(chunk):
        n = real_write(chunk)
        drive.buf[0:16] = b"\xff" * 16  # the card "forgets" the first sectors
        return n

    drive.write = lossy_write
    with pytest.raises(windisk.DiskError, match="partition table"):
        drive.commit_head()


def test_write_image_to_file_is_sequential(image, tmp_path):
    """Plain file targets (tests, local images) keep the straight sequential write."""
    data, xz, _ = image
    target = tmp_path / "seq.bin"
    windisk.write_image(str(xz), str(target))
    assert target.read_bytes()[:len(data)] == data
