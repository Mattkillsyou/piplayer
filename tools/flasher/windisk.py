"""Windows raw disk access for the SD flasher.

Disk/volume enumeration and Clear-Disk go through PowerShell (the Storage
module). The image itself is written with Win32 WriteFile on the PhysicalDriveN device.
write_image also accepts a plain file path as the target so tests run without
admin rights or a card.
"""
import ctypes
import hashlib
import json
import lzma
import os
import struct
import subprocess
import time

CHUNK = 4 * 1024 * 1024
SECTOR = 512
MAX_CARD_BYTES = 256 * 1024 ** 3  # cards for this product are 16-64 GB; anything bigger is not a card
VERIFY_BYTES = 64 * 1024 * 1024
XZ_MAGIC = b"\xfd7zXZ\x00"
# Archives the file picker's "All" filter lets through but that are not raw images.
NOT_IMAGE_MAGIC = {b"\x1f\x8b": "gzip", b"PK\x03\x04": "zip", b"BZh": "bzip2", b"7z\xbc\xaf": "7z", b"Rar!": "rar"}

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ = 0x1
FILE_SHARE_WRITE = 0x2
OPEN_EXISTING = 3
FILE_FLAG_WRITE_THROUGH = 0x80000000
IOCTL_DISK_UPDATE_PROPERTIES = 0x00070140
IOCTL_DISK_GET_LENGTH_INFO = 0x0007405C
FSCTL_LOCK_VOLUME = 0x00090018
FSCTL_DISMOUNT_VOLUME = 0x00090020
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

POWERSHELL = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0",
                          "powershell.exe")


class Cancelled(Exception):
    pass


class DiskError(Exception):
    pass


# ---------------------------------------------------------------- PowerShell

def _ps(script: str, timeout: int = 120) -> str:
    # Absolute path: an elevated process must not resolve "powershell" through the exe's directory or the CWD.
    cmd = [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
           "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " + script]
    # stdin=DEVNULL and CREATE_NO_WINDOW: the --windowed exe has no console to inherit.
    try:
        r = subprocess.run(cmd, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout,
                           stdin=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        raise DiskError(f"{script.split()[0]} did not finish within {timeout} s") from None
    if r.returncode != 0:
        raise DiskError(_ps_error(r.stderr or r.stdout) or f"PowerShell exit {r.returncode}")
    return r.stdout


def _ps_error(text: str) -> str:
    """The message line of a PowerShell error record, without the 'At line:1 char:1' echo of the command."""
    return text.split("\nAt line:", 1)[0].strip()


def _ps_json(script: str, timeout: int = 120) -> list:
    out = _ps(script, timeout).strip()
    if not out:
        return []
    data = json.loads(out)
    return data if isinstance(data, list) else [data]


DISK_FIELDS = "Number,FriendlyName,BusType,Size,LogicalSectorSize,UniqueId,SerialNumber,Signature,Guid,IsBoot,IsSystem"


def list_disks() -> list:
    """Removable disks as dicts: number, name, bus, size (bytes), sector, unique_id, ... label (for the dropdown).

    USB hard disks and SSDs in enclosures share BusType USB with card readers; Win32_DiskDrive.MediaType
    tells them apart ('External hard disk media' vs 'Removable Media', empty for a reader with no card).
    """
    rows = _ps_json(
        "$m = @{}; Get-CimInstance Win32_DiskDrive | ForEach-Object { $m[[string]$_.Index] = [string]$_.MediaType }; "
        "Get-Disk | Where-Object { $_.BusType -in 'USB','SD','MMC' -and -not $_.IsBoot -and -not $_.IsSystem } "
        f"| Select-Object {DISK_FIELDS},@{{n='MediaType';e={{$m[[string]$_.Number]}}}} | ConvertTo-Json -Compress")
    disks = []
    for r in rows:
        if "hard disk" in (r.get("MediaType") or "").lower():
            continue
        disks.append(_disk_row(r))
    return disks


def _disk_row(r: dict) -> dict:
    d = {"number": int(r["Number"]), "name": (r.get("FriendlyName") or "").strip(),
         "bus": r.get("BusType") or "", "size": int(r.get("Size") or 0),
         "sector": int(r.get("LogicalSectorSize") or 0) or SECTOR,
         "unique_id": r.get("UniqueId") or "", "serial": (r.get("SerialNumber") or "").strip(),
         "signature": r.get("Signature") or r.get("Guid") or "",
         "boot": bool(r.get("IsBoot")) or bool(r.get("IsSystem"))}
    d["label"] = disk_label(d)
    return d


def disk_label(d: dict) -> str:
    size = "(no card)" if d["size"] == 0 else human_size(d["size"])
    return f"Disk {d['number']}  {d['name']}  {size}"


def human_size(n: int) -> str:
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.1f} GiB"
    return f"{n / 1024 ** 2:.0f} MiB"


