"""Windows raw disk access for the SD flasher.

Disk/volume enumeration and Clear-Disk go through PowerShell (the Storage
module). The image itself is written with Win32 WriteFile on the PhysicalDriveN device.
write_image also accepts a plain file path as the target so tests run without
admin rights or a card.
"""
import ctypes
import json
import lzma
import os
import subprocess
import time

CHUNK = 4 * 1024 * 1024
SECTOR = 512
MAX_CARD_BYTES = 512 * 1024 ** 3
VERIFY_BYTES = 64 * 1024 * 1024
XZ_MAGIC = b"\xfd7zXZ\x00"

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ = 0x1
FILE_SHARE_WRITE = 0x2
OPEN_EXISTING = 3
FILE_FLAG_WRITE_THROUGH = 0x80000000
IOCTL_DISK_UPDATE_PROPERTIES = 0x00070140
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class Cancelled(Exception):
    pass


class DiskError(Exception):
    pass


# ---------------------------------------------------------------- PowerShell

def _ps(script: str, timeout: int = 120) -> str:
    cmd = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]
    # stdin=DEVNULL and CREATE_NO_WINDOW: the --windowed exe has no console to inherit.
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode != 0:
        raise DiskError((r.stderr or r.stdout).strip() or f"PowerShell exit {r.returncode}")
    return r.stdout


def _ps_json(script: str, timeout: int = 120) -> list:
    out = _ps(script, timeout).strip()
    if not out:
        return []
    data = json.loads(out)
    return data if isinstance(data, list) else [data]


def list_disks() -> list:
    """Removable disks as dicts: number, name, bus, size (bytes), label (for the dropdown)."""
    rows = _ps_json(
        "Get-Disk | Where-Object { $_.BusType -in 'USB','SD','MMC' -and -not $_.IsBoot -and -not $_.IsSystem } "
        "| Select-Object Number,FriendlyName,BusType,Size | ConvertTo-Json -Compress")
    disks = []
    for r in rows:
        d = {"number": int(r["Number"]), "name": (r.get("FriendlyName") or "").strip(),
             "bus": r.get("BusType") or "", "size": int(r.get("Size") or 0)}
        d["label"] = disk_label(d)
        disks.append(d)
    return disks


def disk_label(d: dict) -> str:
    size = "(no card)" if d["size"] == 0 else human_size(d["size"])
    return f"Disk {d['number']}  {d['name']}  {size}"


def human_size(n: int) -> str:
    if n >= 1024 ** 3:
        return f"{n / 1024 ** 3:.1f} GB"
    return f"{n / 1024 ** 2:.0f} MB"


def clear_disk(number: int) -> None:
    """Remove every partition so no volume is mounted; Windows only blocks raw writes inside mounted volumes."""
    n = int(number)
    # Clear-Disk leaves the disk RAW and fails with "The disk has not been initialized" (41000) when it
    # already is (factory-blank card, diskpart clean, or a previous run that failed after this step).
    if partition_style(n) == "RAW":
        return
    _ps(f"Clear-Disk -Number {n} -RemoveData -RemoveOEM -Confirm:$false -ErrorAction Stop", timeout=180)


def partition_style(number: int) -> str:
    """'RAW', 'MBR' or 'GPT' as reported by Get-Disk."""
    return _ps(f"(Get-Disk -Number {int(number)} -ErrorAction Stop).PartitionStyle").strip().upper()


def find_boot_volume(number: int, timeout: float = 30.0) -> str:
    """Wait for the FAT boot partition of disk N and return its drive letter (e.g. 'E')."""
    deadline = time.monotonic() + timeout
    while True:
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
        time.sleep(2)


def _partitions(number: int) -> list:
    return _ps_json(
        f"Get-Partition -DiskNumber {int(number)} -ErrorAction SilentlyContinue | ForEach-Object {{ "
        "$v = $_ | Get-Volume -ErrorAction SilentlyContinue; "
        "[pscustomobject]@{ PartitionNumber = $_.PartitionNumber; "
        "DriveLetter = [string]$v.DriveLetter; Label = [string]$v.FileSystemLabel; FS = [string]$v.FileSystem } "
        "} | ConvertTo-Json -Compress")


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


