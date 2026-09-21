"""The macOS disk layer, driven on any OS with diskutil and authopen faked: enumeration from sample plists (an
internal NVMe, a USB card reader, a disk image, a USB SSD, the built-in SD slot), the swapped-card check, the
authopen descriptor hand-off over a socketpair (POSIX) and the whole flash sequence into a temp file standing in
for /dev/rdiskN: byte for byte against the image, the first MiB blanked first and landed last, the boot files,
macOS's junk removed, then eject."""
import errno
import lzma
import os
import plistlib
import socket
import subprocess
import sys
import threading

import pytest

import flasher
import macdisk
import windisk
from conftest import PUBKEY, new_root

IMG_SIZE = 3 * 1024 * 1024 + 100  # not a sector multiple, like the real image
CARD_SIZE = 4 * 1024 * 1024
KEY = "form-enrollment-key_0123456789abcdef"

# ---------------------------------------------------------------- diskutil samples

BOOTFS_UUID = "2F5D1A8C-0000-4000-8000-00000000BEEF"


def _listing(bootfs_mounted=True):
    """`diskutil list -plist` with the internal NVMe (disk0) and its APFS container (disk3, virtual, holds /),
    a USB reader with a Pi card (disk4), a mounted disk image (disk5), a USB SSD (disk6) and a card in the
    built-in SD slot (disk7)."""
    return {
        "AllDisks": ["disk0", "disk0s1", "disk0s2", "disk3", "disk3s1", "disk4", "disk4s1", "disk4s2", "disk5",
                     "disk5s1", "disk6", "disk6s1", "disk7", "disk7s1"],
        "AllDisksAndPartitions": [
            {"Content": "GUID_partition_scheme", "DeviceIdentifier": "disk0", "OSInternal": False, "Size": 1000555581440,
             "Partitions": [{"Content": "Apple_APFS_ISC", "DeviceIdentifier": "disk0s1", "Size": 524288000},
                            {"Content": "Apple_APFS", "DeviceIdentifier": "disk0s2", "Size": 994662584320}]},
            {"APFSContainerReference": "disk3", "APFSPhysicalStores": [{"DeviceIdentifier": "disk0s2"}],
             "APFSVolumes": [{"DeviceIdentifier": "disk3s1", "MountPoint": "/", "VolumeName": "Macintosh HD"},
                             {"DeviceIdentifier": "disk3s5", "MountPoint": "/System/Volumes/Data", "VolumeName": "Data"}],
             "Content": "Apple_APFS", "DeviceIdentifier": "disk3", "Size": 994662584320},
            {"Content": "FDisk_partition_scheme", "DeviceIdentifier": "disk4", "OSInternal": False, "Size": 31914983424,
             "Partitions": [dict({"Content": "Windows_FAT_32", "DeviceIdentifier": "disk4s1", "Size": 536870912,
                                  "VolumeName": "bootfs", "VolumeUUID": BOOTFS_UUID},
                                 **({"MountPoint": "/Volumes/bootfs"} if bootfs_mounted else {})),
                            {"Content": "Linux", "DeviceIdentifier": "disk4s2", "Size": 3200000000}]},
            {"Content": "GUID_partition_scheme", "DeviceIdentifier": "disk5", "OSInternal": False, "Size": 104857600,
             "Partitions": [{"Content": "Apple_HFS", "DeviceIdentifier": "disk5s1", "MountPoint": "/Volumes/Installer",
                             "Size": 104857600, "VolumeName": "Installer"}]},
            {"Content": "GUID_partition_scheme", "DeviceIdentifier": "disk6", "OSInternal": False, "Size": 500107862016,
             "Partitions": [{"Content": "Apple_APFS", "DeviceIdentifier": "disk6s1", "Size": 500000000000}]},
            {"Content": "FDisk_partition_scheme", "DeviceIdentifier": "disk7", "OSInternal": False, "Size": 63864569856,
             "Partitions": [{"Content": "Windows_FAT_32", "DeviceIdentifier": "disk7s1", "MountPoint": "/Volumes/NO NAME",
                             "Size": 63864569856, "VolumeName": "NO NAME"}]},
        ],
        "VolumesFromDisks": ["Macintosh HD", "Data", "bootfs", "Installer", "NO NAME"],
        "WholeDisks": ["disk0", "disk3", "disk4", "disk5", "disk6", "disk7"],
    }


