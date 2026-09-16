"""Camera zero-config: fetch on start and on camera_config_version change, wyze.env
write + bridge restart only when the credentials changed, capture thread re-pointed
without a daemon restart; installer's wyze.env block and unit paths."""
import dataclasses
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from fakes import FakeCms, FakeMpv, FakeResponse
from player import camera_config
from player.camera import CameraCapture
from player.daemon import PlayerState, run_cycle
from player.mpv_client import MpvClient

WYZE = {"email": "me@x.test", "password": "pw 1", "api_id": "id-1", "api_key": "key-1", "camera": "Lobby Cam"}
ENV_TEXT = "WYZE_EMAIL=me@x.test\nWYZE_PASSWORD=pw 1\nAPI_ID=id-1\nAPI_KEY=key-1\n"


class CmsWithCameraConfig(FakeCms):
    def __init__(self):
        super().__init__()
        self.camera_config = {"source": "none"}
        self.camera_config_status = 200
        self.camera_config_calls: list[dict] = []

    def install(self, monkeypatch):
        super().install(monkeypatch)
        monkeypatch.setattr(camera_config.requests, "get", self.get)

    def get(self, url, headers=None, params=None, stream=False, timeout=None, verify=True):
        if url.startswith(f"{self.base}/api/camera-config/"):
            self.camera_config_calls.append(dict(headers or {}))
            if self.camera_config_status != 200:
                return FakeResponse(self.camera_config_status, b"nope", url=url)
            return FakeResponse(200, json_body=dict(self.camera_config), url=url)
        return super().get(url, headers, params, stream, timeout, verify)


@pytest.fixture
def cms(monkeypatch):
    c = CmsWithCameraConfig()
    c.install(monkeypatch)
    return c


@pytest.fixture
def mpv(monkeypatch):
    fake = FakeMpv()
    fake.install(monkeypatch)
    return fake


@pytest.fixture
def client(cfg, mpv):
    return MpvClient(cfg.mpv_socket)


@pytest.fixture
def runs(monkeypatch):
    calls = SimpleNamespace(args=[], rc=0)

    def fake_run(cmd, **kw):
        calls.args.append(list(cmd))
        return SimpleNamespace(returncode=calls.rc, stderr="sudo: a password is required\n" if calls.rc else "")
    monkeypatch.setattr(camera_config.subprocess, "run", fake_run)
    return calls


RESTART = ["sudo", "-n", "/bin/systemctl", "restart", "projector-wyze-bridge.service"]


def test_rtsp_url_from_console_answer():
    assert camera_config.rtsp_url({"source": "none"}) == ""
    assert camera_config.rtsp_url({"source": "rtsp", "rtsp_url": "rtsp://u:p@cam/1"}) == "rtsp://u:p@cam/1"
    assert camera_config.rtsp_url({"source": "wyze", "wyze": WYZE}) == "rtsp://127.0.0.1:8554/lobby-cam"
    assert camera_config.rtsp_url({"source": "wyze", "wyze": {}}) == ""
    assert camera_config.rtsp_url({}) == ""


def test_wyze_env_written_0600_and_only_rewritten_on_change(cfg):
    p = camera_config.wyze_env_path(cfg)
    assert p == cfg.manifest_path.parent / "wyze.env"
    assert camera_config.write_wyze_env(cfg, WYZE) is True
    assert p.read_text() == ENV_TEXT
    assert camera_config.write_wyze_env(cfg, WYZE) is False
    assert camera_config.write_wyze_env(cfg, {**WYZE, "password": "new"}) is True
    assert "WYZE_PASSWORD=new\n" in p.read_text()
    assert not p.with_suffix(".env.tmp").exists()


