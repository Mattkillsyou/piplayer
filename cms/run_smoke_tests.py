#!/usr/bin/env python3
"""Run the end-to-end smoke tests against a throw-away CMS instance.

    cd cms
    .venv/Scripts/python.exe run_smoke_tests.py            # Windows
    .venv/bin/python run_smoke_tests.py                    # Linux / Pi

What it does:
  1. creates a fresh temporary data dir (PIPLAYER_DATA_DIR) so nothing is
     written inside the repo and the DB starts empty;
  2. starts `uvicorn app.main:app` on a free localhost port with
     PIPLAYER_ADMIN_PASSWORD=test1234 and waits for /api/health;
  3. runs test_v2.py and test_v3_v5.py against it (each `--repeat` times --
     the scripts are re-runnable against the same DB);
  4. always stops the server and deletes the temp dir (unless --keep).

Options:
  --port N          use this port instead of a free one
  --repeat N        run every script N times (default 1; use 2 to prove re-runnability)
  --cms-root DIR    directory containing the `app` package (default: next to this file)
  --keep            keep the temp data dir and server log for inspection
  --timeout SEC     seconds to wait for the server to come up (default 30)
  SCRIPT ...        smoke scripts to run (default: test_v2.py test_v3_v5.py)

Needs `requests` (see requirements-dev.txt) and ffmpeg on PATH.
"""
import argparse
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_SCRIPTS = ["test_v2.py", "test_v3_v5.py"]
ADMIN_PASSWORD = "test1234"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_health(base: str, proc: subprocess.Popen, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"server exited early with code {proc.returncode}")
        try:
            with urllib.request.urlopen(base + "/api/health", timeout=2) as r:
                if r.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(0.25)
    raise RuntimeError(f"server did not answer /api/health within {timeout}s")


def stop_server(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


def tail(path: Path, lines: int = 60) -> str:
    try:
        content = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(content[-lines:])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("PIPLAYER_SMOKE_PORT", "0")) or None)
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--cms-root", default=str(HERE))
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("scripts", nargs="*", default=DEFAULT_SCRIPTS)
    args = ap.parse_args(argv)

    cms_root = Path(args.cms_root).resolve()
    if not (cms_root / "app" / "main.py").is_file():
        print(f"error: {cms_root} does not contain app/main.py", file=sys.stderr, flush=True)
        return 2
    scripts = [Path(s) if Path(s).is_absolute() else HERE / s for s in args.scripts]
    for s in scripts:
        if not s.is_file():
            print(f"error: smoke script not found: {s}", file=sys.stderr, flush=True)
            return 2

    port = args.port or free_port()
    base = f"http://127.0.0.1:{port}"
    data_dir = Path(tempfile.mkdtemp(prefix="piplayer-smoke-data-"))
    log_path = data_dir / "server.log"

    env = dict(os.environ)
    env["PIPLAYER_DATA_DIR"] = str(data_dir)
    env["PIPLAYER_ADMIN_PASSWORD"] = ADMIN_PASSWORD
    env["PIPLAYER_BASE_URL"] = base
    env.pop("PIPLAYER_PUBLIC_BASE_URL", None)
    env.setdefault("PYTHONUNBUFFERED", "1")

    print(f"data dir : {data_dir}", flush=True)
    print(f"cms root : {cms_root}", flush=True)
    print(f"server   : {base}", flush=True)

    failures = []
    log_file = open(log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(cms_root), env=env, stdout=log_file, stderr=subprocess.STDOUT,
    )
    try:
        wait_for_health(base, proc, args.timeout)
        print("server   : up", flush=True)
        for n in range(1, args.repeat + 1):
            for script in scripts:
                label = script.name + (f" (run {n}/{args.repeat})" if args.repeat > 1 else "")
                print(f"\n=== {label} ===", flush=True)
                started = time.monotonic()
                result = subprocess.run([sys.executable, str(script)], cwd=str(HERE), env=env)
                elapsed = time.monotonic() - started
                if result.returncode == 0:
                    print(f"=== {label}: PASSED in {elapsed:.1f}s ===", flush=True)
                else:
                    print(f"=== {label}: FAILED (exit {result.returncode}) after {elapsed:.1f}s ===", flush=True)
                    failures.append(label)
    except Exception as e:  # server failed to start, etc.
        print(f"error: {e}", file=sys.stderr, flush=True)
        failures.append("server")
    finally:
        stop_server(proc)
        log_file.close()
        if failures:
            print("\n--- server log (tail) ---", flush=True)
            print(tail(log_path), flush=True)
        if args.keep:
            print(f"\nkept data dir: {data_dir}", flush=True)
        else:
            shutil.rmtree(data_dir, ignore_errors=True)

    if failures:
        print(f"\nFAILED: {', '.join(failures)}", flush=True)
        return 1
    print("\nALL SMOKE TESTS PASSED", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