def _info(disk):
    base = {"DeviceIdentifier": disk, "DeviceNode": f"/dev/{disk}", "WholeDisk": True, "DeviceBlockSize": 512,
            "Writable": True, "MountPoint": ""}
    return {
        "disk0": dict(base, BusProtocol="Apple Fabric", Content="GUID_partition_scheme", Ejectable=False, Internal=True,
                      IORegistryEntryName="APPLE SSD AP1024Z Media", MediaName="APPLE SSD AP1024Z Media",
                      RemovableMedia=False, Size=1000555581440, SolidState=True, VirtualOrPhysical="Physical"),
        "disk3": dict(base, BusProtocol="Apple Fabric", Content="EF57347C-0000-11AA-AA11-00306543ECAC", Ejectable=False,
                      Internal=True, IORegistryEntryName="AppleAPFSMedia", MediaName="AppleAPFSMedia",
                      RemovableMedia=False, Size=994662584320, VirtualOrPhysical="Virtual"),
        "disk4": dict(base, BusProtocol="USB", Content="FDisk_partition_scheme", Ejectable=True, Internal=False,
                      IORegistryEntryName="SanDisk 3.2Gen1 Media", MediaName="SanDisk 3.2Gen1 Media",
                      RemovableMedia=True, Size=31914983424, SolidState=False, VirtualOrPhysical="Physical"),
        "disk5": dict(base, BusProtocol="Disk Image", Content="GUID_partition_scheme", Ejectable=True, Internal=False,
                      IORegistryEntryName="Apple UDIF read-only compressed (zlib) Media",
                      MediaName="Apple UDIF read-only compressed (zlib) Media", RemovableMedia=False, Size=104857600,
                      VirtualOrPhysical="Virtual"),
        "disk6": dict(base, BusProtocol="USB", Content="GUID_partition_scheme", Ejectable=True, Internal=False,
                      IORegistryEntryName="Samsung PSSD T7 Media", MediaName="Samsung PSSD T7 Media",
                      RemovableMedia=False, Size=500107862016, SolidState=True, VirtualOrPhysical="Physical"),
        "disk7": dict(base, BusProtocol="Secure Digital", Content="FDisk_partition_scheme", Ejectable=True, Internal=True,
                      IORegistryEntryName="APPLE SD Card Reader Media", MediaName="APPLE SD Card Reader Media",
                      RemovableMedia=True, Size=63864569856, SolidState=False, VirtualOrPhysical="Physical"),
    }[disk]


def _bootfs_info(mount):
    return {"Content": "Windows_FAT_32", "DeviceIdentifier": "disk4s1", "DeviceNode": "/dev/disk4s1",
            "FilesystemName": "MS-DOS FAT32", "FilesystemType": "msdos", "MountPoint": mount, "ParentWholeDisk": "disk4",
            "Size": 536870912, "VolumeName": "bootfs", "VolumeUUID": BOOTFS_UUID, "WholeDisk": False}