def test_apply_wyze_restarts_bridge_only_when_credentials_change(cfg, runs):
    cam = CameraCapture(cfg)
    url = camera_config.apply(cfg, {"source": "wyze", "wyze": WYZE}, cam)
    assert url == "rtsp://127.0.0.1:8554/lobby-cam"
    assert (cam.source, cam.rtsp_url) == ("wyze", url)
    assert runs.args == [RESTART]
    # same credentials, other camera name: no restart, the URL moves
    camera_config.apply(cfg, {"source": "wyze", "wyze": {**WYZE, "camera": "Hall 2"}}, cam)
    assert cam.rtsp_url == "rtsp://127.0.0.1:8554/hall-2" and runs.args == [RESTART]
    # new password: restart
    camera_config.apply(cfg, {"source": "wyze", "wyze": {**WYZE, "password": "x"}}, cam)
    assert runs.args == [RESTART, RESTART]
    # a failing restart is reported, not raised
    runs.rc = 1
    camera_config.apply(cfg, {"source": "wyze", "wyze": {**WYZE, "password": "y"}}, cam)
    assert len(runs.args) == 3


def test_apply_rtsp_and_none(cfg, runs):
    cam = CameraCapture(cfg)
    assert camera_config.apply(cfg, {"source": "rtsp", "rtsp_url": "rtsp://cam/1"}, cam) == "rtsp://cam/1"
    assert (cam.source, cam.rtsp_url) == ("rtsp", "rtsp://cam/1")
    assert camera_config.apply(cfg, {"source": "none"}, cam) == ""
    assert (cam.source, cam.rtsp_url) == ("none", "")
    assert camera_config.apply(cfg, {"source": "weird"}, cam) == ""
    assert runs.args == [] and not camera_config.wyze_env_path(cfg).exists()


def test_console_none_keeps_config_toml_camera(cfg, runs):
    """A hand-configured [camera] in config.toml survives a console that has nothing set for the device."""
    local = dataclasses.replace(cfg, camera_source="rtsp", camera_rtsp_url="rtsp://local/1")
    cam = CameraCapture(local)
    assert camera_config.apply(local, {"source": "none"}, cam) == "rtsp://local/1"
    assert (cam.source, cam.rtsp_url) == ("rtsp", "rtsp://local/1")
    assert camera_config.apply(local, {"source": "rtsp", "rtsp_url": "rtsp://console/2"}, cam) == "rtsp://console/2"


def test_capture_idles_without_a_url(cfg, runs):
    cam = CameraCapture(cfg)
    assert cam.rtsp_url == "" and cam.capture_once() is False and cam.error == ""
    cam.error = "old"
    cam.set_source("none", "")           # unchanged: nothing logged, error kept
    assert cam.error == "old"
    cam.set_source("rtsp", "rtsp://x")   # a new source starts with a clean slate
    assert cam.error == ""


def test_daemon_fetches_on_start_and_on_version_change(cfg, cms, mpv, client, runs):
    cam = CameraCapture(cfg)
    state = PlayerState(backoff=5)
    # no key in the manifest: feature off, nothing fetched
    run_cycle(cfg, client, state, camera=cam)
    assert cms.camera_config_calls == [] and state.camera_config_version is None

    cms.manifest["camera_config_version"] = 3
    cms.camera_config = {"source": "wyze", "wyze": WYZE}
    run_cycle(cfg, client, state, camera=cam)
    assert len(cms.camera_config_calls) == 1
    assert cms.camera_config_calls[0]["Authorization"] == "Bearer tok"
    assert state.camera_config_version == 3
    assert cam.rtsp_url == "rtsp://127.0.0.1:8554/lobby-cam"
    assert camera_config.wyze_env_path(cfg).read_text() == ENV_TEXT
    assert runs.args == [RESTART]

    # same version: no refetch
    run_cycle(cfg, client, state, camera=cam)
    assert len(cms.camera_config_calls) == 1

    # bumped version, same credentials, camera switched off on the console: no restart, capture idles
    cms.manifest["camera_config_version"] = 4
    cms.camera_config = {"source": "none"}
    run_cycle(cfg, client, state, camera=cam)
    assert len(cms.camera_config_calls) == 2 and state.camera_config_version == 4
    assert (cam.source, cam.rtsp_url) == ("none", "") and runs.args == [RESTART]

    # a fresh daemon (state None) fetches on its first manifest even at a known version
    fresh = PlayerState(backoff=5)
    run_cycle(cfg, client, fresh, camera=cam)
    assert len(cms.camera_config_calls) == 3 and fresh.camera_config_version == 4


