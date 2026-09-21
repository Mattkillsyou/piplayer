import logging, sys
sys.path.insert(0, ".")
from types import SimpleNamespace
from pathlib import Path
import tempfile
from player import camera_config
from player.camera import CameraCapture
from player.config import PlayerConfig

d = Path(tempfile.mkdtemp())
cfg = PlayerConfig(cms_url="http://x", device_id="lobby", device_token="t", media_dir=d/"m", manifest_path=d/"manifest.json", mpv_socket=str(d/"s"), poll_interval_seconds=30, verify_tls=True)
def fake_run(cmd, **kw):
    return SimpleNamespace(returncode=5, stderr="Failed to restart projector-wyze-bridge.service: Unit projector-wyze-bridge.service not found.\n")
camera_config.subprocess.run = fake_run
records = []
class H(logging.Handler):
    def emit(self, r): records.append((r.levelname, r.getMessage()))
logging.getLogger("piplayer.camera_config").addHandler(H()); logging.getLogger("piplayer.camera_config").setLevel(logging.DEBUG)
cam = CameraCapture(cfg)
state = SimpleNamespace(camera_config_version=None)
camera_config.fetch = lambda cfg: {"source": "wyze", "wyze": {"email": "a", "password": "b", "api_id": "c", "api_key": "d", "camera": "Lobby Cam"}}
print("applied:", camera_config.maybe_apply(cfg, {"camera_config_version": 3}, cam, state))
print("state version:", state.camera_config_version)
print("cam:", cam.source, cam.rtsp_url, repr(cam.error))
for r in records: print(r)
