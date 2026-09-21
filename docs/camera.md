# Room camera

A camera in the projector's room whose picture shows up in the web console:
a snapshot on the device tile (dashboard) and on the Devices page, refreshed
every few seconds, plus an optional **Live** view. Works with a Wyze Cam v3
(via the unofficial `wyze-bridge`) or any camera that serves RTSP. The kit is
in [hardware.md](hardware.md).

## How it works

- The player daemon on the Pi reads a `[camera]` table from
  `/etc/projector-player/config.toml`. If `source` is not `"none"`, a
  background thread runs `ffmpeg -rtsp_transport tcp -i <rtsp_url> -frames:v 1`
  every N seconds (15 s timeout, one capture in flight at a time; the sync
  loop is never blocked) and uploads the JPEG to
  `POST /api/camera/<device_id>` with the device's bearer token, the same way
  the mpv screenshots go up.
- The console stores the latest JPEG per device and shows it with its age.
  A **STALE** badge appears once the snapshot is older than three intervals.
  If capture or upload fails, the daemon sends a short `camera_error` text
  with its next status update and the console shows it in the warning style
  next to the device (it clears itself on the next successful snapshot).
- The interval is a site setting, `camera_interval` (default 10 s, minimum
  5): on the cloud console it is on the **Settings** page; on the FastAPI
  console it is the `PIPLAYER_CAMERA_INTERVAL` env var. The console sends it
  to every player in the manifest, so the Pi's own
  `snapshot_interval_seconds` only matters until the first sync.
- **Live** is a link the operator pastes once per device (**Camera live
  URL** on the Devices page): an https URL the console opens in a new tab and
  can embed inline. Nothing on the Pi is exposed until you set that up (see
  "Live view"). On the cloud console the tunnel, the hostname and the URL
  can be created for you: [automation.md](automation.md) section G.

## Option A: any RTSP camera

1. Find the camera's RTSP URL (its manual or web UI; typical shapes are
   `rtsp://user:pass@192.168.1.20:554/stream1` or `.../h264`). Give the camera
   a fixed IP or DHCP reservation. Prefer the camera's sub-stream (lower
   resolution) if it has one: the snapshot is a thumbnail, not a recording.
2. Test from the Pi (ffmpeg is installed by the player installer):

   ```bash
   ffmpeg -rtsp_transport tcp -i "rtsp://user:pass@192.168.1.20:554/stream1" -frames:v 1 -q:v 5 -y /tmp/cam.jpg
   ls -l /tmp/cam.jpg
   ```

   A file of a few tens of KB means the stream works.
3. Add the table to `/etc/projector-player/config.toml` (`sudo nano`) and
   restart the daemon:

   ```toml
   [camera]
   source = "rtsp"
   rtsp_url = "rtsp://user:pass@192.168.1.20:554/stream1"
   ```

   ```bash
   sudo systemctl restart projector-player.service
   journalctl -u projector-player.service -n 20 | grep -i camera
   ```

   You should see `camera capture started: rtsp://... every 10s`. The
   device tile in the console shows the picture within one interval.

The credentials sit in the URL inside `config.toml`, which is mode 600 and
owned by the `projector` user. Use a camera account that can only view.

## Option B: Wyze Cam v3