class PhysicalDrive:
    """Minimal file-like wrapper over a PhysicalDriveN handle (write/read/seek/flush/close)."""

    def __init__(self, number: int):
        self.path = f"\\\\.\\PhysicalDrive{int(number)}"
        h = _k32.CreateFileW(self.path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             None, OPEN_EXISTING, FILE_FLAG_WRITE_THROUGH, None)
        if h == INVALID_HANDLE_VALUE or h is None:
            raise _winerr(f"open {self.path}")
        self.handle = h

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
        ret = ctypes.c_uint32(0)
        if not _k32.DeviceIoControl(self.handle, IOCTL_DISK_UPDATE_PROPERTIES, None, 0, None, 0,
                                    ctypes.byref(ret), None):
            raise _winerr("IOCTL_DISK_UPDATE_PROPERTIES")

    def close(self) -> None:
        if self.handle:
            _k32.CloseHandle(self.handle)
            self.handle = None


def open_physical_drive(number: int) -> PhysicalDrive:
    return PhysicalDrive(number)


def refresh_partitions(handle: PhysicalDrive) -> None:
    handle.refresh_partitions()


# ---------------------------------------------------------------- image streaming

def _is_xz(path) -> bool:
    with open(path, "rb") as f:
        return f.read(len(XZ_MAGIC)) == XZ_MAGIC


def iter_image(src_path, chunk: int = CHUNK):
    """Yield (data, compressed_bytes_consumed) chunks of the decompressed image (xz or raw .img)."""
    with open(src_path, "rb") as f:
        if not _is_xz(src_path):
            while True:
                data = f.read(chunk)
                if not data:
                    return
                yield data, f.tell()
            return
        dec = lzma.LZMADecompressor(format=lzma.FORMAT_XZ)
        while not dec.eof:
            raw = f.read(1024 * 1024)
            if not raw:
                raise DiskError("xz stream ended early (truncated image?)")
            out = dec.decompress(raw, max_length=chunk)
            while True:
                if out:
                    yield out, f.tell()
                if dec.eof or dec.needs_input:
                    break
                out = dec.decompress(b"", max_length=chunk)


def _open_target(target, mode: str):
    if isinstance(target, (str, bytes, os.PathLike)):
        return open(target, mode), True
    return target, False


def write_image(src_path, target, progress_cb=None, cancel_event=None, chunk: int = CHUNK) -> int:
    """Stream src_path (.img or .img.xz) to target (file path or PhysicalDrive).

    The final chunk is zero-padded to a SECTOR multiple. progress_cb(written, consumed, total)
    is called per chunk. Returns bytes written (including padding). Raises Cancelled.
    """
    total = os.path.getsize(src_path)
    out, own = _open_target(target, "wb")
    written = 0
    pending = b""
    try:
        for data, consumed in iter_image(src_path, chunk):
            if cancel_event is not None and cancel_event.is_set():
                raise Cancelled()
            data = pending + data
            cut = len(data) - len(data) % SECTOR
            pending = data[cut:]
            if cut:
                out.write(data[:cut])
                written += cut
            if progress_cb:
                progress_cb(written, consumed, total)
        if pending:
            pad = pending + b"\0" * (SECTOR - len(pending) % SECTOR)
            out.write(pad)
            written += len(pad)
            if progress_cb:
                progress_cb(written, total, total)
        out.flush()
    finally:
        if own:
            out.close()
    return written


def verify_head(src_path, target, nbytes: int = VERIFY_BYTES) -> bool:
    """Read back the first nbytes of target and compare with the image (cheap check that the write landed)."""
    inp, own = _open_target(target, "rb")
    try:
        inp.seek(0)
        # Raw disk reads must be whole sectors while xz chunks have arbitrary lengths, so read the
        # head back sector-aligned first and walk the image against it at a running offset.
        buf = _read_aligned(inp, nbytes + (-nbytes) % SECTOR)
        off = 0
        for data, _ in iter_image(src_path):
            if off >= nbytes:
                break
            data = data[:nbytes - off]
            if buf[off:off + len(data)] != data:
                return False
            off += len(data)
        return True
    finally:
        if own:
            inp.close()


def _read_aligned(inp, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        piece = inp.read(min(CHUNK, n - len(buf)))
        if not piece:
            break
        buf += piece
    return bytes(buf)
