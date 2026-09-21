import re
from pathlib import Path

PLAYER = Path(r"D:/Projection Software/piplayer-audit-pi/player")
SRC = (PLAYER / "deploy" / "install-player.sh").read_text()


def test_sudoers_dropin_is_minimal_and_matches_the_daemon():
    body = SRC.split("cat > /etc/sudoers.d/projector-player <<'EOF'\n", 1)[1].split("\nEOF\n", 1)[0]
    rules = [l for l in body.splitlines() if l and not l.startswith("#")]
    cmds = set()
    for line in rules:
        m = re.fullmatch(r"projector ALL=\(ALL\) NOPASSWD: (/\S+(?: \S+)*)", line)
        assert m, line
        cmds.add(m.group(1))
    assert cmds == {
        "/sbin/reboot", "/usr/sbin/reboot",
        *(f"{b}/systemctl restart projector-{u}.service"
          for b in ("/bin", "/usr/bin") for u in ("mpv", "player", "wyze-bridge", "cloudflared")),
        "/opt/piplayer/player/deploy/update-player.sh *",
        "/usr/bin/bash /opt/piplayer/player/deploy/update-player.sh *",
        "/opt/piplayer/player/deploy/update-os.sh",
        "/usr/bin/bash /opt/piplayer/player/deploy/update-os.sh",
    }
    after = SRC.split("\nEOF\n", 1)[1] if "sudoers.d" in SRC else ""
    tail = SRC[SRC.index("cat > /etc/sudoers.d/projector-player"):]
    assert "chmod 440 /etc/sudoers.d/projector-player\nvisudo -c -f /etc/sudoers.d/projector-player" in tail
    # every sudo -n call in the daemon must hit exactly one rule (sudo matches the literal path, no canonicalising)
    daemon_calls = {
        "/sbin/reboot",
        "/bin/systemctl restart projector-mpv.service",
        "/bin/systemctl restart projector-wyze-bridge.service",
        "/bin/systemctl restart projector-cloudflared.service",
        "/opt/piplayer/player/deploy/update-player.sh main",
        "/opt/piplayer/player/deploy/update-os.sh",
    }
    for call in daemon_calls:
        assert any(re.fullmatch(re.escape(c).replace(r"\*", ".*"), call) for c in cmds), call
