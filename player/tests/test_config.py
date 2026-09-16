"""config.load: clear messages for missing/invalid config instead of tracebacks."""
import pytest

from player import config


@pytest.fixture(autouse=True)
def no_wait(monkeypatch):
    monkeypatch.setattr(config, "CONFIG_ERROR_WAIT_SECONDS", 0)
    for k in ("DEVICE_ID", "DEVICE_TOKEN", "CMS_URL", "PIPLAYER_DEVICE_ID", "PIPLAYER_DEVICE_TOKEN",
              "PIPLAYER_CMS_URL", "PIPLAYER_POLL"):
        monkeypatch.delenv(k, raising=False)


def test_valid_config(tmp_path):
    p = tmp_path / "config.toml"
    p.write_text('device_id = "lobby"\ndevice_token = "t"\ncms_url = "http://cms:8080/"\n'
                 f'media_dir = "{tmp_path.as_posix()}/m"\npoll_interval_seconds = 3\n')
    cfg = config.load(p)
    assert cfg.device_id == "lobby" and cfg.cms_url == "http://cms:8080"
    assert cfg.poll_interval_seconds == 5          # floor
    assert cfg.media_dir.as_posix() == f"{tmp_path.as_posix()}/m"
    assert cfg.verify_tls is True


def test_duplicate_key_reports_clear_error(tmp_path, capsys):
    p = tmp_path / "config.toml"
    p.write_text('device_id = "a"\ndevice_id = "b"\ndevice_token = "t"\ncms_url = "http://x"\n')
    with pytest.raises(SystemExit) as ei:
        config.load(p)
    assert ei.value.code == 2
    err = capsys.readouterr().err
    assert "not valid TOML" in err and str(p) in err
    assert "Traceback" not in err


def test_missing_config_file_reports_and_exits(tmp_path, capsys):
    with pytest.raises(SystemExit) as ei:
        config.load(tmp_path / "nope.toml")
    assert ei.value.code == 2
    err = capsys.readouterr().err
    assert "config file not found" in err and "not been configured" in err


def test_missing_keys_reports_and_exits(tmp_path, capsys):
    p = tmp_path / "config.toml"
    p.write_text('device_id = "a"\n')
    with pytest.raises(SystemExit):
        config.load(p)
    err = capsys.readouterr().err
    assert "missing required config" in err and "device_token" in err and "cms_url" in err


def test_wait_before_exit_on_missing_config(tmp_path, monkeypatch):
    slept = []
    monkeypatch.setattr(config, "CONFIG_ERROR_WAIT_SECONDS", 30)
    monkeypatch.setattr(config.time, "sleep", lambda s: slept.append(s))
    with pytest.raises(SystemExit):
        config.load(tmp_path / "nope.toml")
    assert slept == [30]


def test_env_vars_override_missing_file(tmp_path, monkeypatch):
    monkeypatch.setenv("DEVICE_ID", "e1")
    monkeypatch.setenv("DEVICE_TOKEN", "et")
    monkeypatch.setenv("CMS_URL", "http://env")
    cfg = config.load(tmp_path / "nope.toml")
    assert (cfg.device_id, cfg.device_token, cfg.cms_url) == ("e1", "et", "http://env")


def test_bad_poll_value(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("PIPLAYER_POLL", "soon")
    p = tmp_path / "config.toml"
    p.write_text('device_id = "a"\ndevice_token = "t"\ncms_url = "http://x"\n')
    with pytest.raises(SystemExit):
        config.load(p)
    assert "poll_interval_seconds" in capsys.readouterr().err


def test_wait_restores_default_signal_handlers(tmp_path, monkeypatch):
    """A SIGTERM during the wait must terminate (systemctl stop), not be swallowed."""
    monkeypatch.setattr(config, "CONFIG_ERROR_WAIT_SECONDS", 30)
    monkeypatch.setattr(config.time, "sleep", lambda s: None)
    calls = []
    monkeypatch.setattr(config.signal, "signal", lambda num, h: calls.append((num, h)))
    with pytest.raises(SystemExit):
        config.load(tmp_path / "nope.toml")
    assert (config.signal.SIGTERM, config.signal.SIG_DFL) in calls
    assert (config.signal.SIGINT, config.signal.SIG_DFL) in calls


# ----------------------------------------------------------------- [camera] ---

CAMERA_ENV = ("PIPLAYER_CAMERA_SOURCE", "PIPLAYER_CAMERA_RTSP_URL", "PIPLAYER_CAMERA_WYZE_CAMERA",
              "PIPLAYER_CAMERA_SNAPSHOT_INTERVAL", "PIPLAYER_CAMERA_LIVE_URL")


@pytest.fixture(autouse=True)
def no_camera_env(monkeypatch):
    for k in CAMERA_ENV:
        monkeypatch.delenv(k, raising=False)


def _base(tmp_path, extra=""):
    p = tmp_path / "config.toml"
    p.write_text('device_id = "a"\ndevice_token = "t"\ncms_url = "http://x"\n' + extra)
    return p


def test_camera_defaults_to_none(tmp_path):
    cfg = config.load(_base(tmp_path))
    assert cfg.camera_source == "none" and cfg.camera_rtsp_url == ""
    assert cfg.camera_snapshot_interval_seconds == 10


def test_camera_rtsp_table_and_min_interval(tmp_path):
    cfg = config.load(_base(tmp_path, '[camera]\nsource = "rtsp"\nrtsp_url = "rtsp://cam/1"\n'
                                      'snapshot_interval_seconds = 2\nlive_url = "https://live.example"\n'))
    assert cfg.camera_source == "rtsp" and cfg.camera_rtsp_url == "rtsp://cam/1"
    assert cfg.camera_snapshot_interval_seconds == 5          # floor
    assert cfg.camera_live_url == "https://live.example"


def test_camera_wyze_derives_bridge_url(tmp_path):
    cfg = config.load(_base(tmp_path, '[camera]\nsource = "wyze"\nwyze_camera = "Lobby Cam"\n'))
    assert cfg.camera_rtsp_url == "rtsp://127.0.0.1:8554/lobby-cam"
    assert cfg.camera_wyze_camera == "Lobby Cam"


def test_camera_env_overrides(tmp_path, monkeypatch):
    monkeypatch.setenv("PIPLAYER_CAMERA_SOURCE", "rtsp")
    monkeypatch.setenv("PIPLAYER_CAMERA_RTSP_URL", "rtsp://env/1")
    monkeypatch.setenv("PIPLAYER_CAMERA_SNAPSHOT_INTERVAL", "42")
    cfg = config.load(_base(tmp_path, '[camera]\nsource = "none"\n'))
    assert (cfg.camera_source, cfg.camera_rtsp_url, cfg.camera_snapshot_interval_seconds) == ("rtsp", "rtsp://env/1", 42)


@pytest.mark.parametrize("extra, text", [
    ('[camera]\nsource = "usb"\n', "source must be one of"),
    ('[camera]\nsource = "rtsp"\n', "needs rtsp_url"),
    ('[camera]\nsource = "wyze"\n', "needs wyze_camera"),
    ('[camera]\nsource = "rtsp"\nrtsp_url = "rtsp://x"\nsnapshot_interval_seconds = "soon"\n', "must be an integer"),
])
def test_camera_bad_values_report_and_exit(tmp_path, capsys, extra, text):
    with pytest.raises(SystemExit):
        config.load(_base(tmp_path, extra))
    assert text in capsys.readouterr().err