class FakeDiskutil:
    """Answers subprocess.run for /usr/sbin/diskutil; records every call. Set .bootfs_mount for disk4s1 and
    .fail[verb] to an error message to make that verb exit 1."""

    def __init__(self, monkeypatch, listing=None):
        self.calls = []
        self.listing = listing or _listing()
        self.infos = {d: _info(d) for d in ("disk0", "disk3", "disk4", "disk5", "disk6", "disk7")}
        self.bootfs_mount = "/Volumes/bootfs"
        self.mount_after = 0  # polls before disk4s1 reports a mount point
        self.fail = {}
        monkeypatch.setattr(macdisk.subprocess, "run", self)

    def __call__(self, argv, **kw):
        assert argv[0] == macdisk.DISKUTIL and kw.get("stdin") is subprocess.DEVNULL
        verb, rest = argv[1], argv[2:]
        self.calls.append(argv[1:])
        if verb in self.fail:
            return subprocess.CompletedProcess(argv, 1, b"", self.fail[verb].encode())
        if verb == "list":
            return subprocess.CompletedProcess(argv, 0, plistlib.dumps(self.listing), b"")
        if verb == "info":
            target = rest[-1]
            if target == "disk4s1":
                polls = sum(1 for c in self.calls if c[:3] == ["info", "-plist", "disk4s1"])
                mount = self.bootfs_mount if polls > self.mount_after else ""
                return subprocess.CompletedProcess(argv, 0, plistlib.dumps(_bootfs_info(mount)), b"")
            if target in self.infos:
                return subprocess.CompletedProcess(argv, 0, plistlib.dumps(self.infos[target]), b"")
            return subprocess.CompletedProcess(argv, 1, b"", f"Could not find disk: {target}".encode())
        if verb in ("unmountDisk", "mountDisk", "eject"):
            return subprocess.CompletedProcess(argv, 0, b"done\n", b"")
        raise AssertionError(f"unexpected diskutil {argv[1:]}")


# ---------------------------------------------------------------- enumeration

def test_list_disks_keeps_cards_and_drops_the_rest(monkeypatch):
    du = FakeDiskutil(monkeypatch)
    disks = macdisk.list_disks()
    assert [d["number"] for d in disks] == [4, 7]  # the USB reader's card and the built-in slot's card
    assert disks[0] == {"number": 4, "name": "SanDisk 3.2Gen1", "bus": "USB", "size": 31914983424, "sector": 512,
                        "unique_id": "USB:SanDisk 3.2Gen1 Media:/dev/disk4", "serial": "", "boot": False,
                        "signature": "FDisk_partition_scheme;disk4s1:536870912:Windows_FAT_32:" + BOOTFS_UUID
                                     + ";disk4s2:3200000000:Linux:",
                        "device": "/dev/disk4", "label": "disk4  SanDisk 3.2Gen1  32 GB"}
    assert disks[1]["label"] == "disk7  APPLE SD Card Reader  64 GB" and disks[1]["bus"] == "Secure Digital"
    # disk0 (holds /) and disk3 (its container) are never even asked about; the others are asked and dropped.
    asked = [c[2] for c in du.calls if c[0] == "info"]
    assert asked == ["disk4", "disk5", "disk6", "disk7"]
    assert macdisk._system_disks(du.listing) == {"disk0", "disk3"}
    # A Mac booted from an external SSD: that SSD holds / and is dropped even though it is external.
    ext = _listing()
    ext["AllDisksAndPartitions"][1]["APFSPhysicalStores"] = [{"DeviceIdentifier": "disk6s1"}]
    assert "disk6" in macdisk._system_disks(ext)
    # A reader unplugged between the two calls is skipped, not fatal.
    del du.infos["disk7"]
    assert [d["number"] for d in macdisk.list_disks()] == [4]


