"""pi_info: the board string and the camera rule (arm64 userland + enough
RAM), probed once and sent as sync params next to player_version."""
import pytest

from fakes import FakeCms
from player import pi_info
from player.sync import sync_once

MEMINFO_4G = "MemTotal:        3885000 kB\nMemFree:         3000000 kB\n"
MEMINFO_1G = "MemTotal:         935000 kB\nMemFree:          500000 kB\n"
MEMINFO_512M = "MemTotal:         430000 kB\n"


@pytest.fixture
def cms(monkeypatch):
    c = FakeCms()
    c.install(monkeypatch)
    return c


@pytest.fixture(autouse=True)
def fresh_probe():
    pi_info.sync_params.cache_clear()
    yield
    pi_info.sync_params.cache_clear()


def test_pi_model_strips_the_nul_and_caps_at_64(tmp_path):
    model = tmp_path / "model"
    model.write_bytes(b"Raspberry Pi 4 Model B Rev 1.5\0")
    assert pi_info.pi_model(model) == "Raspberry Pi 4 Model B Rev 1.5"
    model.write_bytes(b"X" * 100 + b"\0")
    assert pi_info.pi_model(model) == "X" * 64
    assert pi_info.pi_model(tmp_path / "missing") == ""            # a PC / the tests


def test_mem_total_kb(tmp_path):
    meminfo = tmp_path / "meminfo"
    meminfo.write_text(MEMINFO_4G)
    assert pi_info.mem_total_kb(meminfo) == 3885000
    meminfo.write_text("MemTotal: junk kB\n")
    assert pi_info.mem_total_kb(meminfo) == 0
    assert pi_info.mem_total_kb(tmp_path / "missing") == 0


def test_camera_rule_matches_the_installer(tmp_path):
    meminfo = tmp_path / "meminfo"
    meminfo.write_text(MEMINFO_1G)
    kb = pi_info.mem_total_kb(meminfo)
    assert pi_info.camera_supported("aarch64", True, 3885000)          # Pi 4 / 5
    assert pi_info.camera_supported("aarch64", True, kb)               # Pi 3, 1 GB (default gpu_mem)
    assert not pi_info.camera_supported("aarch64", True, 430000)       # Zero 2 W: 512 MB
    assert not pi_info.camera_supported("armv7l", False, 935000)       # Pi 2 v1.1, 32-bit image
    assert not pi_info.camera_supported("armv6l", False, 430000)       # Zero / Pi 1
    assert not pi_info.camera_supported("aarch64", False, 3885000)     # Pi 4 on the 32-bit image: 64-bit kernel, armhf userland
    assert pi_info.CAMERA_MIN_MEM_KB == 900_000


def test_sync_params_are_probed_once_and_sent(cfg, cms, monkeypatch, tmp_path):
    model = tmp_path / "model"
    model.write_bytes(b"Raspberry Pi 3 Model B Plus Rev 1.3\0")
    meminfo = tmp_path / "meminfo"
    meminfo.write_text(MEMINFO_1G)
    monkeypatch.setattr(pi_info, "MODEL_PATH", model)
    monkeypatch.setattr(pi_info, "MEMINFO_PATH", meminfo)
    monkeypatch.setattr(pi_info.platform, "machine", lambda: "aarch64")
    monkeypatch.setattr(pi_info.sys, "maxsize", 2 ** 63 - 1)
    sync_once(cfg)
    assert cms.sync_calls[-1]["pi_model"] == "Raspberry Pi 3 Model B Plus Rev 1.3"
    assert cms.sync_calls[-1]["camera_supported"] == "1"
    assert cms.sync_calls[-1]["player_version"] == "0.2.0"
    # probed once per process: a changed file is not re-read
    model.write_bytes(b"other\0")
    sync_once(cfg)
    assert cms.sync_calls[-1]["pi_model"] == "Raspberry Pi 3 Model B Plus Rev 1.3"


def test_sync_params_off_a_pi(cfg, cms, monkeypatch, tmp_path):
    monkeypatch.setattr(pi_info, "MODEL_PATH", tmp_path / "missing")
    monkeypatch.setattr(pi_info, "MEMINFO_PATH", tmp_path / "missing")
    sync_once(cfg)
    assert cms.sync_calls[-1]["pi_model"] == "" and cms.sync_calls[-1]["camera_supported"] == "0"