def test_fetch_failure_is_retried_next_cycle(cfg, cms, mpv, client, runs):
    cam = CameraCapture(cfg)
    state = PlayerState(backoff=5)
    cms.manifest["camera_config_version"] = 1
    cms.camera_config_status = 500
    assert run_cycle(cfg, client, state, camera=cam) is not None
    assert state.camera_config_version is None and len(cms.camera_config_calls) == 1
    cms.camera_config_status = 200
    cms.camera_config = {"source": "rtsp", "rtsp_url": "rtsp://cam/9"}
    run_cycle(cfg, client, state, camera=cam)
    assert state.camera_config_version == 1 and cam.rtsp_url == "rtsp://cam/9"
    # a bogus version value is ignored
    cms.manifest["camera_config_version"] = "two"
    run_cycle(cfg, client, state, camera=cam)
    assert len(cms.camera_config_calls) == 2


def test_slow_bridge_restart_does_not_kill_the_cycle(cfg, cms, mpv, client, monkeypatch):
    """First boot: the unit's ExecStartPre docker pull can outlast the 30 s restart budget."""
    def slow_run(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
    monkeypatch.setattr(camera_config.subprocess, "run", slow_run)
    cam = CameraCapture(cfg)
    state = PlayerState(backoff=5)
    cms.manifest["camera_config_version"] = 1
    cms.camera_config = {"source": "wyze", "wyze": WYZE}
    assert run_cycle(cfg, client, state, camera=cam) is not None
    assert state.camera_config_version is None            # retried next cycle
    assert cam.error.startswith("camera config: ")
    assert camera_config.wyze_env_path(cfg).read_text() == ENV_TEXT


# ------------------------------------------------------ deploy files ---

DEPLOY = Path(__file__).resolve().parents[1] / "deploy"


def test_bridge_unit_reads_the_data_dir_env_file_and_tolerates_its_absence():
    unit = (DEPLOY / "projector-wyze-bridge.service").read_text()
    assert "--env-file /var/lib/projector-player/wyze.env" in unit
    assert "ConditionPathExists=/var/lib/projector-player/wyze.env" in unit
    assert "/etc/projector-player/wyze.env" not in unit
    installer = (DEPLOY / "install-player.sh").read_text()
    assert "NOPASSWD: /bin/systemctl restart projector-wyze-bridge.service" in installer
    assert "NOPASSWD: /usr/bin/systemctl restart projector-wyze-bridge.service" in installer


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash not available")
@pytest.mark.parametrize("case", ["vars", "legacy", "nothing"])
def test_installer_wyze_env_block(tmp_path, case):
    """The --with-wyze block: WYZE_* vars write the file, an old /etc copy is moved, else nothing is written."""
    src = (DEPLOY / "install-player.sh").read_text()
    block = src[src.index('    WYZE_ENV="${DATA_DIR}/wyze.env"'):src.index('echo "==> Installing systemd units"')]
    block = block[:block.rindex("fi")]          # drop the closing fi of the surrounding if
    data, etc = tmp_path / "data", tmp_path / "etc"
    data.mkdir(), etc.mkdir()

    def posix(p):
        return str(p).replace("\\", "/").replace("C:", "/c").replace("D:", "/d")
    env = {"DATA_DIR": posix(data), "ETC_DIR": posix(etc), "USER_NAME": "nobody"}
    if case == "vars":
        env.update(WYZE_EMAIL="me@x.test", WYZE_PASSWORD="pw 1", WYZE_API_ID="id-1", WYZE_API_KEY="key-1")
    elif case == "legacy":
        (etc / "wyze.env").write_text(ENV_TEXT)
    prelude = "set -euo pipefail\n" + "".join(f'{k}="{v}"\n' for k, v in env.items()) + "chown() { :; }\n"
    res = subprocess.run(["bash", "-c", prelude + block], capture_output=True, text=True)
    assert res.returncode == 0, res.stderr
    if case == "nothing":
        assert not (data / "wyze.env").exists() and "fetches them from the console" in res.stdout
    else:
        assert (data / "wyze.env").read_text() == ENV_TEXT
        assert not (etc / "wyze.env").exists()
