import lzma
import threading

import pytest

import windisk

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
        "Disk 2  Generic MassStorageClass  29.7 GB"
    assert windisk.disk_label({"number": 3, "name": "SD Reader", "size": 0}) == "Disk 3  SD Reader  (no card)"


def test_list_disks_runs_without_admin():
    # No card inserted here: just check PowerShell enumeration parses (may be empty).
    disks = windisk.list_disks()
    assert isinstance(disks, list)
    for d in disks:
        assert set(d) >= {"number", "name", "bus", "size", "label"}


def test_verify_head_with_unaligned_xz_chunks(tmp_path):
    # Incompressible data makes the decompressor hand out chunks of arbitrary length, so the
    # read-back offsets must be tracked across chunks rather than sector-aligned per chunk.
    import os
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
