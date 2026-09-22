"""macOS raw disk access for the SD flasher (windisk.py is the Windows twin; sysplat.py picks one).

Enumeration goes through `diskutil ... -plist`. The card is opened root-only through Apple's authopen (the
standard administrator password prompt, once per flash; what Raspberry Pi Imager and Etcher do): the open file
descriptor for /dev/rdiskN comes back over a socketpair. The image itself is streamed by windisk.write_image
with the same deferred first MiB: diskarbitrationd mounts the FAT partition the moment a partition table lands
and Spotlight/fseventsd write to it, so the table is blanked first, the body written and verified while the
card is unmountable, and commit_head() lands and checks the table last. Then the boot volume is mounted, the
first-boot files written, macOS's junk files removed and the card ejected.

The streaming/verify engine and the error classes are windisk's: same code path on both platforms.
"""
import errno
import os
import plistlib
import re
import shutil
import socket
import struct
import subprocess
import time
from pathlib import Path

from windisk import (CHUNK, DEFER_FIRST_BYTES, MAX_CARD_BYTES, SECTOR, Cancelled, DiskError,  # noqa: F401
                     PhysicalDrive, check_image_magic, human_size, image_size, iter_image, source_name,
                     source_size, verify_head, verify_image, write_image)

DISKUTIL = "/usr/sbin/diskutil"
AUTHOPEN = ["/usr/libexec/authopen"]  # a list so the tests can point it at a stand-in script
IO_CHUNK = 1024 * 1024  # one read()/write() on the raw device; large transfers are split
# What macOS drops on a FAT volume it has mounted; none of it belongs on the Pi's boot partition.
JUNK = (".fseventsd", ".Spotlight-V100", ".Trashes", ".TemporaryItems", ".DS_Store")
SYSTEM_MOUNTS = ("/", "/System/Volumes/", "/private/var/vm")


# ---------------------------------------------------------------- diskutil