def _ps_str(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def check_disk(d: dict) -> None:
    """Re-read disk d['number'] and refuse unless it is still the disk the operator confirmed.

    Disk numbers are reused when a reader or drive is unplugged, and a card can be swapped in the same
    slot between Refresh and Flash; UniqueId (the reader slot), Size and the MBR signature / GPT guid
    (the card's own partition table) together catch both.
    """
    rows = _ps_json(f"Update-HostStorageCache; Get-Disk -Number {int(d['number'])} -ErrorAction Stop "
                    f"| Select-Object {DISK_FIELDS} | ConvertTo-Json -Compress")
    if not rows:
        raise DiskError(f"disk {d['number']} is gone; click Refresh and try again")
    now = _disk_row(rows[0])
    for key in ("unique_id", "size", "signature", "bus"):
        if now[key] != d[key]:
            raise DiskError(f"disk {d['number']} is not the one confirmed ({key}: {d[key]!r} is now {now[key]!r}). "
                            "The card or reader changed; click Refresh and try again")
    if now["boot"]:
        raise DiskError(f"disk {d['number']} is the Windows boot or system disk; refusing")


def clear_disk(number: int, unique_id: str = "") -> None:
    """Remove every partition so no volume is mounted; Windows only blocks raw writes inside mounted volumes."""
    n = int(number)
    # Clear-Disk leaves the disk RAW and fails with "The disk has not been initialized" (41000) when it
    # already is (factory-blank card, diskpart clean, or a previous run that failed after this step).
    if partition_style(n) == "RAW":
        return
    target = f"-UniqueId {_ps_str(unique_id)}" if unique_id else f"-Number {n}"
    _ps(f"Clear-Disk {target} -RemoveData -RemoveOEM -Confirm:$false -ErrorAction Stop", timeout=180)


def partition_style(number: int) -> str:
    """'RAW', 'MBR' or 'GPT' as reported by Get-Disk."""
    return _ps(f"(Get-Disk -Number {int(number)} -ErrorAction Stop).PartitionStyle").strip().upper()


def find_boot_volume(number: int, timeout: float = 30.0, cancel_event=None, log=None) -> str:
    """Wait for the FAT boot partition of disk N and return its drive letter (e.g. 'E')."""
    deadline = time.monotonic() + timeout
    polls = 0
    while True:
        if cancel_event is not None and cancel_event.is_set():
            raise Cancelled()
        _ps("Update-HostStorageCache")
        for p in _partitions(number):
            label = (p.get("Label") or "").lower()
            fs = (p.get("FS") or "").upper()
            if label in ("bootfs", "boot") or fs in ("FAT32", "FAT"):
                if p.get("DriveLetter"):
                    return p["DriveLetter"]
                _ps(f"Add-PartitionAccessPath -DiskNumber {int(number)} -PartitionNumber "
                    f"{int(p['PartitionNumber'])} -AssignDriveLetter -ErrorAction Stop")
                break
        if time.monotonic() > deadline:
            raise DiskError(f"no FAT boot partition appeared on disk {number} within {timeout:.0f} s")
        polls += 1
        if log and polls % 5 == 0:
            log("  still waiting for Windows to mount the boot partition ...")
        time.sleep(2)


def _partitions(number: int) -> list:
    # An empty Get-Partition sets $? to false and powershell.exe then exits 1, so the empty case is
    # handled explicitly: "no partitions yet" is the state find_boot_volume polls through.
    return _ps_json(
        f"$p = @(Get-Partition -DiskNumber {int(number)} -ErrorAction SilentlyContinue); "
        "if (-not $p) { '[]'; exit 0 }; "
        "$p | ForEach-Object { "
        "$v = $_ | Get-Volume -ErrorAction SilentlyContinue; "
        "[pscustomobject]@{ PartitionNumber = $_.PartitionNumber; "
        "DriveLetter = [string]$v.DriveLetter; Label = [string]$v.FileSystemLabel; FS = [string]$v.FileSystem; "
        "AccessPaths = @($_.AccessPaths) } "
        "} | ConvertTo-Json -Compress; exit 0")


def eject(letter: str) -> None:
    letter = letter.rstrip(":\\/")
    _ps("Update-HostStorageCache; "
        f'(New-Object -ComObject Shell.Application).NameSpace(17).ParseName("{letter}:").InvokeVerb("Eject")')


# ---------------------------------------------------------------- Win32 raw disk

if os.name == "nt":
    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _k32.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                                 ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    _k32.CreateFileW.restype = ctypes.c_void_p
    _k32.WriteFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32,
                               ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
    _k32.ReadFile.argtypes = _k32.WriteFile.argtypes
    _k32.FlushFileBuffers.argtypes = [ctypes.c_void_p]
    _k32.SetFilePointerEx.argtypes = [ctypes.c_void_p, ctypes.c_int64, ctypes.POINTER(ctypes.c_int64), ctypes.c_uint32]
    _k32.DeviceIoControl.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32,
                                     ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
    _k32.CloseHandle.argtypes = [ctypes.c_void_p]


def _winerr(what: str) -> DiskError:
    code = ctypes.get_last_error()
    return DiskError(f"{what} failed: [{code}] {ctypes.FormatError(code).strip()}")


def _open_handle(path: str):
    h = _k32.CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         None, OPEN_EXISTING, FILE_FLAG_WRITE_THROUGH, None)
    if h == INVALID_HANDLE_VALUE or h is None:
        raise _winerr(f"open {path}")
    return h


