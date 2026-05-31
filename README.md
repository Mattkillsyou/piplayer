# PiPlayer

Self-hosted Screenly-style digital signage for Raspberry Pi. Loop videos on
projectors, manage everything from a single web UI, update content remotely.

## What's here

- **`cms/`** — FastAPI web app. Hosts the admin UI, stores videos, serves
  per-device manifests. Runs on the "controller Pi" (or any always-on machine).
- **`player/`** — Python daemon + mpv configuration. Runs on every Pi that
  drives a projector. Polls the CMS every 30 seconds, downloads new videos,
  reloads the playlist seamlessly via mpv's IPC socket.
- **`docs/`** — setup walkthroughs.

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
removed, or reordered videos), the player downloads the delta and tells its
local mpv to reload the playlist with no playback gap for unchanged items.

## Quick start (dev / Windows)

Test the CMS on your laptop first before deploying:

```powershell
cd D:\Zenki\PiPlayer\cms
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:PIPLAYER_ADMIN_PASSWORD = "changeme"
uvicorn app.main:app --reload --port 8080
```

Open <http://localhost:8080>, log in as `admin` / `changeme`, upload a video,
create a playlist, register a fake device. Confirm the UI works before you
touch a Pi.

For real video playback you also need `ffmpeg`/`ffprobe` on PATH (the upload
form uses ffprobe to extract duration/resolution).

## Deploying to Raspberry Pi

See [docs/adding-a-pi.md](docs/adding-a-pi.md) for the full walkthrough.

Short version:

**1. Install the CMS on one Pi (your "controller"):**

```bash
git clone https://github.com/Mattkillsyou/piplayer.git
cd piplayer/cms
sudo bash deploy/install-cms.sh
```

The CMS will print the initial admin password to its log:
`journalctl -u projector-cms.service -n 50`.

**2. From the CMS web UI, register each player Pi.** Each one gets a unique
device ID and a token. The Devices page shows the exact install command —
copy it.

**3. Install the player on each Pi:**

```bash
git clone https://github.com/Mattkillsyou/piplayer.git
cd piplayer/player
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
don't need port forwarding or your own TLS certs.

## Operating notes

- **Video format:** 1080p H.264 is the sweet spot. Both Pi 4 and Pi 5 handle
  it. Pi 5 has no H.264 hardware decoder but software decoding is fine at
  1080p. For 4K, use Pi 5 only and stick to HEVC.
- **Audio:** mpv autodetects. If you want to force HDMI audio, edit
  `/var/lib/projector-player/.config/mpv/mpv.conf` on the Pi.
- **Storage:** videos live at `/var/lib/projector-cms/media/` on the
  controller and `/var/lib/projector-player/media/` on each player.
- **Resilience:** if the network drops, players keep playing the last synced
  playlist forever. They retry sync with exponential backoff.
- **No transcoding:** what you upload is what plays. Validate your encodes
  before uploading.

## What v2 added

- **Images** (.jpg, .png, .gif, .webp, .bmp) as first-class media alongside videos
- **Per-item duration override** — set an image to play 8s, truncate a video at 15s
- **Drag-and-drop playlist reorder** (SortableJS, bundled locally)
- **Live status per device** — dashboard shows which item is playing and play/pause/idle
- **IPC-driven playback** — daemon drives mpv via the JSON IPC socket

## What v3 added

- **Time-based scheduling per device** — rules with priority, start/end time, days of week, date range. The CMS evaluates rules at sync time and returns the active playlist. Each device has a default playlist that plays when no rule matches.

## What v4 added

- **Device groups** — when a device has no explicit playlist and no matching schedule, it falls back to its group's playlist. Useful for "all lobby projectors run the same content."
- **Remote actions** — buttons on the Devices page to issue `reboot`, `restart-mpv`, or `force-sync` commands. The player polls them out of the manifest and reports results. `reboot` and `restart-mpv` require a sudoers entry the install script writes for you.
- **Audit log** — every write operation is recorded (who, what, when, IP). Browse at `/audit`.

## What v5 added

- **Multi-user + roles** — `admin` (everything), `editor` (uploads, playlists, devices, commands), `viewer` (read-only). Admins manage users at `/users`. Last admin cannot be deleted.
- **Live screenshots** — every minute (configurable) the player has mpv take a screenshot of the current output and uploads it. The dashboard shows a thumbnail per device.

## What's intentionally not here yet

- **Web-page assets** (display a live URL on screen) — needs a chromium kiosk swap mechanism alongside mpv; not a simple addition. Roadmap item for v6.
- **Per-group scheduling** — schedules live on the device, not the group. If you want a group-wide schedule, set it on each device (or copy it via the API).
- **Nested groups, tagging, SSO** — explicitly out of scope for a small fleet.
