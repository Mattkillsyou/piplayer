"""updater.py without a network: the version comparison, the weekly clock, the state file, what /api/flasher/latest
has to answer, and the download (a local http.server for the streaming, the allow-list on its own so no test
needs a real https host)."""
import http.client
import http.server
import io
import subprocess
import sys
import threading
import urllib.request
import urllib.response
from pathlib import Path

import pytest

import console
import updater
from test_console import _serve

CONSOLE = "https://projectors.example"
ASSET = "https://github.com/Mattkillsyou/piplayer/releases/download/v0.7.3/Projection5000-SD-Flasher-Setup.exe"
# Where github.com sends ASSET (the shape of a real answer; the signature parts are made up).
GITHUB_CDN = ("https://release-assets.githubusercontent.com/github-production-release-asset/1041234567/"
              "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b?sp=r&sv=2018-11-09&sr=b&spr=https&se=2026-09-27T18%3A00%3A00Z"
              "&rscd=attachment%3B+filename%3DProjection5000-SD-Flasher-Setup.exe&rsct=application%2Foctet-stream"
              "&sig=abc%3D&jwt=eyJ0eXAi.eyJpc3Mi.c2ln")
LATEST = {"version": "0.7.3", "name": "Axolotl", "windows": ASSET, "mac_arm64": "https://github.com/x/a.dmg",
          "mac_intel": "https://github.com/x/i.dmg", "notes": "https://github.com/x/releases/tag/v0.7.3"}
BODY = b"MZ" + b"x" * 4094  # 4 KiB standing in for a 531 MB installer


class Assets(http.server.BaseHTTPRequestHandler):
    """The release assets: /ok is whole, /short announces more than it sends, /small and /huge announce a size
    that is not an installer, /hop redirects to /ok once."""

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/hop":
            self.send_response(302)
            self.send_header("Location", "/ok")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        length = {"/small": 10, "/huge": 3 * 1024 ** 3}.get(self.path, len(BODY))
        self.send_response(200)
        self.send_header("Content-Length", str(length))
        self.end_headers()
        if self.path in ("/small", "/huge"):
            return  # the size is refused before a byte is read
        self.wfile.write(BODY[:-100] if self.path == "/short" else BODY)


@pytest.fixture
def assets(monkeypatch):
    """The local server, with the https/host rule stood down (test_refuses_* drives the real rule): the
    streaming, the Content-Length checks and the redirect following are the real ones."""
    monkeypatch.setattr(updater, "_check", lambda url, console_url: None)
    monkeypatch.setattr(updater, "MIN_BYTES", 1024)
    srv, base = _serve(Assets)
    try:
        yield base
    finally:
        srv.shutdown()


# ----- versions

def test_newer_compares_numbers_not_strings():
    assert updater.newer("0.7.10", "0.7.2")  # the string compare says 0.7.10 < 0.7.2
    assert updater.newer("0.10.0", "0.9.0")
    assert updater.newer("1.0.0", "0.99.9")
    assert not updater.newer("0.7.2", "0.7.10")
    assert not updater.newer("0.7.2", "0.7.2")
    assert not updater.newer("banana", "0.7.2") and not updater.newer("0.7.2", "banana")
    assert not updater.newer("", "0.7.2") and not updater.newer("0.7.2-beta", "0.7.2")


# ----- the weekly clock and the state file

def test_due_after_a_week():
    now = 1_000_000.0
    assert updater.due({}, now)  # never checked
    assert updater.due({"last_check": now - 8 * 86400}, now)
    assert not updater.due({"last_check": now - 6 * 86400}, now)
    assert updater.due({"last_check": "rubbish"}, now)  # a hand-edited file checks again
    assert not updater.due({"last_check": now}, now)


def test_state_round_trip(tmp_path):
    assert updater.state_path().is_relative_to(tmp_path)  # the conftest sandbox, never the real profile
    assert updater.load_state() == {}
    updater.save_state({"last_check": 123.0, "last_seen_version": "0.7.3", "downloaded": "C:/x.exe",
                        "downloaded_version": "0.7.3", "junk": "no"})
    assert updater.load_state() == {"last_check": 123.0, "last_seen_version": "0.7.3", "downloaded": "C:/x.exe",
                                    "downloaded_version": "0.7.3"}
    updater.state_path().write_text("not json", "utf-8")
    assert updater.load_state() == {}