def _ioctl(handle, code: int, out_len: int = 0) -> bytes:
    out = ctypes.create_string_buffer(out_len) if out_len else None
    ret = ctypes.c_uint32(0)
    if not _k32.DeviceIoControl(handle, code, None, 0, out, out_len, ctypes.byref(ret), None):
        return None
    return out.raw[:ret.value] if out else b""


class PhysicalDrive:
    """Minimal file-like wrapper over a PhysicalDriveN handle (write/read/seek/flush/close)."""

    def __init__(self, number: int, expect_size: int = 0):
        self.path = f"\\\\.\\PhysicalDrive{int(number)}"
        self.number = int(number)
        self.handle = _open_handle(self.path)
        self.volumes = []
        if expect_size:
            length = self.length()
            if length != expect_size:
                self.close()
                raise DiskError(f"{self.path} is {human_size(length)}, not the {human_size(expect_size)} confirmed; "
                                "the card or reader changed. Click Refresh and try again")

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def length(self) -> int:
        raw = _ioctl(self.handle, IOCTL_DISK_GET_LENGTH_INFO, 8)
        if raw is None:
            raise _winerr("IOCTL_DISK_GET_LENGTH_INFO")
        return struct.unpack("<q", raw)[0]

    def lock(self, volume_paths=()) -> None:
        """Lock and dismount every volume on the disk, then lock the disk itself, for the write.

        Windows refuses raw writes that land inside a mounted volume (ERROR_ACCESS_DENIED) and can mount
        partitions as soon as the MBR is written; holding these locks (as Rufus and rpi-imager do) until
        close() prevents both. volume_paths are '\\\\?\\Volume{...}\\' access paths from Get-Partition.
        """
        for vp in volume_paths:
            h = _open_handle(vp.rstrip("\\"))
            self.volumes.append(h)
            if _ioctl(h, FSCTL_LOCK_VOLUME) is None or _ioctl(h, FSCTL_DISMOUNT_VOLUME) is None:
                err = _winerr(f"lock volume {vp}")
                self.close()
                raise DiskError(f"{err}. Another program (Explorer, antivirus) is using the card; close it and retry")
        for _ in range(10):
            if _ioctl(self.handle, FSCTL_LOCK_VOLUME) is not None:
                return
            time.sleep(0.5)
        err = _winerr(f"lock {self.path}")
        self.close()
        raise DiskError(f"{err}. Another program is using the card; close it and retry")

    def write(self, data: bytes) -> int:
        # Raw disk writes must be whole sectors: callers pad to SECTOR multiples.
        buf = (ctypes.c_char * len(data)).from_buffer_copy(data)
        done = ctypes.c_uint32(0)
        if not _k32.WriteFile(self.handle, buf, len(data), ctypes.byref(done), None):
            raise _winerr("WriteFile")
        if done.value != len(data):
            raise DiskError(f"short write: {done.value} of {len(data)} bytes")
        return done.value

    def read(self, n: int) -> bytes:
        buf = ctypes.create_string_buffer(n)
        done = ctypes.c_uint32(0)
        if not _k32.ReadFile(self.handle, buf, n, ctypes.byref(done), None):
            raise _winerr("ReadFile")
        return buf.raw[:done.value]

    def seek(self, offset: int, whence: int = 0) -> None:
        if not _k32.SetFilePointerEx(self.handle, offset, None, whence):
            raise _winerr("SetFilePointerEx")

    def flush(self) -> None:
        if not _k32.FlushFileBuffers(self.handle):
            raise _winerr("FlushFileBuffers")

    def refresh_partitions(self) -> None:
        # Tell the disk class driver to re-read the partition table we just wrote.
        if _ioctl(self.handle, IOCTL_DISK_UPDATE_PROPERTIES) is None:
            raise _winerr("IOCTL_DISK_UPDATE_PROPERTIES")

    def close(self) -> None:
        # Closing the handles releases the locks; Windows then mounts the new partitions.
        for h in self.volumes:
            _k32.CloseHandle(h)
        self.volumes = []
        if self.handle:
            _k32.CloseHandle(self.handle)
            self.handle = None