def test_disk_row_rules():
    assert macdisk._disk_row(_info("disk0")) is None  # internal, fixed
    assert macdisk._disk_row(_info("disk3")) is None  # virtual
    assert macdisk._disk_row(_info("disk5")) is None  # disk image
    assert macdisk._disk_row(_info("disk6")) is None  # USB SSD: fixed media, like the Windows tool
    assert macdisk._disk_row(_info("disk7"))["number"] == 7  # built-in slot: internal but removable
    assert macdisk._disk_row(dict(_info("disk4"), Ejectable=False, RemovableMedia=False)) is None
    assert macdisk._disk_row(dict(_info("disk4"), WholeDisk=False)) is None
    odd = macdisk._disk_row(dict(_info("disk4"), MediaName="", IORegistryEntryName="", DeviceBlockSize=0))
    assert odd["name"] == "Card" and odd["sector"] == 512
    assert macdisk.disk_label({"number": 2, "name": "Reader", "size": 0}) == "disk2  Reader  (no card)"
    assert macdisk.MAX_CARD_BYTES == windisk.MAX_CARD_BYTES and macdisk.human_size is windisk.human_size


def test_check_disk_detects_swapped_card(monkeypatch):
    du = FakeDiskutil(monkeypatch)
    d = macdisk.list_disks()[0]
    macdisk.check_disk(d)  # unchanged: fine
    for change in ({"Size": 128035676160}, {"MediaName": "Other Media"}, {"BusProtocol": "SATA"}):
        du.infos["disk4"] = dict(_info("disk4"), **change)
        with pytest.raises(macdisk.DiskError, match="not the one confirmed"):
            macdisk.check_disk(d)
    du.infos["disk4"] = _info("disk4")
    # A different card in the same reader: another partition layout (the signature).
    swapped = _listing()
    swapped["AllDisksAndPartitions"][2]["Partitions"][0]["VolumeUUID"] = "00000000-0000-4000-8000-000000000000"
    du.listing = swapped
    with pytest.raises(macdisk.DiskError, match="signature"):
        macdisk.check_disk(d)
    du.listing = _listing()
    du.listing["WholeDisks"].remove("disk4")
    with pytest.raises(macdisk.DiskError, match="gone"):
        macdisk.check_disk(d)
    du.listing = _listing()
    du.infos["disk4"] = dict(_info("disk4"), RemovableMedia=False)
    with pytest.raises(macdisk.DiskError, match="not a removable card"):
        macdisk.check_disk(d)


def test_clear_disk_unmounts_and_reports_busy(monkeypatch):
    du = FakeDiskutil(monkeypatch)
    macdisk.clear_disk(4, "ignored")
    assert du.calls[-1] == ["unmountDisk", "force", "/dev/disk4"]
    du.fail["unmountDisk"] = "Unmount of all volumes on disk4 failed"
    with pytest.raises(macdisk.DiskError, match="could not be unmounted.*Close Finder windows"):
        macdisk.clear_disk(4)
    assert macdisk.partition_style(4) == "MBR"
    du.infos["disk4"] = dict(_info("disk4"), Content="GUID_partition_scheme")
    assert macdisk.partition_style(4) == "GPT"
    du.infos["disk4"] = dict(_info("disk4"), Content="")
    assert macdisk.partition_style(4) == "RAW"
    assert macdisk.volume_paths(4) == []


def test_find_boot_volume_mounts_then_polls(monkeypatch):
    du = FakeDiskutil(monkeypatch)
    du.mount_after = 2
    monkeypatch.setattr(macdisk.time, "sleep", lambda s: None)
    logged = []
    assert macdisk.find_boot_volume(4, log=logged.append) == "/Volumes/bootfs"
    assert du.calls[0] == ["mountDisk", "/dev/disk4"]
    assert sum(1 for c in du.calls if c[:3] == ["info", "-plist", "disk4s1"]) == 3
    du.mount_after = 10 ** 6
    with pytest.raises(macdisk.DiskError, match="within 0 s"):
        macdisk.find_boot_volume(4, timeout=0)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(macdisk.Cancelled):
        macdisk.find_boot_volume(4, cancel_event=cancel)
    # mountDisk failing (the ext4 root partition never mounts) is not an error; a missing partition is polled through.
    du.mount_after = 0
    du.fail["mountDisk"] = "One or more volume(s) failed to mount"
    assert macdisk.find_boot_volume(4) == "/Volumes/bootfs"