# ----- what the console answers

def test_latest_parses_the_documented_answer(monkeypatch):
    seen = {}

    def request(base, path, body=None, headers=None, timeout=None):
        seen.update(base=base, path=path, body=body, headers=headers, timeout=timeout)
        return dict(LATEST)

    monkeypatch.setattr(console, "_request", request)
    assert updater.latest(CONSOLE + "/") == LATEST
    assert seen["path"] == "/api/flasher/latest" and seen["base"] == CONSOLE
    assert seen["body"] is None and seen["headers"] is None  # a GET, no sign-in
    assert seen["timeout"] == updater.TIMEOUT < console.TIMEOUT


@pytest.mark.parametrize("answer", [{}, {"version": ""}, {"version": "latest"}, {"version": None},
                                    {"windows": ASSET}])
def test_latest_rejects_anything_else(monkeypatch, answer):
    monkeypatch.setattr(console, "_request", lambda *a, **k: dict(answer))
    with pytest.raises(console.ConsoleError, match="no version"):
        updater.latest(CONSOLE)


# ----- the allow-list

@pytest.mark.parametrize("url", ["http://projectors.example/x.exe", "ftp://github.com/x.exe", "",
                                 "https://evil.example/x.exe", "https://github.com.evil.example/x.exe",
                                 "https://raw.githubusercontent.com/x.exe"])
def test_refuses_anything_but_https_on_the_console_or_github(url):
    with pytest.raises(console.ConsoleError, match="refusing|unexpected address"):
        updater._check(url, CONSOLE)


def test_a_refused_host_is_said_plainly():
    """The owner reads this in the log as "Update download failed: ..."."""
    with pytest.raises(console.ConsoleError) as e:
        updater._check("https://evil.example/x.exe", CONSOLE)
    assert str(e.value) == "the download was refused because it came from an unexpected address (evil.example)"


@pytest.mark.parametrize("url", [ASSET, "https://objects.githubusercontent.com/x.exe", GITHUB_CDN,
                                 "https://projectors.example/download/x.exe"])
def test_allows_the_console_and_github(url):
    updater._check(url, CONSOLE)


def test_redirects_stay_on_the_allow_list():
    h = updater._Redirect(CONSOLE)
    assert h.max_redirections == 5
    req = urllib.request.Request(ASSET)
    hop = h.redirect_request(req, None, 302, "Found", {}, "https://objects.githubusercontent.com/a.exe")
    assert hop.full_url == "https://objects.githubusercontent.com/a.exe"
    with pytest.raises(console.ConsoleError, match="unexpected address"):
        h.redirect_request(req, None, 302, "Found", {}, "https://evil.example/a.exe")


class FakeGitHub(urllib.request.HTTPSHandler):
    """https:// answered in memory, exactly as GitHub answered for the v0.7.4 installer (checked with curl on
    27 Sep 2026): the release URL 302s to release-assets.githubusercontent.com, which serves the file."""

    def https_open(self, req):
        if req.full_url == ASSET:
            return self._answer(req, 302, "Found", {"Location": GITHUB_CDN, "Content-Length": "0"}, b"")
        if req.full_url == GITHUB_CDN:
            return self._answer(req, 200, "OK", {"Content-Length": str(len(BODY))}, BODY)
        raise AssertionError(f"fetched {req.full_url}")

    @staticmethod
    def _answer(req, code, msg, headers, body):
        m = http.client.HTTPMessage()
        for k, v in headers.items():
            m[k] = v
        r = urllib.response.addinfourl(io.BytesIO(body), m, req.full_url, code)
        r.msg = msg
        return r


def test_an_update_follows_githubs_real_redirect(monkeypatch, tmp_path):
    """The real allow-list and redirect handler, GitHub's real hop, no network. If GitHub moves its asset store
    again, this is the test to update (with GITHUB_HOSTS): 0.7.3 and 0.7.4 failed every download silently."""
    monkeypatch.setattr(updater.urllib.request, "HTTPSHandler", FakeGitHub)
    monkeypatch.setattr(updater, "MIN_BYTES", 1024)
    assert updater.download(ASSET, tmp_path / "setup.exe", CONSOLE).read_bytes() == BODY