def open_physical_drive(number: int, expect_size: int = 0) -> PhysicalDrive:
    return PhysicalDrive(number, expect_size)


def volume_paths(number: int) -> list:
    """'\\\\?\\Volume{guid}\\' access paths of every partition on disk N (what PhysicalDrive.lock needs)."""
    paths = []
    for p in _partitions(number):
        for ap in p.get("AccessPaths") or []:
            if ap.startswith("\\\\?\\Volume{"):
                paths.append(ap)
    return paths


# ---------------------------------------------------------------- image streaming

def _is_xz(path) -> bool:
    with open(path, "rb") as f:
        return f.read(len(XZ_MAGIC)) == XZ_MAGIC


def check_image_magic(path) -> None:
    """Reject archives that are not disk images (a .zip or .img.gz written raw never boots)."""
    with open(path, "rb") as f:
        head = f.read(8)
    for magic, kind in NOT_IMAGE_MAGIC.items():
        if head.startswith(magic):
            raise DiskError(f"{os.path.basename(path)} is a {kind} archive, not a .img or .img.xz disk image; "
                            "extract it first")


def image_size(path) -> int:
    """Decompressed size of a .img or .img.xz without reading the whole file (xz keeps it in the index)."""
    if not _is_xz(path):
        return os.path.getsize(path)
    total = 0
    with open(path, "rb") as f:
        end = f.seek(0, os.SEEK_END)
        while end > 0:
            # Stream padding (4-byte null groups) may separate concatenated streams.
            f.seek(max(end - 4096, 0))
            tail = f.read(end - max(end - 4096, 0))
            stripped = tail.rstrip(b"\0")
            end -= len(tail) - len(stripped)
            if not stripped:
                continue
            f.seek(end - 12)
            footer = f.read(12)
            if footer[10:] != b"YZ":
                raise DiskError("not a valid xz file (bad stream footer)")
            index_size = (struct.unpack("<I", footer[4:8])[0] + 1) * 4
            f.seek(end - 12 - index_size)
            idx = f.read(index_size)
            if idx[:1] != b"\0":
                raise DiskError("not a valid xz file (bad index)")
            pos = 1
            count, pos = _varint(idx, pos)
            blocks = 0
            for _ in range(count):
                unpadded, pos = _varint(idx, pos)
                uncompressed, pos = _varint(idx, pos)
                blocks += unpadded + (-unpadded) % 4
                total += uncompressed
            end -= 12 + index_size + blocks + 12  # footer, index, blocks, stream header
            if end < 0:
                raise DiskError("not a valid xz file (stream sizes do not add up)")
    return total


