"""player/usb.py: what a USB stick offers the player while the website cannot be reached."""
import os

from player import usb


def sticks(monkeypatch, tmp_path, layout):
    """Folders under a fake /media/projector-usb; the ones named in `layout` count as mounted."""
    root = tmp_path / "usb"
    for stick, files in layout.items():
        d = root / stick
        d.mkdir(parents=True)
        for f in files:
            (d / f).write_bytes(b"x")
    (root / "gone").mkdir(parents=True)     # left behind by a stick pulled out: not a mount
    mounted = {str(root / s) for s in layout}
    monkeypatch.setattr(usb.os.path, "ismount", lambda p: str(p) in mounted)
    return root


def test_top_folder_videos_and_pictures_by_name(monkeypatch, tmp_path):
    root = sticks(monkeypatch, tmp_path, {
        "sda1": ["b.MP4", "A.mov", "notes.txt", "._A.mov", ".hidden.mp4", "poster.JPG"],
        "sdb1": ["z.mkv"],
    })
    (root / "sda1" / "folder").mkdir()
    (root / "sda1" / "folder" / "deep.mp4").write_bytes(b"x")
    assert [p.name for p in usb.mounts(root)] == ["sda1", "sdb1"]
    got = usb.playlist(root)
    assert [(p.parent.name, p.name, o) for p, o in got] == [
        ("sda1", "A.mov", {}), ("sda1", "b.MP4", {}), ("sda1", "poster.JPG", {"image-display-duration": "10"}),
        ("sdb1", "z.mkv", {}),
    ]


def test_no_sticks_and_no_folder(tmp_path):
    assert usb.mounts(tmp_path / "missing") == [] and usb.playlist(tmp_path / "missing") == []


def test_the_udev_rule_mounts_usb_sticks_read_only():
    rule = (os.path.join(os.path.dirname(__file__), "..", "deploy", "99-projector-usb.rules"))
    text = open(rule, encoding="utf-8").read()
    assert 'ENV{ID_BUS}=="usb"' in text and "systemd-mount --no-block --collect --fsck=no --options=ro," in text
    assert "/media/projector-usb/%k" in text and usb.USB_ROOT.as_posix() == "/media/projector-usb"