def test_eject_cleans_the_volume_first(monkeypatch, tmp_path):
    du = FakeDiskutil(monkeypatch)
    boot = tmp_path / "bootfs"
    boot.mkdir()
    (boot / "cmdline.txt").write_text("x")
    (boot / "._cmdline.txt").write_bytes(b"\0\x05\x16\x07")
    (boot / ".DS_Store").write_bytes(b"")
    (boot / ".fseventsd").mkdir()
    (boot / ".fseventsd" / "fseventsd-uuid").write_text("u")
    (boot / ".Spotlight-V100" / "Store-V2").mkdir(parents=True)
    (boot / ".Trashes").mkdir()
    removed = macdisk.clean_volume(boot)
    assert sorted(removed) == [".DS_Store", ".Spotlight-V100", ".Trashes", "._cmdline.txt", ".fseventsd"]
    # What stays: the file we wrote and the two empty markers that keep macOS from writing again at unmount.
    assert sorted(p.name for p in boot.iterdir()) == [".fseventsd", ".metadata_never_index", "cmdline.txt"]
    assert [p.name for p in (boot / ".fseventsd").iterdir()] == ["no_log"]
    assert (boot / ".fseventsd" / "no_log").stat().st_size == 0 == (boot / ".metadata_never_index").stat().st_size
    assert macdisk.clean_volume(tmp_path / "missing") == []
    macdisk.eject(str(boot))
    assert du.calls[-1] == ["eject", str(boot)]
    du.fail["eject"] = "Unmount failed"
    with pytest.raises(macdisk.DiskError, match="Unmount failed"):
        macdisk.eject(str(boot))


# ---------------------------------------------------------------- authopen and the raw device

def _card_file(tmp_path, size=CARD_SIZE):
    card = tmp_path / "rdisk4"
    with open(card, "wb") as f:
        f.truncate(size)
    return card


def _fake_open(monkeypatch, card):
    """Stand in for authopen on any OS: the descriptor of the temp file (the real thing is tested below)."""
    opened = []

    def fake(path, flags=os.O_RDWR):
        opened.append(path)
        return os.open(card, os.O_RDWR | getattr(os, "O_BINARY", 0))

    monkeypatch.setattr(macdisk, "_authopen", fake)
    return opened


@pytest.mark.skipif(not hasattr(socket, "send_fds"), reason="SCM_RIGHTS needs a POSIX socketpair")
def test_authopen_hands_the_descriptor_over_a_socketpair(tmp_path, monkeypatch):
    """A stand-in for /usr/libexec/authopen that speaks its protocol: `-stdoutpipe -o <flags> <path>`, the open
    descriptor sent over stdout (a socketpair end) with SCM_RIGHTS. On a Mac the real authopen asks for the
    password first; the flasher's side is identical."""
    card = _card_file(tmp_path)
    script = tmp_path / "authopen.py"
    script.write_text("import os, socket, sys\n"
                      "flags = int(sys.argv[sys.argv.index('-o') + 1]); path = sys.argv[-1]\n"
                      "if os.environ.get('AUTHOPEN_DENY'): sys.stderr.write('authopen: authorization failed\\n'); sys.exit(1)\n"
                      "fd = os.open(path, flags)\n"
                      "socket.send_fds(socket.socket(fileno=1), [b'x'], [fd])\n")
    monkeypatch.setattr(macdisk, "AUTHOPEN", [sys.executable, str(script)])
    fd = macdisk._authopen(str(card))
    with os.fdopen(fd, "r+b", buffering=0) as f:
        f.write(b"hello")
        f.seek(0)
        assert f.read(5) == b"hello"
    assert card.read_bytes()[:5] == b"hello"
    monkeypatch.setenv("AUTHOPEN_DENY", "1")
    with pytest.raises(macdisk.DiskError, match="Permission was refused.*authorization failed"):
        macdisk._authopen(str(card))
    monkeypatch.setattr(macdisk, "AUTHOPEN", [str(tmp_path / "no-such-authopen")])
    with pytest.raises(macdisk.DiskError, match="authopen could not run"):
        macdisk._authopen(str(card))