def _varint(buf: bytes, pos: int):
    value, shift = 0, 0
    while True:
        b = buf[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, pos
        shift += 7


def iter_image(src_path, chunk: int = CHUNK, hasher=None):
    """Yield (data, compressed_bytes_consumed) chunks of the decompressed image (xz or raw .img).

    hasher, when given, is updated with the source bytes as they are read.
    """
    with open(src_path, "rb") as f:
        if not _is_xz(src_path):
            while True:
                data = f.read(chunk)
                if not data:
                    return
                if hasher:
                    hasher.update(data)
                yield data, f.tell()
            return
        dec = lzma.LZMADecompressor(format=lzma.FORMAT_XZ)
        buf = b""
        while True:
            if not buf:
                buf = f.read(1024 * 1024)
                if hasher:
                    hasher.update(buf)
            if not buf:
                if dec.eof:
                    return
                raise DiskError("xz stream ended early (truncated image?)")
            if dec.eof:
                # Between concatenated streams: skip padding, then start on the next stream.
                buf = buf.lstrip(b"\0")
                if not buf:
                    continue
                if not buf.startswith(XZ_MAGIC):
                    raise DiskError("trailing data after the xz stream (corrupt image?)")
                dec = lzma.LZMADecompressor(format=lzma.FORMAT_XZ)
            out = dec.decompress(buf, max_length=chunk)
            buf = b""
            while True:
                if out:
                    yield out, f.tell()
                if dec.eof:
                    buf = dec.unused_data
                    break
                if dec.needs_input:
                    break
                out = dec.decompress(b"", max_length=chunk)


def _open_target(target, mode: str):
    if isinstance(target, (str, bytes, os.PathLike)):
        return open(target, mode), True
    return target, False


def write_image(src_path, target, progress_cb=None, cancel_event=None, chunk: int = CHUNK, limit: int = 0,
                sector: int = SECTOR, expected_sha256: str = "") -> int:
    """Stream src_path (.img or .img.xz) to target (file path or PhysicalDrive).

    The final chunk is zero-padded to a sector multiple. progress_cb(written, consumed, total)
    is called per chunk. limit (bytes) refuses to write past the card's capacity; expected_sha256
    is checked against the source bytes as they are read. Returns bytes written (including padding).
    Raises Cancelled.
    """
    total = os.path.getsize(src_path)
    out, own = _open_target(target, "wb")
    hasher = hashlib.sha256() if expected_sha256 else None
    written = 0
    pending = b""

    def emit(data: bytes):
        nonlocal written
        if limit and written + len(data) > limit:
            raise DiskError(f"image is larger than the card ({human_size(written + len(data))}+ > "
                            f"{human_size(limit)})")
        out.write(data)
        written += len(data)

    try:
        for data, consumed in iter_image(src_path, chunk, hasher):
            if cancel_event is not None and cancel_event.is_set():
                raise Cancelled()
            data = pending + data
            cut = len(data) - len(data) % sector
            pending = data[cut:]
            if cut:
                emit(data[:cut])
            if progress_cb:
                progress_cb(written, consumed, total)
        if pending:
            emit(pending + b"\0" * (sector - len(pending) % sector))
            if progress_cb:
                progress_cb(written, total, total)
        out.flush()
    finally:
        if own:
            out.close()
    if hasher and hasher.hexdigest() != expected_sha256.strip().lower():
        raise DiskError("the image file changed while it was being written (sha256 mismatch); "
                        "delete the cached image and flash again")
    return written


def verify_image(src_path, target, progress_cb=None, cancel_event=None, nbytes: int = 0) -> bool:
    """Read target back and compare it with the whole image (or its first nbytes). Raises Cancelled."""
    inp, own = _open_target(target, "rb")
    try:
        inp.seek(0)
        total = os.path.getsize(src_path)
        # Raw disk reads must be whole sectors while xz chunks have arbitrary lengths, so the card is
        # read in CHUNK pieces and the image walked against that buffer at a running offset.
        buf = b""
        checked = 0
        for data, consumed in iter_image(src_path):
            if cancel_event is not None and cancel_event.is_set():
                raise Cancelled()
            if nbytes:
                if checked >= nbytes:
                    break
                data = data[:nbytes - checked]
            while len(buf) < len(data):
                piece = inp.read(CHUNK)
                if not piece:
                    break
                buf += piece
            if buf[:len(data)] != data:
                return False
            buf = buf[len(data):]
            checked += len(data)
            if progress_cb:
                progress_cb(checked, consumed, total)
        return True
    finally:
        if own:
            inp.close()


def verify_head(src_path, target, nbytes: int = VERIFY_BYTES) -> bool:
    """Compare only the first nbytes (cheap check that the write landed)."""
    return verify_image(src_path, target, nbytes=nbytes)
