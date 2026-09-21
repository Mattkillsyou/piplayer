"""The flasher's ed25519 key: RFC 8032 derivation, OpenSSH file formats (checked against ssh-keygen when the
machine has it), one key per user under host.config_dir(), owner-only (icacls / 0600)."""
import base64
import shutil
import subprocess

import pytest

import sshkey
import winhost

# RFC 8032 section 7.1, test 1.
SEED = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
PUB = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
SSH_KEYGEN = shutil.which("ssh-keygen") or (r"C:\Windows\System32\OpenSSH\ssh-keygen.exe"
                                            if shutil.os.path.exists(r"C:\Windows\System32\OpenSSH\ssh-keygen.exe")
                                            else None)


def test_public_key_matches_rfc_8032():
    assert sshkey.public_key(SEED) == PUB
    # RFC 8032 test 2.
    seed2 = bytes.fromhex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
    assert sshkey.public_key(seed2).hex() == "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"


def test_read_private_round_trips(tmp_path):
    f = tmp_path / "id_ed25519"
    f.write_text(sshkey.private_file(SEED, PUB, "me@pc"))
    assert sshkey.read_private(f) == (SEED, "me@pc")
    f.write_text("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n")
    assert sshkey.read_private(f) is None
    assert sshkey.read_private(tmp_path / "missing") is None


def test_public_line_and_private_file_formats():
    line = sshkey.public_line(PUB, "me@pc")
    kind, blob, comment = line.split(" ")
    assert kind == "ssh-ed25519" and comment == "me@pc"
    raw = base64.b64decode(blob)
    assert raw == b"\0\0\0\x0bssh-ed25519\0\0\0\x20" + PUB
    text = sshkey.private_file(SEED, PUB, "me@pc")
    assert text.startswith("-----BEGIN OPENSSH PRIVATE KEY-----\n") and text.endswith("-----END OPENSSH PRIVATE KEY-----\n")
    body = base64.b64decode("".join(text.splitlines()[1:-1]))
    assert body.startswith(b"openssh-key-v1\0\0\0\0\x04none\0\0\0\x04none\0\0\0\0\0\0\0\x01")
    assert raw in body and SEED + PUB in body and b"me@pc" in body
    assert all(len(ln) <= 70 for ln in text.splitlines())
    assert "\r" not in text


def test_ensure_keypair_creates_once_and_reuses(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))  # Windows: %APPDATA%\Projection5000\ssh
    monkeypatch.setenv("HOME", str(tmp_path))  # macOS: ~/Library/Application Support/Projection5000/ssh
    icacls = []
    monkeypatch.setattr(sshkey, "restrict_acl", lambda path: icacls.append(path) or "")
    logged = []
    line = sshkey.ensure_keypair(logged.append)
    priv = sshkey.private_path()
    assert priv.is_relative_to(tmp_path) and priv.parent.name == "ssh" and priv.name == "id_ed25519"
    assert priv.is_file() and priv.with_suffix(".pub").read_text() == line + "\n"
    assert line.startswith("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI") and line.endswith("projection5000-flasher@" + __import__("socket").gethostname())
    assert icacls == [priv] and logged and "Created the SSH key" in logged[0]
    assert b"\r" not in priv.read_bytes()
    # Second call: the same key, nothing regenerated, nothing logged.
    logged.clear()
    assert sshkey.ensure_keypair(logged.append) == line and icacls == [priv] and logged == []
    # A damaged or missing .pub is derived from the private key again: the key every Pi so far trusts stays.
    before = priv.read_bytes()
    priv.with_suffix(".pub").write_text("junk\n")
    assert sshkey.ensure_keypair(logged.append) == line and priv.read_bytes() == before
    assert priv.with_suffix(".pub").read_text() == line + "\n" and "Restored id_ed25519.pub" in logged[-1]
    priv.with_suffix(".pub").unlink()
    assert sshkey.ensure_keypair() == line and priv.read_bytes() == before
    assert sshkey.read_private(priv)[1] == line.split(" ")[2]
    # An unreadable private key is set aside, never silently overwritten.
    priv.write_text("not a key\n")
    line2 = sshkey.ensure_keypair(logged.append)
    assert line2 != line and priv.with_suffix(".bak").read_text() == "not a key\n"
    assert "moved to" in logged[-2] and sshkey.read_private(priv)[0] is not None
    # An icacls warning is passed to the log, not raised.
    monkeypatch.setattr(sshkey, "restrict_acl", lambda path: "WARNING: icacls failed")
    priv.unlink()
    sshkey.ensure_keypair(logged.append)
    assert logged[-1] == "WARNING: icacls failed"


def test_restrict_acl_reports_failures(tmp_path, monkeypatch):
    """The Windows host's icacls call (runnable anywhere: subprocess is faked)."""
    f = tmp_path / "k"
    f.write_text("x")

    class R:
        returncode, stdout, stderr = 1, "", "Access is denied."

    monkeypatch.setenv("USERNAME", "matt")
    monkeypatch.setattr(winhost.subprocess, "run", lambda *a, **k: R())
    assert winhost.restrict_file(f) == f"WARNING: icacls failed on {f}: Access is denied."
    monkeypatch.setattr(winhost.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError("no icacls")))
    assert winhost.restrict_file(f).startswith("WARNING: could not restrict the ACL")
    # sshkey.restrict_acl is the host's restrict_file (icacls on Windows, 0600 on macOS).
    monkeypatch.setattr(sshkey.host, "restrict_file", lambda path: f"WARNING: nope {path}")
    assert sshkey.restrict_acl(f) == f"WARNING: nope {f}"


@pytest.mark.skipif(shutil.which("icacls") is None, reason="icacls not available")
def test_restrict_acl_leaves_only_the_user(tmp_path):
    f = tmp_path / "id_ed25519"
    f.write_text("secret")
    assert sshkey.restrict_acl(f) == ""
    out = subprocess.run(["icacls", str(f)], capture_output=True, text=True).stdout
    aces = [ln.replace(str(f), "").strip() for ln in out.splitlines() if ":(" in ln or ":F" in ln]
    assert len(aces) == 1 and aces[0].endswith(":(F)") and "Users" not in aces[0]
    assert f.read_text() == "secret"  # still readable by the owner


@pytest.mark.skipif(SSH_KEYGEN is None, reason="ssh-keygen not available")
def test_ssh_keygen_accepts_the_generated_key(tmp_path, monkeypatch):
    """OpenSSH parses the private key file and derives the same public line (ssh-keygen -y)."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path))
    line = sshkey.ensure_keypair()
    r = subprocess.run([SSH_KEYGEN, "-y", "-f", str(sshkey.private_path())], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == line
    # And the fingerprint of the .pub matches (the public file is valid on its own).
    r = subprocess.run([SSH_KEYGEN, "-l", "-f", str(sshkey.private_path().with_suffix(".pub"))],
                       capture_output=True, text=True, timeout=30)
    assert r.returncode == 0 and "(ED25519)" in r.stdout