def _run(*args, timeout: int = 120) -> subprocess.CompletedProcess:
    try:
        return subprocess.run([DISKUTIL, *args], capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise DiskError(f"diskutil {args[0]} did not finish within {timeout} s") from None
    except OSError as e:
        raise DiskError(f"diskutil could not run: {e}") from e


def _diskutil(*args, timeout: int = 120) -> str:
    r = _run(*args, timeout=timeout)
    if r.returncode != 0:
        msg = (r.stderr or r.stdout).decode("utf-8", "replace").strip()
        raise DiskError(msg or f"diskutil {args[0]} exit {r.returncode}")
    return r.stdout.decode("utf-8", "replace")


def _plist(*args) -> dict:
    r = _run(*args)
    if r.returncode != 0:
        msg = (r.stderr or r.stdout).decode("utf-8", "replace").strip()
        raise DiskError(msg or f"diskutil {args[0]} exit {r.returncode}")
    try:
        data = plistlib.loads(r.stdout)
    except Exception as e:
        raise DiskError(f"diskutil {args[0]} gave no plist: {e}") from e
    return data if isinstance(data, dict) else {}


def _whole(identifier: str) -> str:
    """'disk4s1' -> 'disk4'."""
    m = re.match(r"disk\d+", identifier)
    return m.group(0) if m else identifier


def _system_disks(listing: dict) -> set:
    """Whole disks that back a mounted system volume (the boot disk, an external boot SSD, the VM volume)."""
    out = set()
    for entry in listing.get("AllDisksAndPartitions") or []:
        stores = [s.get("DeviceIdentifier", "") for s in entry.get("APFSPhysicalStores") or []]
        volumes = list(entry.get("APFSVolumes") or []) + list(entry.get("Partitions") or [])
        for v in volumes:
            mp = v.get("MountPoint") or ""
            if mp == "/" or any(mp.startswith(p) for p in SYSTEM_MOUNTS[1:]):
                out.update(_whole(s) for s in stores)
                out.add(_whole(entry.get("DeviceIdentifier", "")))
    return out


def _partitions_of(listing: dict, disk: str) -> list:
    for entry in listing.get("AllDisksAndPartitions") or []:
        if entry.get("DeviceIdentifier") == disk:
            return list(entry.get("Partitions") or [])
    return []


def _signature(listing: dict, disk: str) -> str:
    """The card's own partition layout, so a swapped card in the same reader is caught by check_disk."""
    parts = [f"{p.get('DeviceIdentifier', '')}:{p.get('Size', 0)}:{p.get('Content', '')}:{p.get('VolumeUUID', '')}"
             for p in _partitions_of(listing, disk)]
    scheme = next((e.get("Content", "") for e in listing.get("AllDisksAndPartitions") or []
                   if e.get("DeviceIdentifier") == disk), "")
    return ";".join([scheme, *parts])


def list_disks() -> list:
    """Removable media as dicts: number, name, bus, size (bytes), sector, unique_id, signature, label, device.

    `diskutil list -plist` names every whole disk; `diskutil info -plist diskN` says what it is. Kept: physical
    disks whose media is removable (a card in any reader: the SCSI removable bit, what Windows' MediaType
    'Removable Media' reads too) or on a Secure Digital bus. Dropped: virtual disks (disk images, APFS
    containers), internal fixed disks, USB hard disks and SSDs (fixed media, like the Windows tool), and any
    disk holding a mounted system volume.
    """
    listing = _plist("list", "-plist")
    system = _system_disks(listing)
    disks = []
    for disk in listing.get("WholeDisks") or []:
        if disk in system:
            continue
        try:
            info = _plist("info", "-plist", disk)
        except DiskError:
            continue  # unplugged between the two calls
        d = _disk_row(info, _signature(listing, disk))
        if d is not None:
            disks.append(d)
    return disks


def _disk_row(info: dict, signature: str = ""):
    """The dict for one `diskutil info -plist` answer, or None when the disk is not a card."""
    if info.get("VirtualOrPhysical") == "Virtual" or not info.get("WholeDisk", True):
        return None
    removable = bool(info.get("RemovableMedia")) or info.get("BusProtocol") == "Secure Digital"
    if not removable or (info.get("Internal") and not info.get("RemovableMedia")):
        return None
    if not (info.get("Ejectable") or info.get("RemovableMedia")):
        return None
    ident = info.get("DeviceIdentifier") or ""
    number = int(ident[4:]) if ident.startswith("disk") and ident[4:].isdigit() else -1
    name = (info.get("MediaName") or info.get("IORegistryEntryName") or "").strip()
    if name.endswith(" Media"):
        name = name[:-6]
    d = {"number": number, "name": name or "Card", "bus": info.get("BusProtocol") or "",
         "size": int(info.get("Size") or 0), "sector": int(info.get("DeviceBlockSize") or 0) or SECTOR,
         "unique_id": f"{info.get('BusProtocol', '')}:{info.get('MediaName', '')}:{info.get('DeviceNode', '')}",
         "serial": "", "signature": signature, "boot": False,
         "device": info.get("DeviceNode") or f"/dev/disk{number}"}
    d["label"] = disk_label(d)
    return d


def disk_label(d: dict) -> str:
    """'disk4  SanDisk  32 GB': decimal GB, as Finder and diskutil show a card."""
    size = "(no card)" if d["size"] == 0 else f"{d['size'] / 1e9:.0f} GB"
    return f"disk{d['number']}  {d['name']}  {size}"


def check_disk(d: dict) -> None:
    """Re-read disk d and refuse unless it is still the disk the operator confirmed (same reader and media
    name, same size, same partition layout)."""
    listing = _plist("list", "-plist")
    disk = f"disk{d['number']}"
    if disk not in (listing.get("WholeDisks") or []):
        raise DiskError(f"{disk} is gone; click Refresh and try again")
    now = _disk_row(_plist("info", "-plist", disk), _signature(listing, disk))
    if now is None:
        raise DiskError(f"{disk} is not a removable card any more; click Refresh and try again")
    for key in ("unique_id", "size", "signature", "bus"):
        if now[key] != d[key]:
            raise DiskError(f"{disk} is not the one confirmed ({key}: {d[key]!r} is now {now[key]!r}). "
                            "The card or reader changed; click Refresh and try again")
    if disk in _system_disks(listing):
        raise DiskError(f"{disk} holds a mounted system volume; refusing")


def clear_disk(number: int, unique_id: str = "") -> None:
    """Unmount every volume on the card (force: Finder windows and Spotlight let go). The old partition table
    is blanked by RawDisk.lock() once the card is open, so nothing can mount during the write."""
    try:
        _diskutil("unmountDisk", "force", f"/dev/disk{int(number)}", timeout=60)
    except DiskError as e:
        raise DiskError(f"The card could not be unmounted ({e}). Close Finder windows showing the card, "
                        "quit programs using it, then flash again") from None


def partition_style(number: int) -> str:
    """'RAW', 'MBR' or 'GPT' from the whole disk's content type."""
    content = _plist("info", "-plist", f"disk{int(number)}").get("Content") or ""
    return {"FDisk_partition_scheme": "MBR", "GUID_partition_scheme": "GPT"}.get(content, "RAW")


def _boot_partition(number: int) -> dict:
    """`diskutil info` of the first partition (the FAT boot partition of a Raspberry Pi OS image)."""
    return _plist("info", "-plist", f"disk{int(number)}s1")


def find_boot_volume(number: int, timeout: float = 30.0, cancel_event=None, log=None) -> str:
    """Mount the card again and return the boot partition's mount point (e.g. '/Volumes/bootfs')."""
    deadline = time.monotonic() + timeout
    polls = 0
    while True:
        if cancel_event is not None and cancel_event.is_set():
            raise Cancelled()
        if polls % 5 == 0:
            # mountDisk exits non-zero when the ext4 root partition cannot be mounted: expected, ignored.
            _run("mountDisk", f"/dev/disk{int(number)}", timeout=60)
        try:
            p = _boot_partition(number)
        except DiskError:
            p = {}
        fs = (p.get("FilesystemType") or "").lower()
        content = p.get("Content") or ""
        mount = p.get("MountPoint") or ""
        if mount and (fs in ("msdos", "fat", "fat32", "exfat") or content.startswith("Windows_FAT")
                      or (p.get("VolumeName") or "").lower() in ("bootfs", "boot")):
            return mount
        if time.monotonic() > deadline:
            raise DiskError(f"no FAT boot partition appeared on disk{number} within {timeout:.0f} s")
        polls += 1
        if log and polls % 5 == 0:
            log("  still waiting for macOS to mount the boot partition ...")
        time.sleep(2)


def clean_volume(mount) -> list:
    """Remove what macOS wrote on the boot partition (AppleDouble ._* files, .fseventsd, .Spotlight-V100 ...), then
    leave the two empty markers that tell fseventsd and Spotlight not to write again at unmount
    (.fseventsd/no_log, .metadata_never_index). Returns the names removed; errors are ignored (junk is harmless
    on the Pi, a failed flash is not)."""
    removed = []
    root = Path(mount)
    try:
        entries = list(root.iterdir())
    except OSError:
        return removed
    for p in entries:
        if p.name in JUNK or p.name.startswith("._"):
            try:
                if p.is_dir() and not p.is_symlink():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    p.unlink()
                removed.append(p.name)
            except OSError:
                pass
    for marker in (root / ".fseventsd" / "no_log", root / ".metadata_never_index"):
        try:
            marker.parent.mkdir(exist_ok=True)
            marker.write_bytes(b"")
        except OSError:
            pass
    return removed


def eject(mount: str) -> None:
    """Tidy the boot volume, then eject the whole card (diskutil accepts the mount point)."""
    clean_volume(mount)
    _diskutil("eject", str(mount), timeout=60)


# ---------------------------------------------------------------- authopen: the root-only handle

def _authopen(path: str, flags: int = os.O_RDWR) -> int:
    """An open file descriptor for `path` from /usr/libexec/authopen (which asks for an administrator password
    and hands the descriptor back over its stdout socket, SCM_RIGHTS)."""
    ours, theirs = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        try:
            p = subprocess.Popen([*AUTHOPEN, "-stdoutpipe", "-o", str(flags), path], stdout=theirs,
                                 stdin=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except OSError as e:
            raise DiskError(f"authopen could not run: {e}") from e
        theirs.close()
        theirs = None
        ours.settimeout(600)  # the password prompt waits for the user
        try:
            _, fds, _, _ = socket.recv_fds(ours, 64, 1)
        except (OSError, AttributeError):
            fds = []
        if not fds:
            p.kill()
        try:
            err = p.communicate(timeout=30)[1].decode("utf-8", "replace").strip()
        except subprocess.TimeoutExpired:
            p.kill()
            err = ""
    finally:
        ours.close()
        if theirs is not None:
            theirs.close()
    if not fds:
        detail = f" ({err})" if err else ""
        raise DiskError("Permission was refused or the password prompt was cancelled: enter your Mac password "
                        f"when asked, then flash again{detail}")
    return fds[0]


class RawDisk(PhysicalDrive):
    """windisk.PhysicalDrive over the authopen descriptor of /dev/rdiskN: same write/read/seek/flush/close,
    the same deferred head (commit_head is inherited). Reads and writes are whole sectors, split into 1 MiB
    transfers; a card pulled mid-write surfaces as a DiskError in plain words."""

    def __init__(self, number: int, expect_size: int = 0):
        self.number = int(number)
        self.path = f"/dev/rdisk{self.number}"
        self.volumes = []
        self.handle = None
        self.deferred_head = b""
        try:
            info = _plist("info", "-plist", f"disk{self.number}")
        except DiskError:
            info = {}
        if info.get("WritableMedia") is False or info.get("Writable") is False:  # the SD adapter's lock switch
            raise DiskError("The card is write-protected: slide the lock switch on the SD adapter to the unlocked "
                            "position, re-insert it and flash again")
        fd = _authopen(self.path, os.O_RDWR)
        self.handle = os.fdopen(fd, "r+b", buffering=0)
        if expect_size:
            length = self.length()
            if length != expect_size:
                self.close()
                raise DiskError(f"{self.path} is {human_size(length)}, not the {human_size(expect_size)} confirmed; "
                                "the card or reader changed. Click Refresh and try again")

    def length(self) -> int:
        try:
            import fcntl
            fd = self.handle.fileno()
            block = struct.unpack("I", fcntl.ioctl(fd, 0x40046418, b"\0" * 4))[0]  # DKIOCGETBLOCKSIZE
            count = struct.unpack("Q", fcntl.ioctl(fd, 0x40086419, b"\0" * 8))[0]  # DKIOCGETBLOCKCOUNT
            if block and count:
                return block * count
        except (ImportError, OSError, struct.error):
            pass
        return os.fstat(self.handle.fileno()).st_size  # a plain file standing in for the card (tests)

    def lock(self, volume_paths=()) -> None:
        """Blank the old partition table (the first MiB, later rewritten by commit_head) so diskarbitrationd has
        nothing to mount while the body is written and verified; the Windows tool's Clear-Disk does the same."""
        self.seek(0)
        self.write(b"\0" * DEFER_FIRST_BYTES)
        self.flush()
        self.seek(0)

    def _oserror(self, what: str, e: OSError) -> DiskError:
        if e.errno in (errno.ENXIO, errno.ENODEV, errno.EIO):
            return DiskError(f"{what} failed: the card was removed or stopped answering ({e.strerror})")
        if e.errno in (errno.EACCES, errno.EPERM):
            return DiskError(f"{what} failed: permission refused ({e.strerror})")
        if e.errno == errno.EBUSY:
            return DiskError(f"{what} failed: the card is busy, another program is using it ({e.strerror})")
        return DiskError(f"{what} failed: [{e.errno}] {e.strerror}")

    def write(self, data: bytes) -> int:
        view = memoryview(data)
        done = 0
        while done < len(view):
            piece = view[done:done + IO_CHUNK]
            try:
                n = self.handle.write(piece)
            except OSError as e:
                raise self._oserror("write", e) from None
            if not n:
                raise DiskError(f"short write: {done} of {len(view)} bytes")
            done += n
        return done

    def read(self, n: int) -> bytes:
        out = []
        left = n
        while left > 0:
            try:
                piece = self.handle.read(min(left, IO_CHUNK))
            except OSError as e:
                raise self._oserror("read", e) from None
            if not piece:
                break
            out.append(piece)
            left -= len(piece)
        return b"".join(out)

    def seek(self, offset: int, whence: int = 0) -> None:
        self.handle.seek(offset, whence)

    def flush(self) -> None:
        try:
            os.fsync(self.handle.fileno())
        except OSError:
            pass  # the raw device is unbuffered; a plain file (tests) syncs, a device may say ENOTSUP

    def refresh_partitions(self) -> None:
        """Nothing: closing the descriptor makes diskarbitrationd re-read the table (find_boot_volume mounts)."""

    def close(self) -> None:
        if self.handle is not None:
            try:
                self.handle.close()
            except OSError:
                pass
            self.handle = None


def open_physical_drive(number: int, expect_size: int = 0) -> RawDisk:
    return RawDisk(number, expect_size)


def volume_paths(number: int) -> list:
    """Nothing to lock on macOS: the volumes were unmounted by clear_disk and the table is blanked by lock()."""
    return []