# ----- the download

def test_download_renames_the_part_file_when_it_is_whole(assets, tmp_path):
    seen = []
    dest = updater.download(assets + "/ok", tmp_path / "setup.exe", CONSOLE,
                            progress=lambda done, total: seen.append((done, total)))
    assert dest.read_bytes() == BODY and seen[-1] == (len(BODY), len(BODY))
    assert not (tmp_path / "setup.exe.part").exists()


def test_download_follows_one_hop(assets, tmp_path):
    assert updater.download(assets + "/hop", tmp_path / "setup.exe", CONSOLE).read_bytes() == BODY


def test_a_short_download_leaves_nothing(assets, tmp_path):
    with pytest.raises(console.ConsoleError, match="truncated"):
        updater.download(assets + "/short", tmp_path / "setup.exe", CONSOLE)
    assert not (tmp_path / "setup.exe").exists() and not (tmp_path / "setup.exe.part").exists()


def test_a_cancelled_download_leaves_nothing(assets, tmp_path):
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(console.ConsoleError, match="cancelled"):
        updater.download(assets + "/ok", tmp_path / "setup.exe", CONSOLE, cancel=cancel)
    assert not (tmp_path / "setup.exe").exists() and not (tmp_path / "setup.exe.part").exists()


@pytest.mark.parametrize("path", ["/small", "/huge"])
def test_a_size_that_is_not_an_installer_is_refused(monkeypatch, path, tmp_path):
    monkeypatch.setattr(updater, "_check", lambda url, console_url: None)
    srv, base = _serve(Assets)
    try:
        with pytest.raises(console.ConsoleError, match="not an installer"):
            updater.download(base + path, tmp_path / "setup.exe", CONSOLE)
    finally:
        srv.shutdown()
    assert not (tmp_path / "setup.exe.part").exists()


def test_download_refuses_a_url_outside_the_allow_list(tmp_path):
    for url in ("http://projectors.example/x.exe", "https://evil.example/x.exe"):
        with pytest.raises(console.ConsoleError, match="refusing|unexpected address"):
            updater.download(url, tmp_path / "setup.exe", CONSOLE)
    assert list(tmp_path.iterdir()) == [updater.updates_dir()]  # nothing written but the (empty) sandbox folder
    assert not list(updater.updates_dir().iterdir())


def test_download_path_is_the_admin_only_updates_folder_and_keeps_one_installer(tmp_path):
    p = updater.download_path(ASSET)
    assert p.is_relative_to(tmp_path) and p.parent == updater.updates_dir()  # sandboxed ProgramData
    assert p.name == "Projection5000-SD-Flasher-Setup.exe"
    # The name of the URL only: nothing can be written outside that folder.
    assert updater.download_path("https://github.com/x/../../etc/passwd").parent == p.parent
    # Half a gigabyte each: what the last update left goes once the new one has landed whole, not before.
    old = p.parent / "Projection5000-SD-Flasher-Setup-0.7.2.exe"
    old.write_bytes(b"old")
    p.write_bytes(b"new")
    updater.prune(p)
    assert list(p.parent.iterdir()) == [p]
    # An installer the state file points at is only run from that folder.
    assert updater.installer_ok(p)
    outside = tmp_path / "evil.exe"
    outside.write_bytes(b"MZ")
    assert not updater.installer_ok(outside) and not updater.installer_ok(p.parent / "gone.exe")


@pytest.mark.skipif(sys.platform == "darwin", reason="the Windows ACL")
def test_the_updates_folder_is_locked_to_administrators(monkeypatch, tmp_path):
    """The installer waiting there is started with administrator rights, so the folder must not be one the
    logged-in user can write to: the Projection5000 updates folder under ProgramData, icacls'd to
    Administrators and SYSTEM
    (full) and Users (read only) the first time it is made."""
    import winhost
    calls = []
    monkeypatch.setenv("ProgramData", str(tmp_path / "pd"))
    monkeypatch.setattr(winhost.subprocess, "run",
                        lambda argv, **kw: calls.append(argv) or subprocess.CompletedProcess([], 0, "", ""))
    d = winhost.updates_dir()
    assert d == tmp_path / "pd" / "Projection5000" / "updates" and d.is_dir()
    assert calls and calls[0][:3] == ["icacls", str(d), "/inheritance:r"]
    assert "*S-1-5-32-544:(OI)(CI)F" in calls[0] and "*S-1-5-18:(OI)(CI)F" in calls[0]
    assert "*S-1-5-32-545:(OI)(CI)RX" in calls[0]  # everyone else may read it, nobody else may write it
    calls.clear()
    assert winhost.updates_dir() == d and calls == []  # only the first time; an existing folder keeps its ACL


