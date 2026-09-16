# Matt Brown's Projection5000 (formerly PiPlayer)

Self-hosted Screenly-style digital signage for Raspberry Pi. Loop videos on
projectors, manage everything from a single web console, update content
remotely. The product is Projection5000; the repository, service names, config
paths and cookie keep their original `piplayer` / `projector-*` names.

## What's here

- **`cms/`** — FastAPI web app. Hosts the admin UI, stores videos, serves
  per-device manifests. Runs on the "controller Pi" (or any always-on machine).
- **`player/`** — Python daemon + mpv configuration. Runs on every Pi that
  drives a projector. Polls the CMS every 30 seconds, downloads new videos,
  updates mpv's playlist in place over its IPC socket.
- **`docs/`** — setup walkthroughs.

Both current Raspberry Pi OS releases are supported: **Bookworm** (mpv 0.35,
Python 3.11) and **Trixie** (mpv 0.40, Python 3.13), 64-bit Lite in both
cases. See [docs/adding-a-pi.md](docs/adding-a-pi.md) for which Imager entry
is which.

## Architecture

```
[Your laptop/phone]
       |
       | https (Tailscale or public)
       v
[Controller Pi: CMS]
       ^   ^   ^
       |   |   |   http poll every 30s
       |   |   |
   [Pi #1] [Pi #2] [Pi #3]
       |       |       |
       v       v       v
   projector projector projector
```

Each player polls its assigned playlist. When the playlist changes (you added,
removed, or reordered videos), the player downloads the delta and edits the
playlist inside its running mpv rather than restarting it:

- If the item currently on screen is still in the new playlist (with the same
  per-item settings), it keeps playing uninterrupted; the rest of the list is
  rebuilt around it in the new order and playback continues from there.
- If the item on screen was removed from the playlist, mpv switches to the
  first item of the new list immediately.
- A duration change on the item that is *currently playing* takes effect the
  next time that item comes around in the loop, not mid-play.

