import sys
from pathlib import Path

import pytest

# make `import player` resolve to the package in player/player regardless of cwd
PLAYER_ROOT = Path(__file__).resolve().parents[1]
if str(PLAYER_ROOT) not in sys.path:
    sys.path.insert(0, str(PLAYER_ROOT))

from player.config import PlayerConfig  # noqa: E402


@pytest.fixture
def cfg(tmp_path) -> PlayerConfig:
    media = tmp_path / "media"
    media.mkdir()
    return PlayerConfig(
        device_id="dev-1",
        device_token="tok",
        cms_url="http://cms.test",
        media_dir=media,
        manifest_path=tmp_path / "manifest.json",
        mpv_socket=tmp_path / "mpv.sock",
        poll_interval_seconds=5,
        verify_tls=True,
    )