# ----- the version is pinned in three files

def test_the_three_version_pins_agree():
    src = Path(updater.__file__).resolve().parent
    resource = (src / "version.txt").read_text("utf-8")
    numbers = ", ".join(updater.VERSION.split("."))
    assert f"filevers=({numbers}, 0)" in resource and f"prodvers=({numbers}, 0)" in resource
    assert f"StringStruct('FileVersion', '{updater.VERSION}.0')" in resource
    assert f"StringStruct('ProductVersion', '{updater.VERSION}.0')" in resource
    assert f'#define AppVersion "{updater.VERSION}"' in (src / "installer.iss").read_text("utf-8")


def test_the_silent_installer_reopens_the_program():
    """An update runs the installer with /SILENT and the flasher quits for it. Inno Setup skips a skipifsilent
    [Run] entry then, and /RESTARTAPPLICATIONS only restarts what registered for it (the flasher does not),
    so without this entry the program would simply be gone after an update."""
    iss = (Path(updater.__file__).resolve().parent / "installer.iss").read_text("utf-8")
    run = [ln for ln in iss.split("[Run]", 1)[1].splitlines() if ln.startswith("Filename:")]
    assert len(run) == 1 and "Projection5000-SD-Flasher.exe" in run[0] and "postinstall" in run[0]
    assert "skipifsilent" not in run[0]


@pytest.mark.skipif(sys.platform == "darwin", reason="winhost")
def test_windows_starts_the_installer_silently_and_quits(monkeypatch):
    import winhost
    started = []
    monkeypatch.setattr(winhost.subprocess, "Popen", lambda argv, **kw: started.append(argv))
    assert winhost.install_update("C:/x/setup.exe") == ("Installing the update. The program will reopen by itself.",
                                                        True)
    log = str(Path("C:/x/setup.exe").with_name("install.log"))
    assert started == [["C:/x/setup.exe", *winhost.UPDATE_ARGS, f"/LOG={log}"]] and "/SILENT" in winhost.UPDATE_ARGS
    # Restart Manager cannot close the flasher politely, and a silent install answers its question with
    # Abort (seen on a real 0.7.5 update): the running flasher is force-closed instead, and the new
    # version is reopened by the installer's [Run] entry, not by Restart Manager.
    assert "/FORCECLOSEAPPLICATIONS" in winhost.UPDATE_ARGS and "/RESTARTAPPLICATIONS" not in winhost.UPDATE_ARGS


def test_the_installer_itself_force_closes_the_flasher():
    """An older flasher starts the new installer with its own switches; the installer's settings must make
    that work too."""
    iss = (Path(updater.__file__).resolve().parent / "installer.iss").read_text("utf-8")
    lines = [ln.strip() for ln in iss.splitlines()]
    assert "CloseApplications=force" in lines and "RestartApplications=no" in lines


def test_every_release_has_a_name_and_the_notes_head_with_it():
    """The name shows next to the version (window, "Updated to 0.7.8 (Axolotl)."); RELEASE_NOTES.md opens
    with this very release under the same name, so the two cannot drift apart at release time."""
    assert updater.NAME and len(updater.NAME) <= 30
    notes = (Path(updater.__file__).parent / "RELEASE_NOTES.md").read_text("utf-8")
    first = next(line for line in notes.splitlines() if line.startswith("## v"))
    assert first == f"## v{updater.VERSION} · {updater.NAME}"
    assert updater.label("0.7.8", "Axolotl") == "0.7.8 (Axolotl)" and updater.label("0.7.8") == "0.7.8"