If a download fails (network hiccup, file missing on the controller) the
player still loads everything it does have, reports the missing items to the
CMS (shown as a warning on the device's Devices-page row and dashboard card),
resumes the partial download on the next poll, and fills the gap when it
arrives.

## Quick start (dev / Windows)

Test the CMS on your laptop first before deploying:

```powershell
cd <path-to-clone>\cms
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:PIPLAYER_ADMIN_PASSWORD = "changeme"
$env:PIPLAYER_SECRET_KEY = "any-long-random-string-for-dev"
uvicorn app.main:app --reload --port 8080
```

Open <http://localhost:8080>, log in as `admin` / `changeme`, upload a video,
create a playlist, register a fake device. Confirm the UI works before you
touch a Pi.

On Windows the data (SQLite DB, uploaded media, screenshots) goes in
`.\data` under the directory you start uvicorn from; set `PIPLAYER_DATA_DIR`
to put it elsewhere. `PIPLAYER_SECRET_KEY` is optional but without it the
session-signing key is regenerated on every start (the CMS logs a warning),
so each `--reload` logs you out.

For real video playback you also need `ffmpeg`/`ffprobe` on PATH (the upload
form uses ffprobe to validate the file and extract duration/resolution).

## Deploying to Raspberry Pi

See [docs/adding-a-pi.md](docs/adding-a-pi.md) for the full walkthrough.

- Hardware: [docs/hardware.md](docs/hardware.md) is the per-projector kit (parts, links, costs, the unbox-to-playing checklist).
- Room camera: [docs/camera.md](docs/camera.md) covers RTSP and Wyze Cam snapshots on the console and the live view.

On Windows the Projection5000 SD Flasher (`tools/flasher/README.md`) replaces
the manual steps below: it writes the card and the Pi enrolls itself on first
boot. The flasher may also write the player's `[camera]` table (`source`, `rtsp_url`, `wyze_camera`, `snapshot_interval_seconds`, `live_url`) and `/etc/projector-player/wyze.env` (`WYZE_EMAIL`, `WYZE_PASSWORD`, `API_ID`, `API_KEY`); both are described in [docs/camera.md](docs/camera.md).

Short version:

**1. Install the CMS on one Pi (your "controller"):**

Raspberry Pi OS Lite does not ship `git`, so install it first. Also set the
controller's timezone: schedule rules are evaluated in the controller's local
wall-clock time (see "Scheduling" below).

```bash
sudo timedatectl set-timezone Region/City   # e.g. America/Los_Angeles; `timedatectl list-timezones` to browse
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Mattkillsyou/piplayer.git
cd piplayer/cms
sudo bash deploy/install-cms.sh
```

The CMS prints the initial admin password to its log:
`journalctl -u projector-cms.service -n 50` (look for "Created admin user").
Log in at `http://<controller-ip>:8080`, open **Users**, and set a password
of your own via **Reset password → Set** — the generated one sits in the
journal. To choose the first password instead, run the installer as
`PIPLAYER_ADMIN_PASSWORD=... sudo -E bash deploy/install-cms.sh`: the first
run writes it into `/etc/projector-cms/env`, which is only consulted when the
very first admin is created; it does not change an existing password.

**2. From the CMS web UI, register each player Pi.** Each one gets a unique
device ID and a token. On the Devices page, expand **Token / install** under
Actions — it shows the exact install command, with the CMS URL your browser
is using. Copy it.

**3. Install the player on each Pi:**

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/Mattkillsyou/piplayer.git
cd piplayer/player && \
DEVICE_ID=lobby-projector \
DEVICE_TOKEN=<paste-from-cms> \
CMS_URL=http://<controller-ip>:8080 \
sudo -E bash deploy/install-player.sh
```

The Pi will boot directly into fullscreen video playback. No desktop.

**4. Assign a playlist to the device in the CMS.** Within 30 seconds the Pi
downloads the videos and starts looping.

## Remote access

See [docs/setup-tailscale.md](docs/setup-tailscale.md) — recommended. You'll be
able to reach the CMS from any laptop or phone with Tailscale, anywhere.

For public-internet exposure (no client install required), see
[docs/public-access.md](docs/public-access.md). Uses Cloudflare Tunnel so you
don't need port forwarding or your own TLS certs — and explains how to keep
the players' `/api/*` path reachable when you put Cloudflare Access in front.

## Operating notes

- **Video format:** 1080p H.264 is the safe choice. The shipped `mpv.conf`
  now uses `vo=gpu` with `gpu-context=drm` so mpv scales on the GPU and can
  attach hardware decoders (the previous `vo=drm` output was software-only:
  every frame was decoded and scaled on the CPU). Note that the shipped
  `hwdec=auto-safe` only picks decoders mpv whitelists as safe — on Trixie
  (mpv 0.40) that covers HEVC on the Pi 5 via `drm` (zero-copy) or
  `drm-copy` (the mpv journal's "Using hardware decoding (...)" line shows
  which one initialised), but it never
  selects the Pi 4's H.264 V4L2 decoder, so H.264 still decodes in software
  there. To use it, edit the Pi's mpv.conf and set `hwdec=v4l2m2m-copy` (as
  the file's comment says) after testing on your hardware. **None of this
  has yet been validated on real Pi hardware.** If a Pi shows a black screen with
  GPU/EGL errors in `journalctl -u projector-mpv.service`, switch that Pi
  back to the software path: edit
  `/var/lib/projector-player/.config/mpv/mpv.conf`, replace the
  `vo=gpu`/`gpu-context=drm` lines with `vo=drm`, and
  `sudo systemctl restart projector-mpv.service`. Treat 4K (Pi 5, HEVC) as
  something to test on your own hardware before relying on it. Pi 5 has no
  H.264 hardware decoder; 1080p H.264 in software is still fine there.
- **Audio:** mpv autodetects. If you want to force HDMI audio, edit
  `/var/lib/projector-player/.config/mpv/mpv.conf` on the Pi.
- **Storage:** videos live at `/var/lib/projector-cms/media/` on the
  controller and `/var/lib/projector-player/media/` on each player.
- **Resilience:** if the network drops, players keep playing the last synced
  playlist forever. They retry sync with exponential backoff. A player that
  reboots while the CMS is unreachable loads its locally cached playlist
  straight away, and a restarted mpv gets the playlist re-pushed
  automatically.
- **Integrity:** the player keeps a hash cache (`media_index.json`) so
  unchanged files are not re-hashed on every playlist change; every file is
  re-verified once every 24 h and on a `force-sync` command, and any mismatch
  is re-downloaded.
- **No transcoding:** what you upload is what plays. Validate your encodes
  before uploading. Uploads that ffprobe cannot read as video/image are
  rejected.
- **Time zones:** device "last seen", audit and screenshot timestamps are
  stored in UTC and rendered in the controller's local zone with the zone
  abbreviation (e.g. `2026-09-14 15:03 PDT`).

## What v2 added

- **Images** (.jpg, .png, .gif, .webp, .bmp) as first-class media alongside videos
  - An **animated GIF** (more than one frame) is stored and played as a **video**: it plays once at its natural length and the default image duration does not apply. A duration override on it sets a fixed length — a GIF that loops (the usual case) repeats until the override elapses, one that does not loop ends early.
- **Per-item duration override** — set an image to play 8s, truncate a video at 15s
- **Drag-and-drop playlist reorder** (SortableJS, bundled locally)
- **Live status per device** — dashboard shows which item is playing and play/pause/idle
- **IPC-driven playback** — daemon drives mpv via the JSON IPC socket

## What v3 added

- **Time-based scheduling per device** — rules with priority, start/end time, days of week, date range. The CMS evaluates rules at sync time and returns the active playlist. Each device has a default playlist that plays when no rule matches.

### Scheduling

- Rule times are the **controller's local wall-clock time** (`timedatectl`
  on the controller Pi). The schedule page shows the zone name next to
  "Controller time now"; if that zone is wrong, fix it with
  `sudo timedatectl set-timezone Region/City` and
  `sudo systemctl restart projector-cms.service` (a running process keeps
  the zone it started with).
- A window with `end <= start` wraps midnight (e.g. `22:00–02:00`) and is
  anchored to the day it **starts**: a Friday-only `22:00–02:00` rule runs
  until 02:00 Saturday. `start == end` is rejected; leave both blank for
  all-day.
- DST is plain wall-clock: a window inside the repeated fall-back hour is
  active for two real hours; one entirely inside the skipped spring-forward
  hour does not fire that night.

## What v4 added

- **Device groups** — when a device has no explicit playlist and no matching schedule, it falls back to its group's playlist. Useful for "all lobby projectors run the same content."
- **Remote actions** — buttons on the Devices page to issue `reboot`, `restart-mpv`, or `force-sync` commands. The player picks them up out of the manifest on its next poll and reports a result; the Devices page shows the last 5 commands per device with their results. `reboot` and `restart-mpv` use a sudoers drop-in the install script writes (`/etc/sudoers.d/projector-player`); the player reports "executing" before it acts, never runs the same command twice, and the CMS stops delivering a command after 5 unanswered polls (marked `undeliverable`). `force-sync` also triggers a full integrity re-hash of the device's media.
- **Audit log** — every write operation is recorded (who, what, when, IP). Browse at `/audit`. Failed logins are recorded too (`login_failed`).

## What v5 added

- **Multi-user + roles** — `admin` (everything), `editor` (uploads, playlists, devices, commands), `viewer` (read-only). Admins manage users at `/users` (create, change role, reset password). Last admin cannot be deleted. Device tokens are only shown to admins and editors.
- **Live screenshots** — every minute (configurable with `PIPLAYER_SCREENSHOT_INTERVAL`, minimum 15 s) the player has mpv take a screenshot of the current output and uploads it. The dashboard shows a thumbnail per device with its age, and a "stale" badge once it is older than three intervals.

## Configuration reference

### CMS (`/etc/projector-cms/env`, loaded by `projector-cms.service`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIPLAYER_DATA_DIR` | `/var/lib/projector-cms` (Linux); `./data` (Windows) | Where `cms.db`, `media/` and `screenshots/` live. The systemd unit sets it. |
| `PIPLAYER_SECRET_KEY` | *(none — generated per process)* | Session-cookie signing key. The install script generates one; if unset the CMS logs a WARNING at startup and every restart logs all users out. |
| `PIPLAYER_ADMIN_USERNAME` | `admin` | Username of the first admin. **Only used when the users table is empty.** |
| `PIPLAYER_ADMIN_PASSWORD` | *(generated and printed to the log)* | Password of the first admin, max 72 bytes. **Only used when the users table is empty** — change passwords via Users → Reset password afterwards. |
| `PIPLAYER_PUBLIC_BASE_URL` | *(empty — derived from each request's Host)* | Overrides the base of the media download URLs in **every** device's manifest. Set only if the CMS sees a wrong Host; see [docs/public-access.md](docs/public-access.md). Also becomes the `CMS_URL` in the Devices-page install command. |
| `PIPLAYER_HTTPS_ONLY` | `0` | `1` marks the session cookie `Secure`. Only when every login path is https (breaks plain-http Tailscale/LAN login). |
| `PIPLAYER_FORWARDED_ALLOW_IPS` | `127.0.0.1` | Proxy addresses whose `X-Forwarded-*` headers are trusted (a same-host cloudflared/Caddy). Set in the unit; override in the env file if the proxy is elsewhere. |
| `PIPLAYER_SCREENSHOT_INTERVAL` | `60` | Seconds between player screenshots; sent to players in the manifest, players clamp to >= 15. |
| `PIPLAYER_MAX_SCREENSHOT_BYTES` | `5242880` (5 MiB) | Largest screenshot upload accepted. |
| `PIPLAYER_MAX_UPLOAD_BYTES` | `5368709120` (5 GiB) | Largest media upload accepted (413 beyond this). |
| `PIPLAYER_DEFAULT_IMAGE_DURATION` | `10` | Seconds an image stays on screen when the playlist item has no override. |
| `PIPLAYER_AUDIT_RETENTION_DAYS` | `0` (keep everything) | When > 0, audit-log rows older than this many days are pruned at every startup (irreversible). |

Numeric variables must be plain numbers (`5368709120`, not `5G`); a bad value
makes the CMS log a one-line error naming the variable and exit instead of
starting.

### Player (`/etc/projector-player/config.toml`; env vars override the file)

| `config.toml` key | Env override | Default | Meaning |
| --- | --- | --- | --- |
| `device_id` | `DEVICE_ID` / `PIPLAYER_DEVICE_ID` | *(required)* | The device ID registered in the CMS. |
| `device_token` | `DEVICE_TOKEN` / `PIPLAYER_DEVICE_TOKEN` | *(required)* | The device's bearer token. |
| `cms_url` | `CMS_URL` / `PIPLAYER_CMS_URL` | *(required)* | Base URL of the CMS as reachable from this Pi. |
| `media_dir` | `PIPLAYER_MEDIA_DIR` | `/var/lib/projector-player/media` | Downloaded media (plus `*.part` resumable partials). |
| `manifest_path` | `PIPLAYER_MANIFEST_PATH` | `/var/lib/projector-player/manifest.json` | Last synced manifest; `media_index.json` (hash cache) and `executed_commands.json` sit next to it. |
| `mpv_socket` | `PIPLAYER_MPV_SOCKET` | `/tmp/projector-mpv.sock` | mpv's JSON IPC socket (must match `projector-mpv.service`). |
| `poll_interval_seconds` | `PIPLAYER_POLL` | `30` | Seconds between CMS polls (minimum 5). |
| `verify_tls` | `PIPLAYER_VERIFY_TLS` | `true` | Set `false` only for a self-signed CMS certificate. |
| — | `PIPLAYER_CONFIG` | `/etc/projector-player/config.toml` | Path of the config file (set in `/etc/projector-player/env`). |

## Operations

### Backups (controller)

Everything the CMS owns is under `/var/lib/projector-cms/`:

- `cms.db` — SQLite database (users, devices, playlists, schedules, audit
  log). It runs in WAL mode, so do not copy the bare file while the service
  is running; use SQLite's online backup instead.
- `media/` — the uploaded files. A database restored without its `media/`
  gives you playlists whose every item 404s.
- `screenshots/` — latest screenshot per device (nice to have, safe to skip).

Plus `/etc/projector-cms/env` (the secret key — losing it only logs everyone
out, but keep it with the backup).

```bash
sudo apt-get install -y sqlite3
BACKUP=/mnt/backup/piplayer-$(date +%F)
sudo mkdir -p "$BACKUP"
sudo sqlite3 /var/lib/projector-cms/cms.db ".backup '$BACKUP/cms.db'"
sudo rsync -a /var/lib/projector-cms/media/ "$BACKUP/media/"
sudo rsync -a /var/lib/projector-cms/screenshots/ "$BACKUP/screenshots/"
sudo cp /etc/projector-cms/env "$BACKUP/env"
```

Restore: `sudo systemctl stop projector-cms.service`, copy `cms.db`,
`media/` and `screenshots/` back into `/var/lib/projector-cms/` (delete any
`cms.db-wal`/`cms.db-shm` left there), `sudo chown -R piplayer:piplayer
/var/lib/projector-cms`, then start the service. Players re-download nothing
if the files are byte-identical (their hash cache still matches).

### Upgrading the CMS in place

Re-running the installer is safe: it copies only the application code
(`rsync` excludes the data dir), leaves an existing `/etc/projector-cms/env`
untouched, and the CMS applies any schema migrations itself on startup.

```bash
cd ~/piplayer && git pull
cd cms && sudo bash deploy/install-cms.sh
```

### Upgrading a player in place

The installer always rewrites `/etc/projector-player/config.toml` from
`DEVICE_ID`, `DEVICE_TOKEN` and `CMS_URL`, so supply them again — either paste
the command from the Devices page or read the current values back out of the
file (other keys you added there, such as `poll_interval_seconds` or
`verify_tls`, are carried over):

```bash
cd ~/piplayer && git pull
cd player
eval "$(sudo sed -n \
    -e 's/^device_id = "\(.*\)"$/export DEVICE_ID="\1"/p' \
    -e 's/^device_token = "\(.*\)"$/export DEVICE_TOKEN="\1"/p' \
    -e 's/^cms_url = "\(.*\)"$/export CMS_URL="\1"/p' \
    /etc/projector-player/config.toml)"
sudo -E bash deploy/install-player.sh
```

Downloaded media, the manifest and the hash cache under
`/var/lib/projector-player/` are kept, so the Pi resumes playing without
re-downloading. An existing `/var/lib/projector-player/.config/mpv/mpv.conf`
(with any per-Pi `vo=drm` / `hwdec=` / `ao=` edits) is left untouched; the
new default is written next to it as `mpv.conf.dist` so you can diff and
merge. For a fleet, update the master image instead
([docs/make-master-image.md](docs/make-master-image.md)).

### Rotating a leaked device token

1. Devices page → expand **Token / install** for the device → **New token**.
   The old token is rejected from that moment (the Pi's next poll gets 401
   and it keeps playing its cached playlist).
2. On the Pi, put the new token in `/etc/projector-player/config.toml`
   (`sudo nano`, edit the `device_token` line) and
   `sudo systemctl restart projector-player.service` — or re-run the install
   command from the Devices page.
3. Check the device's **Last seen** advances again.

Deleting the device instead (Devices page → **Delete device**) removes its
token, schedule rules, recent commands and screenshot; the Pi keeps looping
whatever it last synced until you remove or re-register it.

### What deleting a playlist does

Deleting a playlist cascades: every schedule rule that points at it is
deleted, and any device or group that had it as its default is set to *no
playlist* (those devices fall back to their group playlist, or go blank on
their next poll). The audit log gets one `device_schedule_delete` row per
cascaded rule (with `cascade_from_playlist`) plus the `playlist_delete` row,
whose details list how many rules were deleted and which devices and groups
were cleared. Media files are not deleted — they stay in the library.

## Running the tests

Install the dev dependencies into the CMS venv once:

```bash
cd cms && pip install -r requirements-dev.txt
```

Then, from the repo root:

```bash
# CMS unit/integration tests (FastAPI TestClient, temp data dir per session)
python -m pytest cms/tests

# Player daemon tests (fake mpv socket, fake CMS; no hardware needed)
python -m pytest player/tests

# End-to-end smoke tests: starts a CMS on a free port with a fresh temp data
# dir, runs cms/test_v2.py and cms/test_v3_v5.py against it, stops it.
python cms/run_smoke_tests.py
```

All three are self-contained and re-runnable; none of them touch
`/var/lib/...` or write inside the repo. On Windows, run them from the
activated `cms\.venv` (`python -m pytest ...`).

## What's intentionally not here yet

- **Web-page assets** (display a live URL on screen) — needs a chromium kiosk
  swap mechanism alongside mpv; not a simple addition. Roadmap item for v6.
- **Per-group scheduling** — schedules live on the device, not the group. If
  you want a group-wide schedule, set it on each device (or copy it via the
  API).
- **Nested groups, tagging, SSO** — explicitly out of scope for a small fleet.
