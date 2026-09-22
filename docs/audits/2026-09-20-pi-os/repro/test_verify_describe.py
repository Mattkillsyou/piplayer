import errno, requests, sys
sys.path.insert(0, "D:/Projection Software/piplayer-audit-pi/player")
from player import sync as S
from player.sync import ENOSPC_TEXT

def fixed(e):
    if isinstance(e, OSError) and e.errno == errno.ENOSPC:
        return ENOSPC_TEXT
    if isinstance(e, requests.HTTPError) and e.response is not None:
        return f"HTTP {e.response.status_code}"
    if isinstance(e, requests.exceptions.SSLError):
        return "secure connection failed (check the Pi's clock)"
    if isinstance(e, requests.ConnectionError):   # includes ConnectTimeout
        return "lost the connection to the console"
    if isinstance(e, requests.Timeout):           # ReadTimeout
        return "the download stalled"
    if isinstance(e, requests.RequestException):
        return "the download was cut off"
    return str(e)[:80] or type(e).__name__

def test_map():
    ex = requests.exceptions
    assert fixed(ex.ReadTimeout()) == "the download stalled"
    assert fixed(ex.ConnectTimeout()) == "lost the connection to the console"
    assert fixed(ex.SSLError()) == "secure connection failed (check the Pi's clock)"
    assert fixed(ex.ConnectionError()) == "lost the connection to the console"
    assert fixed(ex.ChunkedEncodingError()) == "the download was cut off"
    assert fixed(OSError(errno.ENOSPC, "x")) == ENOSPC_TEXT
    assert fixed(S.SyncError("sha256 mismatch")) == "sha256 mismatch"
    r = requests.Response(); r.status_code = 404
    assert fixed(ex.HTTPError(response=r)) == "HTTP 404"
    for cls in (ex.ReadTimeout, ex.ConnectTimeout, ex.SSLError, ex.ConnectionError, ex.ChunkedEncodingError):
        assert cls.__name__ not in fixed(cls())
