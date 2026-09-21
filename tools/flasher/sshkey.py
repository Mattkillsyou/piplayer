"""One ed25519 SSH keypair per user for the flasher (host.config_dir()/ssh/id_ed25519:
%APPDATA%\\Projection5000\\ssh on Windows, ~/Library/Application Support/Projection5000/ssh on macOS).

Pure Python (RFC 8032 key derivation, OpenSSH key file formats), no third-party package and no ssh-keygen:
`cryptography` would make the build depend on a native wheel the build machine may not have, and Windows' OpenSSH
client is an optional feature that can be removed, so ssh-keygen could only be a second generator beside a
pure-Python fallback. Key generation from a 32-byte seed is ~40 lines of arithmetic; the tests check it against
an RFC 8032 vector and against ssh-keygen -y / -l when present.

The private key is a plain OpenSSH file (ssh must read it, so DPAPI is out) made owner-only by the host (icacls
on Windows, 0600 on macOS), which is what ssh demands before it uses a key ("UNPROTECTED PRIVATE KEY FILE").
"""
import base64
import hashlib
import secrets
import socket
import struct
from pathlib import Path

from sysplat import host

KEY_NAME = "id_ed25519"
KEY_TYPE = b"ssh-ed25519"

# Edwards25519 (RFC 8032 section 5.1), affine coordinates: slow but tiny, one scalar multiplication per key.
_P = 2 ** 255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P
_B = (15112221349535400772501151409588531511454012693041857206046113283949847762202,
      46316835694926478169428394003475163141307993866256225615783033603165251855960)


def _add(p, q):
    x1, y1 = p
    x2, y2 = q
    t = _D * x1 * x2 * y1 * y2
    x3 = (x1 * y2 + x2 * y1) * pow(1 + t, _P - 2, _P)
    y3 = (y1 * y2 + x1 * x2) * pow(1 - t, _P - 2, _P)
    return x3 % _P, y3 % _P


def _mul(p, n):
    q = (0, 1)
    while n:
        if n & 1:
            q = _add(q, p)
        p = _add(p, p)
        n >>= 1
    return q


def public_key(seed: bytes) -> bytes:
    """32-byte ed25519 public key for a 32-byte seed (RFC 8032 section 5.1.5)."""
    h = hashlib.sha512(seed).digest()
    a = int.from_bytes(h[:32], "little")
    a = (a & ((1 << 254) - 8)) | (1 << 254)
    x, y = _mul(_B, a)
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def _s(b: bytes) -> bytes:
    return struct.pack(">I", len(b)) + b


def public_line(pub: bytes, comment: str) -> str:
    """The authorized_keys / id_ed25519.pub line."""
    return f"ssh-ed25519 {base64.b64encode(_s(KEY_TYPE) + _s(pub)).decode()} {comment}"


def private_file(seed: bytes, pub: bytes, comment: str) -> str:
    """Unencrypted openssh-key-v1 file (what ssh-keygen -t ed25519 -N '' writes)."""
    check = secrets.token_bytes(4)
    private = check + check + _s(KEY_TYPE) + _s(pub) + _s(seed + pub) + _s(comment.encode())
    private += bytes(range(1, 8 - (len(private) % 8) + 1)) if len(private) % 8 else b""
    blob = (b"openssh-key-v1\0" + _s(b"none") + _s(b"none") + _s(b"") + struct.pack(">I", 1)
            + _s(_s(KEY_TYPE) + _s(pub)) + _s(private))
    b64 = base64.b64encode(blob).decode()
    lines = [b64[i:i + 70] for i in range(0, len(b64), 70)]
    return "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "\n".join(lines) + "\n-----END OPENSSH PRIVATE KEY-----\n"


def key_dir() -> Path:
    return host.config_dir() / "ssh"


def private_path() -> Path:
    return key_dir() / KEY_NAME


def restrict_acl(path: Path) -> str:
    """Owner-only (icacls on Windows, chmod 0600 on macOS). Returns '' or a warning; a failure is not fatal
    (ssh then says which file to fix)."""
    return host.restrict_file(path)


def ensure_keypair(log=None) -> str:
    """Create key_dir()/id_ed25519(.pub) on first use; returns the public key line."""
    priv, pub_path = private_path(), private_path().with_suffix(".pub")
    if priv.is_file() and pub_path.is_file():
        line = pub_path.read_text("utf-8").strip()
        if line.startswith("ssh-ed25519 "):
            return line
    seed = secrets.token_bytes(32)
    pub = public_key(seed)
    comment = f"projection5000-flasher@{socket.gethostname()}"
    priv.parent.mkdir(parents=True, exist_ok=True)
    priv.write_bytes(private_file(seed, pub, comment).encode())  # LF, as ssh-keygen writes it
    warning = restrict_acl(priv)
    line = public_line(pub, comment)
    pub_path.write_text(line + "\n", "utf-8")
    if log:
        log(f"Created the SSH key {priv} (installed on every card from now on).")
        if warning:
            log(warning)
    return line