Wyze cameras do not speak RTSP out of the box. The player uses the community
[`mrlt8/wyze-bridge`](https://github.com/mrlt8/docker-wyze-bridge) container,
which logs into your Wyze account and re-serves each camera as RTSP on the Pi.
**This bridge is unofficial**: it is not made or supported by Wyze, it relies
on Wyze's app API, and a Wyze-side change can break it until the container is
updated (`sudo systemctl restart projector-wyze-bridge.service` pulls the
latest image). If that is not acceptable, use an RTSP camera (Option A).

> **Cloud console:** you do not need to put credentials on each Pi. Enter
> the Wyze account once on the Settings page and each player fetches its own
> camera configuration; see [automation.md](automation.md) section D. The
> steps below are the manual path (Python console, or a Pi set up by hand),
> and on players installed from this branch the credentials file lives at
> `/var/lib/projector-player/wyze.env` rather than under `/etc`.

### Wyze API key

The bridge needs an API key in addition to your Wyze email and password.

1. Sign in at the Wyze developer portal:
   <https://developer-api-console.wyze.com/>. Use the same account the camera
   is paired with.
2. Create an API key. The portal shows an **API ID** (a UUID) and an
   **API key** (a long string). Copy both; the key is shown once. Keys expire
   after a year: put a reminder in your calendar, the bridge will start
   failing to log in when it lapses.
3. If the account has two-factor auth, the bridge also needs the TOTP secret
   (`TOTP_KEY=` in `wyze.env`; see the bridge's README). A separate Wyze
   account without 2FA, with the camera shared to it, is simpler.

### Install with `--with-wyze`

Run the player installer with the `--with-wyze` flag. It apt-installs ffmpeg
(always), installs Docker with the get.docker.com convenience script and
pre-pulls the bridge image, writes the credentials file when the four
`WYZE_*` vars are given, installs `projector-wyze-bridge.service` and, when
`WYZE_CAMERA` is given, adds the `[camera]` table to `config.toml` for you.
On a cloud-console site leave the `WYZE_*` vars out: the daemon writes the
file itself from `GET /api/camera-config`.

```bash
cd ~/piplayer/player
DEVICE_ID=lobby-projector \
DEVICE_TOKEN=<paste-from-console> \
CMS_URL=https://console.example.com \
WYZE_EMAIL=you@example.com \
WYZE_PASSWORD='your-wyze-password' \
WYZE_API_ID=<api-id-from-portal> \
WYZE_API_KEY=<api-key-from-portal> \
WYZE_CAMERA="Lobby Cam" \
sudo -E bash deploy/install-player.sh --with-wyze
```

`WYZE_CAMERA` is the camera's name exactly as shown in the Wyze app. The
installer writes:

- `/var/lib/projector-player/wyze.env` (mode 600, owned by `projector`):
  `WYZE_EMAIL`, `WYZE_PASSWORD`, `API_ID`, `API_KEY`. Written only when all
  four `WYZE_*` vars are given; otherwise an existing file is kept, a legacy
  `/etc/projector-player/wyze.env` from an older install is moved here, and
  with neither the installer writes nothing (no template any more) and says
  so: the daemon creates the file from the console's camera config on its
  first sync, and on a Python-console site you write it by hand:

  ```bash
  sudo nano /var/lib/projector-player/wyze.env
  sudo chown projector:projector /var/lib/projector-player/wyze.env
  sudo chmod 600 /var/lib/projector-player/wyze.env
  sudo systemctl restart projector-wyze-bridge.service
  ```

- `/etc/systemd/system/projector-wyze-bridge.service`: runs the container
  with `--env-file /var/lib/projector-player/wyze.env`, bound to localhost
  only: RTSP on `127.0.0.1:8554` and the bridge's web player on
  `127.0.0.1:5000`. Nothing is reachable from the LAN. The unit has
  `ConditionPathExists=` on the env file, so without credentials it is
  skipped rather than failed and the daemon starts it later with
  `sudo -n systemctl restart projector-wyze-bridge.service` (allowed by the
  `/etc/sudoers.d/projector-player` drop-in).
- The `[camera]` table (only if `WYZE_CAMERA` was set and the file has no
  `[camera]` yet):

  ```toml
  [camera]
  source = "wyze"
  wyze_camera = "Lobby Cam"
  ```

The `[camera]` table is the manual override: it is what the player uses
when the console sends no `camera_config_version` (Python console, older
cloud console) and also when the console's answer is `source = "none"`
(the console cannot switch off a hand-configured camera). Whenever the
console names a camera, the fetched configuration wins.

With `source = "wyze"` the player derives the stream URL itself:
`rtsp://127.0.0.1:8554/<name>`, where `<name>` is the Wyze name lowercased
with spaces turned into dashes (`Lobby Cam` becomes `lobby-cam`). Check that
the bridge agrees:

```bash
journalctl -u projector-wyze-bridge.service -n 50      # look for the camera name and "rtsp://"
ffmpeg -rtsp_transport tcp -i rtsp://127.0.0.1:8554/lobby-cam -frames:v 1 -q:v 5 -y /tmp/cam.jpg
```

The bridge takes a minute after boot to log in and start the stream; the
first snapshots may fail and then recover (the console's warning clears on
the first good one).

Re-running the installer without `--with-wyze` keeps the bridge unit and
`wyze.env` in place and carries the `[camera]` table over (it lives among
the keys the installer preserves); `--upgrade` refreshes the wyze unit as
well whenever it is installed, which is how a player set up before this
change gets the `/var/lib` env-file path (its `/etc` copy is moved).
`--uninstall` removes the unit, the container and the credentials file;
Docker itself stays installed.

## `[camera]` keys in config.toml

| Key | Env override | Default | Meaning |
| --- | --- | --- | --- |
| `source` | `PIPLAYER_CAMERA_SOURCE` | `"none"` | `"none"`, `"rtsp"` or `"wyze"`. Anything else stops the daemon with a config error. |
| `rtsp_url` | `PIPLAYER_CAMERA_RTSP_URL` | *(empty)* | Required for `"rtsp"`. Ignored for `"wyze"` (derived from `wyze_camera`). |
| `wyze_camera` | `PIPLAYER_CAMERA_WYZE_CAMERA` | *(empty)* | Required for `"wyze"`: the camera name from the Wyze app. |
| `snapshot_interval_seconds` | `PIPLAYER_CAMERA_SNAPSHOT_INTERVAL` | `10` | Seconds between captures until the first sync; after that the console's `camera_interval` wins. Clamped to >= 5. |
| `live_url` | `PIPLAYER_CAMERA_LIVE_URL` | *(empty)* | Optional note of the live-view URL for this Pi. The player does **not** send it to the console; the **Camera live URL** field on the Devices page is what the console embeds. |

Env overrides are read from `/etc/projector-player/env` (the unit's
`EnvironmentFile`) and win over the file, like the other `PIPLAYER_*` vars in
the README's configuration reference.

## Live view

The snapshot is a still every few seconds. For a live picture the console
embeds a URL you supply, so you decide what to expose and how it is protected.
The recommended setup is one Cloudflare Tunnel hostname per Pi, pointing at
the bridge's web player (Wyze) or at whatever serves your camera's live page
(RTSP cameras: the camera's own web UI, or a small HLS/WebRTC gateway such as
`mediamtx` on the Pi), with Cloudflare Access in front.

> **Cloud console:** once the three `CF_*` worker secrets are set, the
> console creates the tunnel, the DNS record and the Access application
> itself, at enrollment or from a **Create tunnel** button, and the Pi runs
> `cloudflared` from a token in its manifest; see
> [automation.md](automation.md) section G. The steps below are the manual
> route, still needed on a Python console or for a camera page other than
> the wyze-bridge player on port 5000.

1. On the Pi, install `cloudflared` and create a tunnel, as in
   [public-access.md](public-access.md) ("Recommended: Cloudflare Tunnel",
   steps 2-5) but on the player Pi, with an ingress rule for the camera:

   ```yaml
   tunnel: lobby-projector-cam
   credentials-file: /root/.cloudflared/<tunnel-id>.json

   ingress:
     - hostname: lobby-cam.yourdomain.com
       service: http://localhost:5000
     - service: http_status:404
   ```

   Port 5000 is the wyze-bridge web player; for an RTSP camera point
   `service:` at whatever serves its live page.

2. **Put Cloudflare Access in front of the hostname.** The bridge's web
   player has no login of its own (the unit runs it with `WB_AUTH=false`,
   safe only because it is bound to localhost), so the tunnel hostname must
   not be reachable anonymously. Cloudflare Zero Trust → **Access →
   Applications → Add an application → Self-hosted**, domain
   `lobby-cam.yourdomain.com`, policy **Allow** for your email or your
   Workspace / Microsoft domain (same as step 7 of
   [public-access.md](public-access.md), without the `/api` bypass; nothing
   on this hostname is fetched by a player).

3. In the console, open **Devices**, expand the **Camera** block under the
   device and paste `https://lobby-cam.yourdomain.com/` into **Camera live
   URL**, then **Save**. Only absolute `https://` URLs are accepted; the
   field is editable by editors and admins and the change is audited as
   `device_set_camera_url`.

4. The **Camera** block now has a **Live** button that opens the URL in a
   new tab, and **Show live**, which embeds it inline (the iframe is only
   created when you click, sandboxed, and sends no referrer). Open **Live**
   in the new tab first: that is where you pass the Cloudflare Access login.
   Once the Access cookie is set for the hostname, **Show live** works in the
   same browser.

You can also put the tunnel URL in the Pi's `[camera] live_url` as a note of
where the feed lives; the console never reads it.

## Troubleshooting

**No snapshot on the tile, no warning either.**

- `source` is still `"none"` (or the `[camera]` table is missing). Check
  `sudo grep -A4 '^\[camera\]' /etc/projector-player/config.toml`, then
  `journalctl -u projector-player.service -n 30`: a running camera thread
  logs `camera capture started` at boot. A config error (`[camera] source
  must be one of ...`, `needs rtsp_url`, `needs wyze_camera`) stops the
  daemon; fix the file and `sudo systemctl restart projector-player.service`.
- The console is older than the player. The upload endpoint
  (`/api/camera/<id>`) answers 404 on a console without the camera feature;
  the player then shows `upload failed: HTTP 404` as the warning.

**Warning text on the device and what it means.** The text is the
`camera_error` the Pi sent (cut to 200 characters); it is logged on the Pi at
most once every 10 minutes (`journalctl -u projector-player.service | grep
"camera snapshot failed"`).

| Warning | Cause | Fix |
| --- | --- | --- |
| `ffmpeg timed out after 15s (camera unreachable?)` | No RTSP answer: wrong IP/port, camera off, bridge not up yet, camera on a different VLAN. | `ping` the camera; run the ffmpeg test command by hand; for Wyze, `journalctl -u projector-wyze-bridge.service -n 50`. |
| `ffmpeg failed (exit 1): ...401 Unauthorized` (or `403`) | Bad RTSP user/password. | Fix `rtsp_url`. |
| `ffmpeg failed (exit 1): ...404 ...` or `...Not Found` | Wrong stream path; for Wyze the derived name does not match the bridge (rename in the app has spaces, punctuation, or the camera was not shared to the account). | Compare with the names in the bridge's log; set `wyze_camera` to the app name exactly. |
| `ffmpeg failed (exit 1): ...Connection refused` | Nothing listening: for Wyze the bridge container is not running. | `sudo systemctl status projector-wyze-bridge.service`, `docker ps`. If the bridge log says it cannot log in, check `wyze.env` (expired API key, wrong password, 2FA). |
| `cannot run ffmpeg: ...` | ffmpeg missing (player installed before the camera feature). | `sudo apt-get install -y ffmpeg`, or re-run the installer. |
| `ffmpeg produced no JPEG frame` | Stream connected but sent no decodable video within the timeout (audio-only URL, very long keyframe interval). | Use the camera's sub-stream, or a URL that starts with video. |
| `snapshot too large (... bytes, max 2097152)` | Frame larger than 2 MiB (a 4K main stream at `-q:v 5`). | Use the sub-stream or a lower resolution profile. |
| `upload failed: HTTP 401` / `403` | Device token rejected (same as for screenshots). | Devices page → Token / install → **New token** (admin), update `config.toml`. |
| `upload failed: HTTP 413` | The console rejected the size. | Same as "snapshot too large". |
| `upload failed: HTTP 404` | Console without the camera endpoint. | Upgrade the console. |
| `HTTPSConnectionPool(host='console.example.com', port=443): Max retries exceeded with url: /api/camera/...` or `...: Read timed out. (read timeout=15)` (a requests connection/timeout message naming the console host; no `ConnectionError:` prefix) | Console unreachable from the Pi. | Same fix as for a player that is not syncing (see adding-a-pi.md, Troubleshooting). |

**Snapshot shows but goes STALE.**

- The Pi stopped uploading: see the warning text above. If there is no
  warning, the Pi itself is offline (**Last seen** is old too).
- The interval on the console was raised after the Pi last synced. It adopts
  the new value on its next poll (30 s).

**Wyze bridge keeps restarting.**

- `journalctl -u projector-wyze-bridge.service -n 100`. Typical causes:
  wrong password, expired API key (create a new one in the portal, replace
  it on the console's Settings page or edit `wyze.env` and restart the
  unit), a missing `wyze.env` (the unit is skipped until the daemon has
  fetched the camera config; `journalctl -u projector-player.service`
  shows the fetch),
  2FA on the account (add `TOTP_KEY=` or use an account without 2FA), no
  internet at boot (it retries every 10 s), or Docker not running
  (`sudo systemctl status docker`).
- `docker pull` failed: the Pi has no route to Docker Hub. The unit tolerates
  a failed pull if an image is already present; on a fresh install it needs
  the download once.

**Live button missing, or Show live shows a blank / login page.**

- No **Live** button: **Camera live URL** is empty or was rejected (it must
  start with `https://`). Paste the full URL and Save.
- Blank iframe or a Cloudflare login page: open **Live** in a new tab first
  and log in through Access, then click **Show live** again. Access
  applications and the console must be viewed in the same browser profile.
- `lobby-cam.yourdomain.com` times out: the tunnel is down on the Pi
  (`sudo systemctl status cloudflared`, or `projector-cloudflared.service`
  for a console-made tunnel) or the ingress `service:` port is wrong
  (`curl -sI http://127.0.0.1:5000/` on the Pi should answer).
- The picture in the bridge's web player is black while the snapshot works:
  the browser stream needs a different codec path than ffmpeg; see the
  wyze-bridge README (WebRTC vs HLS). The snapshot is independent of it.