def test_rawdisk_over_a_file_defers_the_head_like_windows(tmp_path, monkeypatch):
    data = bytes(range(256)) * (IMG_SIZE // 256 + 1)
    data = bytearray(data[:IMG_SIZE])
    for i in range(0, IMG_SIZE, 4099):
        data[i] = (i * 7) & 0xFF
    data = bytes(data)
    xz = tmp_path / "fake.img.xz"
    xz.write_bytes(lzma.compress(data, format=lzma.FORMAT_XZ))
    card = _card_file(tmp_path)
    with open(card, "r+b") as f:  # an old partition table on the card
        f.write(b"OLDTABLE" * 64)
    du = FakeDiskutil(monkeypatch)
    opened = _fake_open(monkeypatch, card)
    writes = []
    real_write = macdisk.RawDisk.write
    monkeypatch.setattr(macdisk.RawDisk, "write", lambda self, b: writes.append((self.handle.tell(), len(b))) or real_write(self, b))
    with macdisk.open_physical_drive(4, expect_size=CARD_SIZE) as drive:
        assert opened == ["/dev/rdisk4"] and drive.length() == CARD_SIZE
        drive.lock(macdisk.volume_paths(4))
        assert writes == [(0, windisk.DEFER_FIRST_BYTES)]  # the old table is blanked before anything else
        assert card.read_bytes()[:64] == b"\0" * 64
        written = windisk.write_image(str(xz), drive, chunk=256 * 1024, limit=CARD_SIZE)
        assert written == IMG_SIZE + (512 - IMG_SIZE % 512)
        assert all(off >= windisk.DEFER_FIRST_BYTES for off, _ in writes[1:])
        assert drive.deferred_head == data[:windisk.DEFER_FIRST_BYTES]
        assert card.read_bytes()[:windisk.DEFER_FIRST_BYTES] == b"\0" * windisk.DEFER_FIRST_BYTES
        assert windisk.verify_image(str(xz), drive, skip=windisk.DEFER_FIRST_BYTES)
        assert not windisk.verify_image(str(xz), drive)
        assert drive.commit_head() == windisk.DEFER_FIRST_BYTES
        assert writes[-1] == (0, windisk.DEFER_FIRST_BYTES)
        drive.refresh_partitions()
    out = card.read_bytes()
    assert out[:IMG_SIZE] == data and out[IMG_SIZE:written] == b"\0" * (written - IMG_SIZE)
    assert out[written:] == b"\0" * (CARD_SIZE - written)
    assert windisk.verify_image(str(xz), str(card))
    # Large transfers are split into IO_CHUNK pieces, whole sectors each; reads too.
    with macdisk.open_physical_drive(4) as drive:
        drive.seek(0)
        assert drive.read(3 * macdisk.IO_CHUNK)[:IMG_SIZE] == data[:3 * macdisk.IO_CHUNK][:IMG_SIZE]
        pieces = []
        raw = drive.handle
        drive.handle = type("H", (), {"write": staticmethod(lambda b: pieces.append(len(b)) or raw.write(b)),
                                      "tell": staticmethod(raw.tell), "seek": staticmethod(raw.seek),
                                      "fileno": staticmethod(raw.fileno), "close": staticmethod(raw.close)})()
        big = b"\x5a" * (2 * macdisk.IO_CHUNK + 512)
        drive.seek(0)
        assert drive.write(big) == len(big)
        assert pieces == [macdisk.IO_CHUNK, macdisk.IO_CHUNK, 512]
    # A card that is not the size confirmed (swapped between the dialog and the open) is refused and closed.
    with pytest.raises(macdisk.DiskError, match="not the 8 MiB confirmed"):
        macdisk.open_physical_drive(4, expect_size=8 * 1024 * 1024)
    # The SD adapter's lock switch: said in words, before any password prompt.
    du.infos["disk4"] = dict(_info("disk4"), WritableMedia=False)
    opened.clear()
    with pytest.raises(macdisk.DiskError, match="write-protected: slide the lock switch"):
        macdisk.open_physical_drive(4)
    assert opened == []


def test_rawdisk_errors_in_plain_words(tmp_path, monkeypatch):
    card = _card_file(tmp_path, 4096)
    _fake_open(monkeypatch, card)
    drive = macdisk.open_physical_drive(4)

    class Gone:
        def write(self, b):
            raise OSError(errno.ENXIO, "Device not configured")

        def read(self, n):
            raise OSError(errno.EIO, "Input/output error")

        def fileno(self):
            return -1

        def close(self):
            pass

    real = drive.handle
    drive.handle = Gone()
    with pytest.raises(macdisk.DiskError, match="write failed: the card was removed"):
        drive.write(b"\0" * 512)
    with pytest.raises(macdisk.DiskError, match="read failed: the card was removed"):
        drive.read(512)
    drive.handle = real
    assert isinstance(drive._oserror("write", OSError(errno.EACCES, "Permission denied")), macdisk.DiskError)
    assert "permission refused" in str(drive._oserror("write", OSError(errno.EACCES, "Permission denied")))
    assert "busy" in str(drive._oserror("open", OSError(errno.EBUSY, "Resource busy")))
    assert "[22]" in str(drive._oserror("write", OSError(errno.EINVAL, "Invalid argument")))
    drive.close()
    drive.close()  # twice is fine
    assert drive.handle is None


# ---------------------------------------------------------------- the whole flash, as flasher.run_flash drives it

def test_run_flash_on_macos_writes_the_card_byte_for_byte(tmp_path, monkeypatch):
    """flasher.run_flash with macdisk as the disk layer: unmount, authopen, blank the head, write the body, verify,
    land the head, mount, write the boot files, drop macOS's junk, eject. The card file ends up as the image."""
    monkeypatch.setattr(flasher, "disk", macdisk)
    monkeypatch.setattr(flasher.console, "enroll", lambda *a: pytest.fail("flasher enrolled"))
    du = FakeDiskutil(monkeypatch)
    boot = tmp_path / "Volumes" / "bootfs"
    boot.mkdir(parents=True)
    du.bootfs_mount = str(boot)
    (boot / "cmdline.txt").write_text("console=tty1 root=PARTUUID=abc rootwait\n")
    (boot / "._cmdline.txt").write_bytes(b"\0\x05\x16\x07")
    (boot / ".fseventsd").mkdir()
    (boot / ".fseventsd" / "no_log").write_text("")
    (boot / ".Spotlight-V100").mkdir()
    data = os.urandom(IMG_SIZE)
    xz = tmp_path / "os.img.xz"
    xz.write_bytes(lzma.compress(data, format=lzma.FORMAT_XZ))
    card = _card_file(tmp_path)
    with open(card, "r+b") as f:
        f.write(b"OLDTABLE" * 64)
    _fake_open(monkeypatch, card)
    for d4 in (du.infos["disk4"], du.listing["AllDisksAndPartitions"][2]):
        d4["Size"] = CARD_SIZE  # the fake card is 4 MiB
    heads = []  # every write at offset 0, in order
    real_write = macdisk.RawDisk.write
    monkeypatch.setattr(macdisk.RawDisk, "write",
                        lambda self, b: (heads.append(bytes(b[:8])) if self.handle.tell() == 0 else None) or real_write(self, b))
    d = macdisk.list_disks()[0]
    assert d["number"] == 4
    du.calls.clear()
    v = {"name": "Lobby", "ssid": "Venue", "wifi_password": "wp123456", "wifi_hidden": False, "timezone": "UTC",
         "keymap": "us", "wifi_country": "us", "image_mode": "local", "image_path": str(xz), "static_ip": "",
         "gateway": "", "token": "", "device_id": "lobby", "username": "projector-admin", "password": "pw",
         "console_url": "http://console.local/", "enrollment_key": KEY, "operator_token": "", "ssh_pubkey": PUBKEY,
         "dry_run": False, "pi_model": "pi5", "disk_info": d}
    lines, steps = [], []
    flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event(), status=steps.append)
    assert steps == ["Writing the card", "Checking the card", "Finishing the card"]
    verbs = [c[0] for c in du.calls]
    assert verbs[:2] == ["list", "info"]  # check_disk
    assert verbs[2] == "unmountDisk" and du.calls[2] == ["unmountDisk", "force", "/dev/disk4"]
    assert "mountDisk" in verbs and verbs[-1] == "eject" and du.calls[-1] == ["eject", str(boot)]
    assert verbs.index("unmountDisk") < verbs.index("mountDisk") < verbs.index("eject")
    # The old table was blanked first and the real one landed last, after the body was verified.
    assert heads[0] == b"\0" * 8 and heads[-1] == data[:8] and len(heads) == 2
    out = card.read_bytes()
    assert out[:IMG_SIZE] == data and out[IMG_SIZE:] == b"\0" * (CARD_SIZE - IMG_SIZE)
    # The boot files as on Windows: LF, one cmdline line; macOS's junk gone.
    assert (boot / "firstrun.sh").read_bytes().startswith(b"#!/bin/bash\n")
    assert b"\r" not in (boot / "firstrun.sh").read_bytes()
    assert (boot / "cmdline.txt").read_bytes() == b"console=tty1 root=PARTUUID=abc rootwait " + \
        flasher.firstboot.CMDLINE_ARGS.encode() + b"\n"
    assert (boot / flasher.firstboot.PLAYER_ARCHIVE).stat().st_size > 1000
    assert sorted(p.name for p in boot.iterdir()) == [".fseventsd", ".metadata_never_index", "cmdline.txt",
                                                       "firstrun.sh", "projection5000-player.tar.gz",
                                                       "projection5000-provision.sh"]
    text = "\n".join(lines)
    assert f"Boot partition is {boot}" in text and "Writing os.img.xz to disk 4" in text and "SUMMARY" in text
    assert "Checking disk 4 is still SanDisk 3.2Gen1" in text
    # Permission refused at authopen: plain words, nothing written after the unmount.
    du.calls.clear()
    monkeypatch.setattr(macdisk, "_authopen", lambda path, flags=os.O_RDWR: (_ for _ in ()).throw(
        macdisk.DiskError("Permission was refused or the password prompt was cancelled: enter your Mac password "
                          "when asked, then flash again")))
    with pytest.raises(macdisk.DiskError, match="enter your Mac password"):
        flasher.run_flash(v, lines.append, lambda pct, text: None, threading.Event())
    assert [c[0] for c in du.calls] == ["list", "info", "unmountDisk", "info"]  # the last: the write-protect check


def test_gui_lists_mac_cards_through_the_same_screen(monkeypatch):
    """The App with macdisk behind flasher.disk: the same combobox, the same label shape, the same confirm text."""
    monkeypatch.setattr(flasher, "disk", macdisk)
    FakeDiskutil(monkeypatch)
    root = new_root()
    try:
        app = flasher.App(root)
        for _ in range(100):
            root.update()
            if app.disks:
                break
            __import__("time").sleep(0.02)
        assert [d["label"] for d in app.disks] == ["disk4  SanDisk 3.2Gen1  32 GB", "disk7  APPLE SD Card Reader  64 GB"]
        assert app.disk_box.get() == "disk4  SanDisk 3.2Gen1  32 GB"
        assert app.selected_disk()["device"] == "/dev/disk4"
    finally:
        root.destroy()
