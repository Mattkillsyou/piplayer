import hashlib
import lzma
import os

import pytest

import bundle
import windisk

IMG_SIZE = 3 * 1024 * 1024 + 100  # not a sector multiple, like the real image


@pytest.fixture(scope="module")
def fake_exe(tmp_path_factory):
    """A 1 MiB fake exe with a synthetic 3 MiB .img.xz appended. Returns (exe, original bytes, raw image, xz)."""
    d = tmp_path_factory.mktemp("bundle")
    original = os.urandom(1024 * 1024)
    exe = d / "fake.exe"
    exe.write_bytes(original)
    raw = bytearray((bytes(range(256)) * 16) * (IMG_SIZE // 4096 + 1))[:IMG_SIZE]
    for i in range(0, IMG_SIZE, 4099):
        raw[i] = (i * 7) & 0xFF
    raw = bytes(raw)
    xz = d / "fake.img.xz"
    xz.write_bytes(lzma.compress(raw, format=lzma.FORMAT_XZ))
    b = bundle.append_bundle(exe, xz, "fake-os-lite.img.xz")
    assert b.length == xz.stat().st_size and b.offset == len(original)
    return exe, original, raw, xz


def test_find_bundle_round_trip(fake_exe):
    exe, original, raw, xz = fake_exe
    b = bundle.find_bundle(exe)
    assert b is not None
    assert (b.name, b.offset, b.length) == ("fake-os-lite.img.xz", len(original), xz.stat().st_size)
    assert b.sha256 == hashlib.sha256(xz.read_bytes()).hexdigest()
    assert exe.stat().st_size == len(original) + b.length + bundle.TRAILER_SIZE
    assert exe.read_bytes()[:len(original)] == original  # the exe itself is untouched
    assert exe.read_bytes()[-8:] == bundle.TRAILER_MAGIC


def test_find_bundle_without_path_needs_frozen(fake_exe, monkeypatch):
    exe = fake_exe[0]
    monkeypatch.setattr(bundle.sys, "executable", str(exe))
    monkeypatch.delattr(bundle.sys, "frozen", raising=False)
    assert bundle.find_bundle() is None
    monkeypatch.setattr(bundle.sys, "frozen", True, raising=False)
    assert bundle.find_bundle().name == "fake-os-lite.img.xz"


def test_slice_reader_bounds_and_seeks(fake_exe):
    exe, original, raw, xz = fake_exe
    data = xz.read_bytes()
    with bundle.find_bundle(exe).open() as f:
        assert f.size == len(data) and f.readable() and f.seekable()
        assert f.read(10) == data[:10] and f.tell() == 10
        assert f.read() == data[10:] and f.tell() == len(data)
        assert f.read() == b"" and f.read(5) == b""
        assert f.seek(-12, os.SEEK_END) == len(data) - 12
        assert f.read(100) == data[-12:]  # never past the slice, into the trailer
        f.seek(0)
        f.seek(7, os.SEEK_CUR)
        assert f.read(3) == data[7:10]
        assert f.seek(len(data) + 50) == len(data) + 50 and f.read(1) == b""
        with pytest.raises(ValueError):
            f.seek(-1)
        assert f.read(-1) == b""
        f.seek(0)
        assert f.read(-1) == data


def test_double_append_refused(fake_exe, tmp_path):
    exe, _, _, xz = fake_exe
    with pytest.raises(bundle.BundleError, match="already"):
        bundle.append_bundle(exe, xz, "again.img.xz")
    plain = tmp_path / "plain.exe"
    plain.write_bytes(b"x" * 100)
    with pytest.raises(bundle.BundleError, match="name"):
        bundle.append_bundle(plain, xz, "n" * 129)
    assert plain.read_bytes() == b"x" * 100


def test_strip_bundle_restores_original(fake_exe, tmp_path):
    exe, original, _, xz = fake_exe
    copy = tmp_path / "copy.exe"
    copy.write_bytes(exe.read_bytes())
    assert bundle.strip_bundle(copy) is True
    assert copy.read_bytes() == original
    assert bundle.find_bundle(copy) is None
    assert bundle.strip_bundle(copy) is False
    # and it can be bundled again
    assert bundle.append_bundle(copy, xz, "second.img.xz").name == "second.img.xz"
    assert bundle.find_bundle(copy).name == "second.img.xz"


def test_corrupt_trailer_returns_none(fake_exe, tmp_path):
    exe, original, _, _ = fake_exe
    data = exe.read_bytes()
    bad = tmp_path / "bad.exe"
    bad.write_bytes(data[:-8] + b"XXXXXXXX")
    assert bundle.find_bundle(bad) is None
    bad.write_bytes(data[:-1])  # truncated by one byte: magic is gone
    assert bundle.find_bundle(bad) is None
    # Bounds: an offset/length that reach past the file are refused even with a good magic.
    trailer = bytearray(data[-bundle.TRAILER_SIZE:])
    trailer[192:200] = (len(data)).to_bytes(8, "little")  # length field
    bad.write_bytes(data[:-bundle.TRAILER_SIZE] + bytes(trailer))
    assert bundle.find_bundle(bad) is None
    trailer[192:200] = bytes(8)  # zero length: an empty image is not a bundle
    bad.write_bytes(data[:-bundle.TRAILER_SIZE] + bytes(trailer))
    assert bundle.find_bundle(bad) is None
    empty = tmp_path / "empty.img.xz"
    empty.write_bytes(b"")
    plain = tmp_path / "plain.exe"
    plain.write_bytes(original)
    with pytest.raises(bundle.BundleError):
        bundle.append_bundle(plain, empty, "empty.img.xz")
    assert plain.read_bytes() == original
    short = tmp_path / "short.exe"
    short.write_bytes(b"abc")
    assert bundle.find_bundle(short) is None
    assert bundle.find_bundle(tmp_path / "missing.exe") is None


def test_windisk_reads_the_bundled_image(fake_exe, tmp_path):
    exe, original, raw, xz = fake_exe
    b = bundle.find_bundle(exe)
    windisk.check_image_magic(b)
    assert windisk.source_name(b) == "fake-os-lite.img.xz"
    assert windisk.source_size(b) == xz.stat().st_size
    assert windisk.image_size(b) == len(raw) == windisk.image_size(str(xz))
    assert b"".join(d for d, _ in windisk.iter_image(b, chunk=256 * 1024)) == raw
    target = tmp_path / "card.bin"
    written = windisk.write_image(b, str(target), chunk=256 * 1024, expected_sha256=b.sha256)
    out = target.read_bytes()
    assert written == len(out) and len(out) % 512 == 0
    assert out[:len(raw)] == raw and out[len(raw):] == b"\0" * (len(out) - len(raw))
    assert windisk.verify_image(b, str(target))
    assert windisk.verify_head(b, str(target))
    with open(target, "r+b") as f:
        f.seek(len(raw) - 5)
        f.write(b"\xff")
    assert not windisk.verify_image(b, str(target))
    with pytest.raises(windisk.DiskError, match="sha256"):
        windisk.write_image(b, str(target), expected_sha256="0" * 64)


def test_bundled_raw_img_and_padding_streams(tmp_path):
    # A raw .img bundle and a two-stream xz with padding: the slice must behave exactly like the file did.
    exe = tmp_path / "e.exe"
    exe.write_bytes(b"E" * 4096)
    raw = os.urandom(70000)
    rawfile = tmp_path / "r.img"
    rawfile.write_bytes(raw)
    b = bundle.append_bundle(exe, rawfile, "r.img")
    assert windisk.image_size(b) == 70000
    assert b"".join(d for d, _ in windisk.iter_image(b, chunk=4096)) == raw
    a, c = os.urandom(30000), b"\x11" * 40000
    xz = tmp_path / "two.img.xz"
    xz.write_bytes(lzma.compress(a, format=lzma.FORMAT_XZ) + b"\0" * 8 + lzma.compress(c, format=lzma.FORMAT_XZ)
                   + b"\0" * 4)
    exe2 = tmp_path / "e2.exe"
    exe2.write_bytes(b"F" * 999)
    b2 = bundle.append_bundle(exe2, xz, "two.img.xz")
    assert windisk.image_size(b2) == 70000
    assert b"".join(d for d, _ in windisk.iter_image(b2, chunk=4096)) == a + c
