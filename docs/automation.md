# Automation

Features that take the manual steps out of running a fleet: new devices set
themselves up, the flasher needs no rebuild per site, players update
themselves, cameras and projectors configure from the console, the console
alerts you, and the live camera view needs no hand-made tunnel.

The cloud console (`cloud/`) gets every feature. The Python console (`cms/`)
gets A, C and E, the ones an offline LAN site needs, with the same routes and
markup. D, F and G are cloud-only. Every new manifest key is optional: a
player talking to a console that lacks the feature simply sees the key absent
and treats the feature as off.

Each section says what the feature does, which settings drive it, and the
one-time steps the operator must do by hand (tokens, accounts, dashboard
settings).

## A. Auto-assign on enrollment (cloud + cms)

**What it does.** When a freshly flashed Pi enrolls itself (`POST /api/enroll`
with the site's enrollment key), the console can put the new device straight
into a group and give it a playlist, so a card flashed on Monday is playing
the right content the moment it boots, with nobody touching the Devices page.

**Settings** (Settings page, admin):

| Setting | Key | Values |
|---|---|---|
| New devices join group | `enroll_group_id` | none, or any existing group |
| New devices get playlist | `enroll_playlist_id` | none, or any existing playlist |

Both are optional and independent. Saving a value that does not name an
existing row is rejected with 400. If the chosen group or playlist is later
deleted, the setting is treated as "none" at enrollment time (nothing is
cleared on disk; the dangling id is just ignored), so pick a replacement on
the Settings page when you delete one.

**Behaviour.**

- **First enrollment** (the device id is new): the device row is created with
  the configured `group_id` and `playlist_id`. The `device_enrolled` audit
  entry records which group and playlist were applied, so the audit log is
  where you see that an assignment came from the Settings defaults rather
  than from an operator. The Devices page shows only the resulting
  assignment.
- **Re-enrollment** (same device id, for example a re-flashed card): the
  device keeps its current group and playlist. The defaults are never
  re-applied, so whatever you set on the Devices page after the first boot
  survives a re-flash. The `device_reenrolled` audit entry is written as
  before.

**Python console.** `cms/` gains the same `POST /api/enroll` contract as the
cloud (body `{key, device_id, name}`, 401 on a bad key, returns
`{token, cms_url}`), backed by a new `settings` table. The enrollment key is
generated on first start and shown, and can be rotated, on a new admin-only
Settings page, which also carries the two auto-assign selects.

**Operator steps.** None beyond choosing the two defaults on the Settings
page. Set them before flashing a batch of cards; changing them later affects
only devices that enroll afterwards.

## B. Flasher fetches the enrollment key live (flasher + cloud)

**What it does.** The SD flasher no longer carries the site's enrollment key
baked into the exe. Instead each operator holds a personal API token; on
every launch the flasher presents that token to the cloud console, fetches
the current enrollment key together with the console name and the group and
playlist lists, and writes the fresh key onto the card. Rotating the key on
the Settings page takes effect on the next flash, with no rebuild of the exe,
and one build of the flasher serves every operator.

**Cloud console.**

- Table `api_tokens(id, user_id, name, token_hash, created_at, last_used_at)`.
  A token is `p5k_` followed by 32 URL-safe characters. Only its SHA-256 hash
  is stored and lookups compare in constant time; the plain token is shown
  once, at creation, and cannot be recovered afterwards.
- Tokens are managed in two places, both admin only: the "My API tokens"
  panel of the Settings page (the signed-in admin's own tokens) and the Users
  page, where each user's row has an "API tokens" fold with that user's
  tokens (any admin or editor; viewers cannot hold one). Both offer create
  (name it after the person or laptop that will hold it) and revoke, and show
  each token's creation and last-use times. A revoked token fails
  immediately. Routes: Settings page `POST /settings/tokens` (create, shown
  once) and `POST /settings/tokens/<token_id>/revoke`; Users page
  `POST /users/<user_id>/tokens` (create, shown once) and
  `POST /users/<user_id>/tokens/<token_id>/revoke`; viewers cannot hold
  tokens (400).
- `GET /api/operator/enrollment` with `Authorization: Bearer p5k_<token>`
  returns `{console_url, enrollment_key, groups: [{id, name}],
  playlists: [{id, name}], timezone, wyze_configured}`. `wyze_configured` is
  `true` once the Wyze email and password of section D are set, so the
  flasher's provision script passes `--with-wyze`; `false` otherwise. The endpoint is read-only, answers only tokens whose user
  is an admin or editor, and returns 401 for anything else: a missing or
  malformed header, an unknown or revoked token, or a viewer's token. The
  token's `last_used_at` is refreshed and an `api_token_used` audit entry is
  written at most once per hour per token, so the audit log shows who is flashing
  without filling up on every launch.

**Flasher.** On first run the tool asks for the console URL and an operator
token and stores them in `%APPDATA%\Projection5000\flasher.json`. The token is
protected with Windows DPAPI (`CryptProtectData` via ctypes, tied to the
Windows user account, no extra package); if DPAPI fails the token is stored in
plain text and the log warns you. (Plain form values such as the last Wi-Fi
name live in a separate `%LOCALAPPDATA%\Projection5000\flasher.json`.) Every
later launch calls `GET /api/operator/enrollment`, shows the console name and
URL plus the fetched group and playlist lists, and passes the fresh
enrollment key into the provision script it writes to the card. There is no
per-card group or playlist choice: the site-wide defaults from section A
decide what a new device gets. `build.ps1` no longer bakes a key;
`-Key <enrollment key>` (with `-ConsoleUrl <url>`, or the env vars
`FLASHER_ENROLL_KEY` / `FLASHER_CONSOLE_URL`) remains for offline builds
where the console cannot be reached at flash time. The card layout and
`firstrun.sh` are unchanged apart from where the key comes from, and the
paste-a-device-token path still bypasses enrollment. See
`tools/flasher/README.md` for the tool itself.

**Operator steps** (once per operator):

1. Sign in to the cloud console as an admin, open Settings, and under "My
   API tokens" click Create token, giving it a name such as `matt-laptop`.
   To issue a token for another admin or editor, open the Users page, expand
   "API tokens" under their row and create it there.
2. Copy the `p5k_...` value now: it is shown once. Treat it like a password.
3. Start the flasher, enter the console URL
   (`https://projectors.photogen5000.com`) and paste the token. The flasher
   confirms by showing the console name and the group and playlist lists.

**Rotation.** Two independent secrets are involved.

- *Enrollment key* (Settings page): rotate it when a flashed but unbooted
  card is lost. Cards written with the old key fail enrollment with a 401;
  cards flashed after the rotation pick up the new key automatically. No
  rebuild, no operator action.
- *Operator token*: revoke it under "My API tokens" or on the Users page when
  an operator leaves or a laptop is lost, then create a new one and enter it
  in the flasher. Both places show each token's last use, so a token that has
  not been used in months is easy to spot and revoke. The audit log's
  `api_token_used` entries name the token behind every flashing session.

The Python console (`cms/`) has no operator tokens: a LAN-only site flashes
with the offline `build.ps1 -Key` build, pasting the key from the cms Settings
page.

## C. Remote updates: player software and OS packages (player + cloud + cms)

**What it does.** The console can update a player's software (the code under
`/opt/piplayer/player`) and its OS packages without anyone SSHing in: a button
per device, one "Update all players" action for the fleet, and an optional
nightly mode where every player updates itself inside a quiet window. The
player reports how the last update went, and the Devices page shows it next
to the player version.

**Commands.** Three new entries in the `device_commands` CHECK list, issued
and delivered like `reboot` (manifest queue, result reported back, delivery
capped at 5 unanswered polls):

| Command | What the Pi runs |
|---|---|
| `update-player` | `sudo -n /opt/piplayer/player/deploy/update-player.sh <ref>` |
| `update-os` | `sudo -n /opt/piplayer/player/deploy/update-os.sh` |
| `update-all` | `sudo -n /opt/piplayer/player/deploy/update-player.sh <ref> --then-os` (the player update chains into `update-os.sh`) |

Buttons for all three sit in each device's Recent commands area. The Devices
page header has **Update all players** (editor and above, with a confirm),
which queues `update-player` for every device using the release ref from
Settings. Each issue is audited.

**Settings** (Settings page, admin):

| Setting | Key | Values |
|---|---|---|
| Player release | `player_release` | git ref: tag, branch or commit sha; default `main` |
| Auto-update | `auto_update` | `off` (default) or `nightly` |
| Auto-update window | `auto_update_window` | `HH:MM-HH:MM` on the Pi's local clock; default `03:00-05:00` |

The cloud console takes the same three env vars as defaults when a setting has
not been saved yet: `PIPLAYER_PLAYER_RELEASE` (default `main`),
`PIPLAYER_AUTO_UPDATE` (`off` or `nightly`) and `PIPLAYER_AUTO_UPDATE_WINDOW`
(`HH:MM-HH:MM`, default `03:00-05:00`), set as `[vars]` in
`cloud/wrangler.toml`; invalid values fall back to the defaults
(`cloud/src/db.js` `defaultSettings`).

The manifest gains an optional `update: {release, auto, window}` key. A player
that never sees it (older console, or the Python console without the env vars
below) behaves exactly as before.

**Release ref.** `player_release` is whatever `git clone --branch` accepts on
`https://github.com/Mattkillsyou/piplayer.git`: a tag such as `v6.0`, a
branch such as `main`, or a full commit sha. Pin a tag for a fleet you do not
want to move on its own; leave `main` while developing. The console stores
the ref verbatim and never resolves it; the Pi decides whether it already has
that code by comparing the checkout's sha with `/opt/piplayer/player/RELEASE`
(written by the installer), so a second `update-player` at the same ref is a
no-op that reports `already at <sha>`.

**How `update-player` runs on the Pi.** The player daemon
(`player/player/updater.py`) treats it like `reboot`: the command is written
to the executed ledger and reported as "executing" *before* the script runs,
because the script restarts the daemon and a report sent afterwards would be
lost. `update-player.sh <ref>` (root, allowed by the sudoers drop-in
`/etc/sudoers.d/projector-player` that `install-player.sh` writes; a
`/usr/bin/bash` prefix is accepted too) first detaches itself into a
transient systemd unit (`systemd-run --unit=projector-player-update`;
`update-os.sh` uses `projector-os-update`) and returns, so the daemon's
command result is only `update-player <ref> started` (or
`update-player <ref> failed: rc=...`); the real outcome arrives later through
`update_status`. The unit name doubles as a lock: a second update issued while
one is running fails with "unit already exists". Detached, the script does,
in order:

1. `git clone --depth 1 --branch <ref>` into `/opt/piplayer/src-<timestamp>`
   (falls back to fetching the GitHub tarball with `curl` if git is missing).
2. Checks `player/player/__init__.py` exists in the checkout; a wrong ref or
   a half-fetched tree stops here with a failed status.
3. Compares the checkout's sha with `/opt/piplayer/player/RELEASE`; equal
   means "already at <sha>", success, nothing else touched.
4. Moves the running code to `/opt/piplayer/player.prev` (exactly one `.prev`
   is kept; an older one is replaced) and runs
   `bash player/deploy/install-player.sh --upgrade` from the checkout.
   Upgrade mode keeps `/etc/projector-player/config.toml`, `wyze.env` and
   everything under `/var/lib/projector-player/`, and does not need the
   `DEVICE_*` variables because the config file already exists.
5. Writes `/var/lib/projector-player/update-status.json`
   (`{ref, started, finished, ok, message, previous_version}`) and appends
   the full transcript to `/var/lib/projector-player/update.log`.
6. Arms the post-check timer and restarts `projector-player.service` last
   (with `--then-os` it then runs `update-os.sh`).

The next daemon to start reads `update-status.json` and sends it to the
console as the `update_status` query parameter of its next sync (once per
status file: a marker next to it records what was reported). The console
stores it in the device row's `last_update_at`, `last_update_ok`,
`last_update_message` and `last_update_ref` columns.

**Rollback.** The script arms a post-check (`projector-player-postcheck.timer`,
armed by the script right before it restarts the service; it fires two minutes
later and runs `update-player.sh --postcheck`). If the service is then not
active (a daemon that cannot import hits systemd's start limit) or has been
auto-restarted three or more times, the post-check moves `/opt/piplayer/player.prev` back into place, restarts the
service and writes a failed status with the reason, so the Devices page shows
the rollback and the Pi keeps playing on the previous code. The console does
nothing on its own: it only records what the Pi reports. To roll back by
hand, set `player_release` to the previous tag or sha and issue
`update-player` again.

**`update-os`.** `update-os.sh` (detached the same way) runs `apt-get
update`, `apt-get -y -o Dpkg::Options::=--force-confold upgrade` (existing
config files win over package defaults) and `apt-get -y autoremove`, logging
to the same `update.log`. It writes the same `update-status.json` with `ref`
set to `os` and an extra `reboot_required` key; when that is true the daemon
reports the status on its next sync and then reboots, so the console has the
result before the Pi goes down. Expect a few minutes of downtime on a slow
card; issue it inside the quiet window or use `auto_update`.

**Auto mode.** With `auto_update = nightly` the daemon checks on every sync:
if the Pi's local time is inside `auto_update_window`, and the last update attempt
(from `update-status.json`; an `update-os` status does not count) started
more than 20 hours ago, it runs `update-player` with the manifest's
`update.release`, exactly as if the console had queued the command. The 20 h guard is what stops it re-running
every poll for the length of the window; with the ref unchanged the run is
the "already at <sha>" no-op anyway. Auto mode never runs `update-os`;
queue that yourself or with **Update all players**. The window is evaluated
on the Pi's own clock, not the console's: the flasher sets the Pi timezone to
the console timezone (`timedatectl set-timezone` in `firstrun.sh`), so keep
the two in step, or change it on the Pi with `sudo timedatectl set-timezone`.

**What the console shows.** The Devices page shows `player_version` with the
short sha from `RELEASE` appended, and an update status per device: ok or
failed, the message, and when; failures are highlighted. Audit actions cover
every issue of the three commands, the fleet action, and each setting change.

**Logs on the Pi** when something needs a closer look:

```bash
cat /var/lib/projector-player/update-status.json
sudo tail -n 100 /var/lib/projector-player/update.log
journalctl -u projector-player.service -n 100
systemctl status projector-player-update projector-os-update   # a run still in progress
cat /opt/piplayer/player/RELEASE            # sha now running
ls -d /opt/piplayer/player.prev /opt/piplayer/src-*   # rollback copy, checkouts
```

**Python console.** `cms/` accepts the same three commands and puts the same
`update` key in the manifest, driven by env in `/etc/projector-cms/env`:
`PIPLAYER_PLAYER_RELEASE` (default `main`), `PIPLAYER_AUTO_UPDATE` (`off` or
`nightly`) and `PIPLAYER_AUTO_UPDATE_WINDOW` (`HH:MM-HH:MM`, default
`03:00-05:00`). Restart `projector-cms.service` after editing.

**Operator steps.** None for the cloud beyond choosing the settings: the Pi
fetches from the public GitHub repository over HTTPS, so it only needs
outbound internet. Sites whose Pis have no route to GitHub (LAN-only, no
gateway) cannot use remote updates and keep the in-place upgrade in the
README. Players installed before this feature need one manual
`install-player.sh --upgrade` (README, "Upgrading a player in place") to get
the update scripts, the sudoers entries, the post-check timer and the
`RELEASE` file; from then on they update remotely.

**Not covered by the automated tests.** The player tests cover the command's
invocation shape, parsing and reporting of `update-status.json`, the auto
window with a frozen clock and the no-double-run guard; the cloud tests cover
the commands, settings validation, the manifest key, sync storage and page
rendering; the shell scripts are checked with `bash -n`. A real update,
including the rollback path, the systemd timer and the `apt-get` run, needs
a Pi. Verify on one device, after the manual `install-player.sh --upgrade`
has written `RELEASE`: `update-player` at the current ref (expect
`already at <sha>`), then at a ref one commit ahead (expect
`updated <old> -> <new>` and the post-check "ok" line in `update.log` two
minutes later), then `update-os`, before using **Update all players**.

## D. Camera zero-config (cloud + player)

**What it does.** The Wyze account that all the room cameras hang off is
entered once, on the cloud console's Settings page, and every player fetches
its own camera configuration from the console instead of having credentials
typed into `wyze.env` on each Pi. A freshly enrolled device whose Wyze camera
is named after the device starts sending snapshots on its first boot with no
one touching the Pi. RTSP cameras get the same treatment: the stream URL is
set per device on the Devices page and travels to the Pi the same way. Cloud
only; on a Python console the camera is configured by hand as described in
[camera.md](camera.md).

**Settings** (Settings page, admin, "Wyze account" section):

| Setting | Stored as | Meaning |
|---|---|---|
| Wyze email | secret `wyze_email` | The account the cameras are paired with (or shared to). |
| Wyze password | secret `wyze_password` | Its password. |
| API key id | secret `wyze_api_id` | The **API ID** from the Wyze developer portal. |
| API key | secret `wyze_api_key` | The **API key** from the same portal (shown once there). |
| Camera name pattern | setting `wyze_camera_pattern` | How a device's Wyze camera is named in the Wyze app; default `{device_name}`. |

The four secrets live in a D1 table `secrets(name, value)`. Each value is
encrypted with AES-GCM under a key derived (HKDF, info `p5k-secrets`) from
the worker's existing `SESSION_SECRET`, so nothing readable sits in the
database and no new worker secret is needed. The console never renders a
stored value back: each field shows only **set** or **not set**, and a
Replace form overwrites it. There is no "reveal". Rotating `SESSION_SECRET`
makes the stored values undecryptable: re-enter the four Wyze fields
afterwards (the page shows them as not set once decryption fails).

**Camera name pattern.** `{device_name}` is replaced with the device's name
as shown on the Devices page; `{device_id}` is the device id. With the
default pattern, a device called `Lobby projector` expects a Wyze camera
called `Lobby projector`. The player turns that into the bridge's stream name
the same way as before (lowercased, spaces to dashes: `lobby-projector`), so
name cameras in the Wyze app to match the console, or set the name per
device instead.

**Per-device override** (Devices page, existing Camera block, editor and
above):

| Field | Values |
|---|---|
| Camera source | `default`, `none`, `wyze` or `rtsp` |
| RTSP URL | required when the source is `rtsp`; the stream URL with any camera credentials inside, as in camera.md Option A |
| Wyze camera name | used when the source is `wyze`; empty means "apply the pattern" |

`default` follows the site: `wyze` with the pattern-derived name once the
Wyze email and password are set, `none` until then. Set `none` on a device that
has no camera so its bridge stays down; set `rtsp` for a non-Wyze camera.
Changes are audited (`device_set_camera_source`).

**Device API.** `GET /api/camera-config/<device_id>` with the device's bearer
token returns `{source: "none", version: 3}`,
`{source: "rtsp", rtsp_url: "rtsp://...", version: 3}` or

```json
{"source": "wyze", "version": 3, "wyze": {"email": "...", "password": "...",
 "api_id": "...", "api_key": "...", "camera": "Lobby projector"}}
```

Every answer carries `version`, the `camera_config_version` it was built
from. This is
the only route that ever sends the Wyze credentials anywhere, and only to a
device that authenticates as itself; it answers 401 to anything else. A
`camera_config_fetched` audit entry is written at most once per device per
day, so the log shows which Pis picked the configuration up without filling
on every boot.

The manifest gains an optional integer `camera_config_version`. The console
bumps it whenever anything that feeds the endpoint changes: a Wyze secret,
the pattern, or a device's source, URL or camera name. Renaming a device
(re-enrolling under a new name) does not bump it: a camera named after the
device is picked up on the next bump or daemon restart.

**What the Pi does.** On daemon start, and on any sync where the manifest's
`camera_config_version` differs from the version it applied last (kept in
memory; every daemon start fetches again), the player calls the endpoint and
applies the answer without restarting itself:

1. Writes `/var/lib/projector-player/wyze.env` (mode 600, owned by
   `projector`): `WYZE_EMAIL`, `WYZE_PASSWORD`, `API_ID`, `API_KEY`. The
   bridge unit now reads its `--env-file` from there rather than from
   `/etc/projector-player/wyze.env`, which the daemon (running as
   `projector`) could not write. The installer moves an older
   `/etc/projector-player/wyze.env` to the new path when it finds one.
2. Runs `sudo -n systemctl restart projector-wyze-bridge.service` (allowed
   by the sudoers drop-in `/etc/sudoers.d/projector-player`) when the source
   is `wyze`, so the bridge logs in with the new credentials; with `none` or
   `rtsp` the bridge is left alone.
3. Swaps its in-memory `[camera]` configuration: the running capture thread
   is re-pointed at the new source, URL or derived stream name, and the
   version is remembered so the next sync is a no-op.

The `[camera]` table in `/etc/projector-player/config.toml` is now only a
fallback for a console that does not send `camera_config_version` (an older
console, or the Python console); the fetched configuration wins whenever the
manifest carries the key. A player that never sees the key behaves exactly as
before. If the fetch fails (console unreachable, 401), the player keeps its
current camera configuration, logs a warning in
`journalctl -u projector-player.service`, and retries on the next sync that
still shows a different version. A failed apply (the env file could not be
written, or the bridge restart outran its 30 s budget) is handled the same
way and also shows up as `camera_error` on the Devices page; the daemon
never stops over it.

**Installer and flasher.** `install-player.sh --with-wyze` still installs
Docker and `projector-wyze-bridge.service`, but no longer needs the `WYZE_*`
variables: no empty template is written, the unit tolerates a missing env
file, stays enabled, and is started by the daemon once it has fetched
credentials (the installer pre-pulls the bridge image so that first restart
does not wait on the download). `--upgrade` refreshes the wyze unit whenever
it is installed. The flasher's
provision script passes `--with-wyze` automatically when
`GET /api/operator/enrollment` reports `wyze_configured: true` (section B),
which it does once the Wyze email and password are set. So the order for a new
site is: enter the Wyze account on the Settings page first, then flash. Cards
flashed before the account was entered come up without Docker; run
`sudo bash deploy/install-player.sh --with-wyze --upgrade` on those Pis once
(or re-flash). Players installed before this feature need the same one-off
`--upgrade` to get the moved env-file path, the extra sudoers line and the
fetch logic.

**Operator steps** (once per site):

1. Create or pick the Wyze account the cameras are paired with. An account
   without two-factor auth, with the cameras shared to it, is the simplest;
   the bridge cannot complete a 2FA login on its own (camera.md, "Wyze API
   key").
2. Sign in at <https://developer-api-console.wyze.com/> with that account
   and create an API key. Copy the **API ID** and the **API key** now; the
   key is shown once and expires after a year, so put a reminder in your
   calendar: when it lapses every bridge stops logging in and the Devices
   page shows `Connection refused` camera errors across the fleet. Replace
   the key on the Settings page and every Pi picks it up on its next sync.
3. Cloud console, Settings, "Wyze account": enter email, password, API ID
   and API key, and leave the pattern at `{device_name}` unless your cameras
   are named some other way. Save. The section now shows four **set**
   badges and `wyze_configured` turns `true` for the flasher.
4. In the Wyze app, name each camera exactly as its device is named on the
   Devices page (or set the name per device in the Camera block).
5. Flash the cards. The provision script installs the bridge, the daemon
   fetches the configuration on its first sync, and the snapshot appears on
   the device tile within a minute or two of the bridge logging in.

**Python console.** `cms/` has no secrets store and does not serve
`/api/camera-config`: configure the camera on each Pi by hand
([camera.md](camera.md)), writing `wyze.env` to
`/var/lib/projector-player/wyze.env` on players installed from this branch.

**Not covered by the automated tests.** The cloud tests cover the
encryption round trip, the endpoint's bearer gate, the daily audit cap and
the version bump on each kind of change; the player tests cover the fetch
and apply path with a fake console, fake `systemctl` and a temporary data
directory. What needs a Pi: the bridge actually logging in with the fetched
credentials and the RTSP stream name matching the pattern. Verify on one
device: set the account, watch `journalctl -u projector-player.service -f`
for the fetch on the next sync, then `journalctl -u
projector-wyze-bridge.service -n 50` for the login and the camera name, then
the snapshot on the tile.

## E. Projector power (player + cloud + cms)

**What it does.** The console turns the projector on and off. Each device
has a Projector block on the Devices page with On and Off buttons, and an
auto mode that switches the projector on a few minutes before content is
due and off once nothing has been scheduled for a while, so a room that
plays 09:00-17:00 on weekdays has its projector powered only then, with
nobody carrying a remote. Two ways to drive the projector are supported:

- **Broadlink** (IR): the Broadlink RM4 mini from [hardware.md](hardware.md),
  on the same LAN as the Pi with line of sight to the projector's IR
  receiver. The IR codes are learned once per projector model from the
  console; the Broadlink app is only needed to get the blaster onto Wi-Fi.
- **CEC** (HDMI): projectors that honour HDMI-CEC are driven over the HDMI
  cable already in place, with no extra hardware. Support is patchy across
  projector brands, so treat it as the option to try first and fall back to
  IR when the projector ignores it.

Both consoles carry the feature; the Python console (`cms/`) has the same
routes and markup for LAN-only sites.

**Per device** (Devices page, Projector block, editor and above):

| Field | Column | Values |
|---|---|---|
| Control | `projector_control` | `none` (default), `broadlink` or `cec` |
| Mode | `projector_power_mode` | `manual` (default) or `auto` |
| Broadlink host | `broadlink_host` | optional IP of the RM4 mini; empty means discover it on the LAN |
| Learned codes | `projector_ir_codes` | JSON `{power_on, power_off, input_hdmi1}` of base64 Broadlink packets, filled by learning (below); shown as badges |
| State | `projector_power_state`, `projector_error` (both consoles; the player reports them as the sync query params `projector_state` / `projector_error`) | `on`, `off` or `unknown` plus the last error, reported by the player, best effort; shown as a lamp and an error line |

Beside the selects sit **On** and **Off** buttons and, for Broadlink, a
**Learn Power On**, **Learn Power Off** and **Learn Input HDMI1** button
each. The state lamp shows what the player last sent, not a measurement:
neither IR nor CEC reads the projector's real state back, so after someone
powers the projector at the wall the lamp is wrong until the next command.
A device whose control is `none` shows no buttons and ignores the mode.

**Settings** (Settings page, admin):

| Setting | Key | Values |
|---|---|---|
| Projector lead time | `projector_lead_minutes` | minutes before a scheduled start to switch on; default 3 |
| Projector idle-off delay | `projector_idle_minutes` | minutes with nothing scheduled before switching off; default 10 |

Both are site-wide and only matter for devices in `auto` mode.

**Commands.** Three shapes in the `device_commands` CHECK list (admitted by
migration 0003 together with the update commands of section C; the table is
not rebuilt again), issued and delivered like `reboot` and audited like the
other commands:

| Command | What the player does |
|---|---|
| `projector-on` | sends the `power_on` code (Broadlink) or `cec-ctl --to 0 --image-view-on` (CEC) |
| `projector-off` | sends the `power_off` code (Broadlink) or `cec-ctl --to 0 --standby` (CEC) |
| `ir-learn:<name>` | puts the RM4 mini into learning mode for 30 s and returns the captured packet as base64 in the command result; `<name>` is `power_on`, `power_off` or `input_hdmi1` |

The result of `projector-on` / `projector-off` is `projector on sent via
broadlink` (or `cec`) or `projector-on failed: <reason>` (no blaster found on
the LAN, Broadlink auth failed, no `power_on` code learned yet, `cec-ctl`
missing or timing out). The player retries a failed send once, immediately,
before reporting the failure. An `ir-learn:<name>` result is the JSON
`{"learned": "<name>", "code": "<base64>"}`; the console stores the code in
`projector_ir_codes` under that name and the matching badge lights up. A
result of `ir-learn <name> failed: nothing learned in 30 s` (or no blaster)
leaves the stored codes alone. Learning blocks the player's poll for up to
30 s, so the next sync is late by that much; nothing else is affected.

**Learning flow** (once per projector model):

1. Set Control to `broadlink` on the device and save. Fill in the Broadlink
   host if the RM4 mini sits on another subnet than the Pi: discovery is a
   LAN broadcast and does not cross routers.
2. Click **Learn Power On**. The console queues `ir-learn:power_on` and
   shows a 30 s countdown hint; the player picks the command up on its next
   poll (within 30 s) and the RM4 mini's indicator lights while it listens.
3. Hold the projector's own remote in front of the RM4 mini and press its
   power button once, inside the 30 s. Some remotes have separate on and
   off buttons, some a single toggle. With a toggle, learn the same button
   as both `power_on` and `power_off`; auto mode still behaves, because the
   player only sends a code when the wanted state changes, never blindly.
   (The one weak spot: a send that half-fails and is retried can toggle the
   projector straight back. Discrete on and off buttons, where the remote
   has them, are the safer choice.)
4. When the command result arrives (next poll), the **power_on** badge
   appears. Repeat for **Learn Power Off** and, if the projector has to be
   told which input to show after powering on, **Learn Input HDMI1**.
5. Click **On** and **Off** once each to prove the codes work from the
   console before switching the device to `auto`.

The learned packets are plain base64 strings and identical for every
projector of the same model, but the Projector block has no codes input:
each device learns its own codes. Learning always needs the physical
remote; the console cannot invent a code and ships no library of them.

**CEC option.** Set Control to `cec`; nothing to learn. The player runs
`cec-ctl` (package `v4l-utils`, installed by `install-player.sh`) on the
Pi's HDMI0 CEC adapter `/dev/cec0`: it first claims a playback logical
address (`--playback -S`; a fresh adapter is unregistered and the projector
ignores standby from an unregistered source), then addresses the projector
as logical address 0, the display. On the projector, HDMI-CEC is usually
off by default and hides in the menu under a brand name (`HDMI Link`,
`HDMI Control`, `Anynet+`, `BRAVIA Sync`, `SimpLink`, `VIERA Link`): turn
it on, plus any separate "power on by HDMI" and "power off by HDMI"
toggles. Then click **On** and **Off** from the console. If the projector
ignores one of them (waking from deep standby is the usual failure, because
the projector's HDMI port is unpowered while it is off), switch that device
to Broadlink. The Pi must be on HDMI0 (the port next to USB-C), as
[hardware.md](hardware.md) already asks.

**Auto mode.** The manifest gains an optional `projector` key:
`{control, mode, want, codes, broadlink_host}`, or `null` when the device's
control is `none`. The console computes `want` on every sync
(`manifest.projector_want`) from the same schedule rows that pick the
playlist, using `schedules.next_start` (the rule the Python console already
had and the cloud console now ports):

- `want = "on"` while a playlist is active for the device, from the lead
  time (default 3 min) before the next schedule rule starts, and until the
  idle-off delay (default 10 min) has passed since a playlist was last
  active. A gap between two schedules shorter than the delay therefore never
  cycles the lamp.
- `want = "off"` otherwise.

The player acts only on a change of `want` (an `on` seen twice sends
nothing) and reports the outcome in the `projector_state` and
`projector_error` sync parameters, which the Devices page shows as the lamp
and, when set, an error line. `projector_error` clears on the next
successful send; a transition that failed (after its one immediate retry)
is not tried again until `want` changes, so the error stays visible until
someone fixes the blaster or the next scheduled change comes round. The
object carries `want` in `manual` mode too, but the player then ignores it
and only acts on the On/Off commands. A player that never sees the key
(older console, control `none`) does nothing, like every other manifest key
in this branch.

Two consequences of the "playlist active" rule to plan around:

- A device with a fallback playlist assigned (its own or its group's) and no
  schedules is active around the clock, so in auto mode its projector never
  turns off. To have the projector power down, drive that device by
  schedules alone: clear the fallback playlist and add a schedule for the
  hours it should play. The gap in the schedule is what switches it off.
- The lead time is measured on the console's clock in the site timezone
  (Settings), like the schedules themselves; the player's poll interval
  (30 s) comes on top. Three minutes covers most projectors' warm-up; raise
  it for a lamp projector that takes longer to show a picture.

With the defaults: a schedule starting at 09:00 flips `want` to `on` at
08:57 and the code goes out on the player's next poll; content ending at
17:00 flips `want` to `off` at 17:10 and the projector powers down within
the following poll. `input_hdmi1` is learned and stored for projectors that
need it, but nothing sends it yet: leave the projector on the Pi's input, or
set the projector to remember its last input across power cycles.

**Wyze Plug.** The smart plug from hardware.md stays as the hard
power-cycle of last resort from the Wyze app; the console does not drive
it. Leave it on: a projector whose mains are cut cannot be reached by IR or
CEC.

**Python console (cms).** Same Projector block on the Devices page and the
same commands/manifest key; the global lead time and idle-off delay come from
`/etc/projector-cms/env`: `PIPLAYER_PROJECTOR_LEAD_MINUTES` (default 3) and
`PIPLAYER_PROJECTOR_IDLE_MINUTES` (default 10), integers 0-1440; restart the
CMS to apply. The manifest `projector` key is null until a device has a
control other than none. The `db.py` ALTER guards add the six device columns
on start.

**Operator steps** (once per projector):

1. Broadlink only: pair the RM4 mini in the Broadlink app on the 2.4 GHz
   network, then in the blaster's settings in the app make sure **Lock
   device** is off (a locked blaster refuses LAN control from anything but
   the app; the player logs an auth failure when it finds one). Note its IP
   if the router hands different subnets to Wi-Fi and wired clients, and
   enter it as the Broadlink host.
2. CEC only: enable HDMI-CEC in the projector's menu as above.
3. Devices page, Projector block: choose the control, learn the codes
   (Broadlink), test **On** and **Off**, then set Mode to `auto` if the
   device is driven by schedules.
4. Settings page: adjust the lead time and idle-off delay if the defaults do
   not suit the projector's warm-up and the site's schedule gaps.

Players installed before this feature need one `install-player.sh --upgrade`
(README, "Upgrading a player in place") to get the `broadlink` Python package
(`player/requirements.txt`) and `v4l-utils`; `update-player` from section C
does the same.

**Logs on the Pi** when a command reports `failed`:

```bash
journalctl -u projector-player.service -n 100 | grep -i projector
cec-ctl -d /dev/cec0 --playback -S            # CEC: claim an address; does the projector answer at all?
cec-ctl -d /dev/cec0 --to 0 --image-view-on   # CEC: power on by hand
cec-ctl -d /dev/cec0 --to 0 --standby         # CEC: power off by hand
```

**Not covered by the automated tests.** The player tests use a fake
`broadlink` module and a fake `cec-ctl` (discovery, auth, send, learning
with and without a captured packet, the immediate retry, act-on-change,
state and error reporting); the console tests cover the commands, the
per-device fields, the stored codes and the `want` computation with fixed
clocks. What needs a room: an RM4 mini actually hearing the remote and the
projector reacting to the packet or the CEC message. Verify on one device:
learn `power_on` and
`power_off`, press **Off** with the projector on and **On** with it off, then
set `auto` and watch one scheduled start and one scheduled end before
rolling the mode out to the fleet.

## F. Alerts (cloud only)

**What it does.** The cloud console watches the fleet for you. Every five
minutes a cron job in the worker checks each device against a fixed list of
conditions (offline, mpv down, no recent screenshot, a reported error, a
failed update) and sends a message when a problem appears and again when it
goes away, by email, by a webhook (Slack, Discord, ntfy or anything that
accepts a JSON POST) and/or by SMS through Twilio. An `/alerts` page lists
what is open now and what cleared recently, and the dashboard shows a count
badge while anything is open. Cloud only: the Python console has no cron and
no outbound mail, so on a LAN-only site keep an eye on the dashboard tiles.

**Conditions.** Each is evaluated per device on every run; a device can
have several open at once.

| Kind | Opens when | Closes when |
|---|---|---|
| `offline` | `last_seen` is older than **Offline after** (`alert_offline_minutes`, default 10) | the device syncs again |
| `mpv-down` | the last sync reported `player_status = mpv-down` | any other status is reported |
| `screenshot-stale` | the device is online but its last screenshot upload is older than 3 × the site's screenshot interval (Settings) | a screenshot arrives |
| `sync-error` | `last_error` is set (the "Sync problem" line on the Devices page) | the player reports a clean sync |
| `update-failed` | the last remote update reported `ok = 0` (section C) | the next update reports ok |
| `camera-error` | `camera_error` is set (section D) | it clears |
| `projector-error` | `projector_error` is set (section E) | it clears |

While a device is offline nothing else is evaluated for it: the other
columns are frozen at their last sync, so those alerts neither open nor
close until the device is back (`offline` already covers it). A device that
has never uploaded a screenshot (no `last_screenshot_at`) is not stale, just
new, and a device that has never synced at all (`last_seen` empty, the row
created by enrollment seconds ago) is skipped by `offline` too. **Offline
after** is never applied below the Devices page's own 3-minute offline
threshold.

**Dedupe, recovery and reminders.** Alerts live in a D1 table
`alerts(id, device_id, kind, opened_at, closed_at, notified_at)`. There is
at most one open row per (device, kind): a condition that stays true from
one run to the next does nothing; when it turns false the row's `closed_at`
is set and it is reported under RECOVERED; when it turns true again a new
row opens. While a row stays open, the console mentions it again once every
**Repeat while open** (`alert_repeat_minutes`, default 240, so four hours;
0 turns reminders off) so a projector that has been dark since Friday is
still mentioned on Monday. Both settings are site-wide. A run sends **one
digest** per channel, not one message per alert: everything that opened,
recovered or is still open past the repeat interval in that run goes out
together, so five projectors going offline together is one message with
five lines. A run with nothing to say sends nothing. The digest is plain
text in three blocks, each headed by a count and listing one line per
alert as `<device name> (<device_id>): <kind text> since <opened_at> UTC`:

```
ALERT 2
Lobby projector (pi-lobby): offline (no sync) since 2026-09-16 09:41:00 UTC
Bar (pi-bar): camera error since 2026-09-16 09:41:00 UTC
RECOVERED 1
Foyer (pi-foyer): player process down since 2026-09-16 08:10:00 UTC
STILL OPEN 1
Roof (pi-roof): no new screenshot since 2026-09-15 22:00:00 UTC
```

The kind texts are `offline (no sync)`, `player process down`, `no new
screenshot`, `sync error`, `remote update failed`, `camera error` and
`projector error`. The subject (email subject, webhook `title`, first SMS
line) is `Projection5000: <n> opened, <m> recovered, <k> still open`, with
the zero parts left out. Opening and closing are audited per alert
(`alert_opened`, `alert_closed`, target the device, details `{kind}`); a
channel that fails is audited `alert_notify_failed` (target the channel,
details the error) and not retried, the next reminder covers it, so
`/audit` answers "did the SMS go?".

**Cron.** `wrangler.toml` `[triggers]` now carries two schedules,
`"0 3 * * *"` (the existing daily housekeeping) and `"*/5 * * * *"`; the
worker's `scheduled()` dispatches on `event.cron`, so the alert evaluator
runs every five minutes and housekeeping still runs once a night. 8,640
extra invocations a month, well inside the free plan. In local development
run `npx wrangler dev --test-scheduled` and hit
`http://localhost:8787/__scheduled?cron=*/5+*+*+*+*` to force a run.

**Settings** (Settings page, admin, "Alerts" section):

| Setting | Stored as | Meaning |
|---|---|---|
| Offline after | setting `alert_offline_minutes` | minutes without a sync before `offline` opens; default 10, range 1-1440 |
| Repeat while open | setting `alert_repeat_minutes` | minutes between reminders for an alert that is still open; default 240, range 0-10080; 0 = open and recovered only |
| Email to | setting `alert_email` | comma-separated recipients; every one must be a verified Email Routing destination (below); empty = channel off |
| Webhook URL | setting `alert_webhook_url` | an `https://` URL that accepts a JSON POST; empty = channel off |
| Twilio Account SID | secret `twilio_account_sid` | `AC...` from the Twilio console |
| Twilio Auth Token | secret `twilio_auth_token` | the account's auth token (or an API key secret) |
| Twilio From | secret `twilio_from` | the Twilio number in E.164 (`+441234567890`) or a Messaging Service SID (`MG...`) |
| Twilio To | secret `twilio_to` | the phone to text, E.164; one number |

The four Twilio values sit in the same encrypted `secrets` table as the Wyze
account (section D: AES-GCM under a key derived from `SESSION_SECRET`,
shown only as **set** / **not set**, replaced by re-entering, all four lost
if `SESSION_SECRET` is rotated). SMS is off until all four are set. Saving
the section is audited `alert_settings_update` (credentials logged as
`set`, never their values). Each channel has a **Send test** button next to
it (disabled until that channel is configured) that sends a plain test
message, subject `Projection5000: test alert`, through that channel alone
and shows the provider's answer on the page (the Email Routing "destination
not verified" error and Twilio's `21608` "unverified number" on a trial
account both show up here, so test before you need it). Tests are audited
(`alert_test_sent`).

**Email.** Sent through the Cloudflare `send_email` binding declared in
`wrangler.toml` as `[[send_email]] name = "ALERT_MAIL"`, from
`alerts@photogen5000.com` (`From: Projection5000 alerts <alerts@...>`),
subject `Projection5000: <n> opened, <m> recovered, <k> still open`, plain
text body = the digest lines above, nothing else (no links; open `/alerts`
or the Devices page for detail). The binding takes exactly one recipient
per message, so **Email to** with three addresses is three sends of the
same mail, in the order listed; the first address the binding rejects (an
unverified one) stops the loop, the addresses after it are skipped for that
run, and the failure is audited once for the channel. Keep the list to
verified addresses. The binding has
two hard rules that shape the operator steps: the sender must be an address
on a zone with Email Routing enabled, and every recipient must be a
**verified destination address** of that zone's Email Routing. Sending to an
unverified address throws; the console reports it as a failed send and moves
on to the next channel. There is no per-message cost and no daily cap worth
worrying about at fleet-alert volumes.

**Webhook.** One `POST` per run with something to report,
`Content-Type: application/json`, `User-Agent: Projection5000-alerts`, a
10 s timeout, no retry (the next reminder covers a missed one). Body:

```json
{
  "site": "Projection5000",
  "title": "Projection5000: 1 opened, 1 recovered",
  "text": "Projection5000: 1 opened, 1 recovered\nALERT 1\nLobby projector (pi-lobby): offline (no sync) since 2026-09-16 09:41:00 UTC\nRECOVERED 1\nBar (pi-bar): camera error since 2026-09-16 08:10:00 UTC",
  "content": "Projection5000: 1 opened, 1 recovered\nALERT 1\nLobby projector (pi-lobby): offline (no sync) since 2026-09-16 09:41:00 UTC\nRECOVERED 1\nBar (pi-bar): camera error since 2026-09-16 08:10:00 UTC",
  "message": "ALERT 1\nLobby projector (pi-lobby): offline (no sync) since 2026-09-16 09:41:00 UTC\nRECOVERED 1\nBar (pi-bar): camera error since 2026-09-16 08:10:00 UTC"
}
```

`title` is the subject; `text` and `content` are the subject plus the
digest, so a Slack incoming webhook (reads `text`) and a Discord webhook
URL (reads `content`) both render it with no transformation; ntfy, when you
post to a topic URL, takes `title` and `message` (the digest without the
repeated subject). There is no per-alert structure and no `event` key: a
test send is the same shape with the test subject and text, and anything
that wants the individual alerts (Home Assistant, n8n, a Zapier catch hook)
splits `message` on newlines. The URL must be `https://` (saving an
`http://` URL is rejected with 400); redirects follow the worker's `fetch`
defaults, and any non-2xx answer is a failed send.

**SMS.** A single REST call per run to
`https://api.twilio.com/2010-04-01/Accounts/<AccountSid>/Messages.json`
(Basic auth `AccountSid:AuthToken`, form fields `From`, `To`, `Body`).
`Body` is the subject line followed by the digest, cut at 600 characters
(four GSM segments), so a big fleet failing at once ends mid-list: read the
rest on `/alerts`. Each run with news is one SMS at Twilio's per-segment
price, so a chatty fleet on a short repeat interval costs real money: leave
the repeat at four hours or raise it, and prefer the webhook for the noisy
kinds.

**Alerts page** (`/alerts`, any signed-in role, in the nav for everyone).
Two tables. **Open**: newest first, columns Device (name plus `device_id`),
Alert (the kind text as a badge), Opened, Open for and Last notified (or
`never`). **Recently recovered**: the 100 most recently closed rows, same
columns with Closed instead of Open for. Times are in the site timezone.
There is no detail column and no link to the device: the detail (the last
error text, the update message, last seen) is on the Devices page. The
dashboard's "open alerts" card shows the count and links here (`all clear`
at 0). Alerts are read-only: there is no acknowledge or mute, close the
condition instead (and to silence a device permanently, delete it: its
alerts are deleted with it). Closed rows older than 90 days are pruned by
the nightly housekeeping.

**Operator steps** (once per site). Only the channels you want; each is
independent.

*Email (Cloudflare Email Routing):*

1. Check whether `photogen5000.com` already receives mail somewhere (Google
   Workspace, Fastmail, the registrar). Enabling Email Routing replaces the
   zone's MX records with Cloudflare's, so an existing mailbox on the bare
   domain would stop receiving. If it does, either put the alert sender on a
   subdomain zone you control or route that mailbox through Email Routing
   too (it forwards to any verified address). The sender must be on a zone
   with Email Routing on.
2. Cloudflare dashboard, pick the account, **Websites**, `photogen5000.com`,
   left menu **Email**, **Email Routing**. Click **Get started** (or
   **Enable Email Routing** if the overview shows it disabled). The wizard
   asks for a first custom address and a destination; you can skip the
   address and add the destination in the next step. On the last screen
   click **Add records and enable** so Cloudflare writes the MX and SPF TXT
   records for you. The overview should then read "Email Routing is enabled"
   with the DNS records listed as configured; if it shows missing records,
   open the **Settings** tab and click **Add records automatically**.
3. Still under **Email Routing**, open the **Destination addresses** tab,
   click **Add destination address**, enter each operator email that should
   receive alerts, **Send verification email**. Open the mail Cloudflare
   sends and click **Verify email address**; the tab now shows the address
   as **Verified**. Repeat for every recipient. Unverified addresses are
   silently the reason a test send fails.
4. Optional but polite: **Routing rules** tab, **Create address**, custom
   address `alerts`, action **Send to an email**, destination one of the
   verified addresses. Replies to an alert then land in someone's inbox
   instead of bouncing. Alerts send fine without this rule.
5. Cloud console, Settings, "Alerts": enter the verified addresses in
   **Email to**, Save, then **Send test** next to it. The test mail arrives
   from `alerts@photogen5000.com` within a few seconds; check spam the first
   time and mark it as not spam.
6. Deploying the worker with the `[[send_email]]` block is what creates the
   binding; the dashboard shows it under the worker's **Settings**,
   **Bindings** as "Send email" once deployed. Nothing else is needed on the
   worker side: no API token, no secret.

*Webhook:*

1. Slack: create an Incoming Webhook for the channel (Slack app settings,
   **Incoming Webhooks**, **Add New Webhook to Workspace**) and copy the
   `https://hooks.slack.com/services/...` URL. Discord: channel settings,
   **Integrations**, **Webhooks**, **New Webhook**, **Copy Webhook URL**.
   ntfy: pick a topic name and use `https://ntfy.sh/<topic>` (or your own
   server). Anything else that takes a JSON POST works the same way.
2. Settings, "Alerts", **Webhook URL**, Save, **Send test**. The test message
   should appear in the channel within a second or two.

*SMS (Twilio):*

1. Twilio console, **Account Info** on the home page: copy the **Account
   SID** and the **Auth Token**. Buy or pick a number under **Phone Numbers**
   that can send SMS to your country and note it in E.164.
2. Sender registration: a US number needs A2P 10DLC or toll-free
   verification before it will deliver to US phones; in the UK and most of
   Europe a bought mobile number works as is. A **trial** account can only
   text numbers listed under **Verified Caller IDs** and prefixes every
   message with the trial notice; upgrade the account for a real fleet.
3. Settings, "Alerts": enter the SID, Auth Token, From and To, Save (the
   four show as **set**), **Send test**. Twilio's error text is shown on the
   page if the send fails; `21608` means the To number is not verified on a
   trial account, `21211` a malformed To, `21606` a From number the account
   does not own.

*Tuning:*

- The player syncs every 30 s by default, so **Offline after** at 10 min
  means many missed cycles plus slack; set it higher for sites on flaky
  links, and remember the 5-minute cron adds up to five minutes of latency
  to every open and close.
- **Repeat while open** at 0 is right for a channel that already tracks
  open items (a Slack thread, ntfy's list); leave it at 240 for email and
  SMS where a message scrolls away.

**Python console.** `cms/` does not evaluate conditions or send anything;
the dashboard tiles and the `last_error` / `camera_error` / `projector_error`
lines on the Devices page are the equivalent for a LAN-only site.

**Not covered by the automated tests.** The cloud tests run the evaluator
against a seeded database with a fixed clock (each condition opening,
staying open without a duplicate, closing with a recovery, the reminder at
`alert_repeat_minutes`, the offline / stale interaction), check the three
channel payloads with `fetch` and the mail binding replaced by fakes (the
webhook JSON above, the Twilio form body and auth header, the mail
envelope), the settings validation (400 on an `http://` webhook, on
non-integer minutes) and the `/alerts` page render and dashboard badge.
What needs the real account: Cloudflare accepting the sender and the
verified destinations, and Twilio delivering. Verify once after deploying:
Settings, **Send test** on each channel, then unplug one Pi and wait up to
`alert_offline_minutes` plus five minutes for the `offline` message, plug
it back in and wait for the `RECOVERED` one.

## G. Live camera without manual tunnel (cloud + player)

**What it does.** The **Live** view in camera.md needs a Cloudflare Tunnel
from each Pi to a hostname with Cloudflare Access in front, which until now
meant `cloudflared tunnel login`, a config file and an Access application
per device, by hand. With this feature the cloud console does all of that
through the Cloudflare API: when a device enrolls (or when you click
**Create tunnel** on the Devices page) the console creates the tunnel, the
DNS record and the Access application, hands the tunnel token to the Pi in
its manifest, and fills in **Camera live URL** itself. The Pi runs
`cloudflared` as a service and picks the token up on its next sync. Nothing
is typed on the Pi and nothing is clicked in the Cloudflare dashboard after
the one-time setup below. Cloud only: the Python console keeps the manual
live URL ([camera.md](camera.md), "Live view").

**Worker secrets.** Three secrets on the worker turn the feature on; without
them the Settings panel **Camera tunnels (Cloudflare)** carries the badge
**not configured** and names the missing secrets, the **Create tunnel**
button is not rendered (the Camera block says to paste a live URL instead),
enrollment skips the tunnel step, and the manual **Camera live URL** field
keeps working exactly as before.

| Secret | Value |
|---|---|
| `CF_API_TOKEN` | a Cloudflare API token with the three permissions listed under Operator steps |
| `CF_ACCOUNT_ID` | the Cloudflare account that owns the zone and the Zero Trust organisation |
| `CF_ZONE_ID` | the zone id of `photogen5000.com`, where the `<device_id>-cam` hostnames are created |

None of them is stored in D1 or shown in the console; the Settings panel
only says whether all three are present (badge **configured**), which
operator emails the Access policy will get, and how many devices have a
tunnel. The zone name in the hostnames is `photogen5000.com`; a
`CF_ZONE_NAME` var in `wrangler.toml` overrides it (it must be the zone
`CF_ZONE_ID` names).

**What the console creates**, per device, all idempotent (an object that
already exists with the right name is reused, so **Create tunnel** can be
clicked again after a partial failure and only the missing pieces are
made):

| Object | Name / value |
|---|---|
| Cloudflare Tunnel (remotely managed) | `p5k-<device_id>` |
| Tunnel configuration | ingress `<device_id>-cam.photogen5000.com` → `http://127.0.0.1:5000`, then the catch-all `http_status:404` |
| DNS record in the zone | CNAME `<device_id>-cam.photogen5000.com` → `<tunnel_id>.cfargotunnel.com`, proxied |
| Access application (self-hosted) | name `p5k-<device_id> camera`, domain `<device_id>-cam.photogen5000.com`, 24 h session, one **Allow** policy named `p5k operators` listing the operator emails |

Port 5000 is the wyze-bridge web player on the Pi (section D installs the
bridge; an RTSP camera needs something of your own listening there, as in
camera.md). Device ids are already lowercase letters, digits and hyphens, so
every `<device_id>-cam` is a valid hostname label.

The Access policy's email list comes from the Settings page: **Email to**
(`alert_email`, section F) doubles as the operator list. If it is empty the
console falls back to the admin users' usernames, provided every one of
them is an email address; if neither gives a list, tunnel creation stops
with a message asking you to fill in **Email to** first, and nothing is
created (the hostname must never go up without a policy in front of it,
because the bridge player has no login of its own). The policy is rewritten
on every provision, so after changing the list click **Recreate tunnel**
(the button's label once a device has a tunnel; it asks for confirmation,
reuses the existing objects and resets the live URL to the tunnel) on each
device, or edit the policy in Zero Trust. The button needs the editor or
admin role.

**What the console stores.** `devices.tunnel_id` and
`devices.tunnel_hostname`, shown in the Camera block, plus
`camera_live_url` set to `https://<tunnel_hostname>/` so the existing
**Live** and **Show live** buttons work unchanged (you can still overwrite
the URL by hand; only **Create tunnel** / **Recreate tunnel** and
enrollment write it). The tunnel token is not stored or cached: on every
sync of a device with a `tunnel_id` the console fetches the token from the
Cloudflare API and puts it in that device's manifest as

```json
{"tunnel": {"token": "eyJ...", "hostname": "pi-lobby-cam.photogen5000.com"}}
```

The manifest is only ever served to the device's own bearer token, so the
tunnel token goes to the Pi it belongs to and nowhere else; it is never
rendered in the console and never written to the audit log. The key is
on every sync: a device without a tunnel gets `"tunnel": null`, and so does
one whose token fetch failed (Cloudflare API down or the token revoked) or
a console without the three secrets; null = feature off, the Pi keeps the
token it already has. Creation is audited against the device as
`device_tunnel_created` (details: `device_id`, `tunnel_id`, `hostname`,
the number of emails in the policy) and a failed creation as
`device_tunnel_failed` (details: the Cloudflare error, prefixed with the
API call that was refused), so `/audit` answers "why is there no tunnel
for the bar Pi". On the Devices page the same outcome is a banner:
**Tunnel ready: https://...** or **Tunnel creation failed: ...**. A device
that re-enrolls (a reflashed card) without a tunnel gets one then, like a
first enrollment.

**What the Pi does.** The installer (`install-player.sh`, also on
`--upgrade`) installs `cloudflared` for arm64 from Cloudflare's apt
repository (`pkg.cloudflare.com`), falling back to the `.deb` from the
GitHub releases page when the repository cannot be added, and installs
`projector-cloudflared.service`, which runs `cloudflared tunnel run` with
the token read from `/var/lib/projector-player/tunnel.token` and is
enabled but stays stopped while the file is missing. On any sync whose
manifest carries `tunnel.token`, the daemon writes the token to
`/var/lib/projector-player/tunnel.token` (mode 600, owned by `projector`)
and, if the token changed, runs
`sudo -n systemctl restart projector-cloudflared.service` (a new line in
the sudoers drop-in `/etc/sudoers.d/projector-player`, next to the
wyze-bridge one). An unchanged token is a no-op, so the service is not
bounced on every sync. A player talking to a console that never sends the
key (the Python console, or the cloud console without the three secrets)
leaves the service stopped and behaves exactly as before. Players installed
before this branch need one `sudo bash deploy/install-player.sh --upgrade`
to get `cloudflared`, the unit and the sudoers line.

**Viewing.** Open **Live** in a new tab first: the hostname is behind
Cloudflare Access, which shows its login page and, with the default
identity provider, emails a one-time PIN to the address you enter; only the
addresses in the policy get one. Once you are through, **Show live**
(the inline iframe on the Devices page) works in the same browser, because
the Access cookie is set for the hostname. The iframe itself cannot show
the login page (it is sandboxed and sends no referrer), so a blank or
"login" iframe always means "open Live in a tab and sign in first". The
console's own login is separate from Access; being signed in to
`projectors.photogen5000.com` does not sign you in to the camera hostnames.

**Operator steps** (once per site):

1. **Zero Trust organisation.** In the Cloudflare dashboard open **Zero
   Trust** once and, if asked, pick a team name and the Free plan (up to
   50 users). Access applications cannot be created by the API until the
   account has this. While there, check **Settings → Authentication →
   Login methods** lists **One-time PIN** (it does by default); that is how
   operators will sign in to the camera pages.
2. **Account and zone ids.** Dashboard → **Websites → photogen5000.com →
   Overview**; the right-hand **API** panel shows **Zone ID** and
   **Account ID**. Copy both.
3. **API token.** Dashboard → profile menu → **My Profile → API Tokens →
   Create Token → Create Custom Token**. Name it `projection5000-tunnels`
   and add exactly these three permissions:

   | Type | Item | Level |
   |---|---|---|
   | Account | **Cloudflare Tunnel** | **Edit** |
   | Account | **Access: Apps and Policies** | **Edit** |
   | Zone | **DNS** | **Edit** |

   Under **Account Resources** include your account; under **Zone
   Resources** choose **Specific zone → photogen5000.com**. Leave client IP
   filtering and TTL empty (the worker calls from Cloudflare's own network
   and the token must not expire silently). **Continue to summary → Create
   Token**, and copy the token now; it is shown once.
4. **Put the three values on the worker** from `cloud/` on your machine
   (each command prompts for the value; nothing goes into a file or the
   repository):

   ```powershell
   cd cloud
   npx wrangler secret put CF_API_TOKEN
   npx wrangler secret put CF_ACCOUNT_ID
   npx wrangler secret put CF_ZONE_ID
   ```

   `wrangler secret put` targets the deployed worker and takes effect on
   the next request, no redeploy needed. Rotate the token the same way
   (create a new one, `secret put` it, then delete the old one in the
   dashboard).
5. Cloud console, **Settings**: the tunnel section now reads
   **configured**, and **Email to** holds the addresses that may open the
   camera pages (the same list the alerts go to; add colleagues who need
   the camera but not the alerts and they will get both, or leave the field
   empty and let the admin usernames stand in).
6. Flash cards as usual (section B). Each new device gets its tunnel at
   enrollment; on the Devices page the Camera block shows the hostname and
   a **Live** button within a minute of the first sync. Devices enrolled
   before the secrets were set: expand the Camera block and click
   **Create tunnel** once each (a reflash does it too, since re-enrollment
   provisions a device that has no tunnel).

**Removing a device** does not delete its tunnel, DNS record or Access
application (the worker only ever creates); delete them in the dashboard
(**Zero Trust → Networks → Tunnels**, **DNS → Records**, **Zero Trust →
Access → Applications**) when you retire a Pi, or leave them: an unused
tunnel with no connector is harmless and free.

**Not covered by the automated tests.** The cloud tests drive the API
client against a fake `fetch` (request shapes for tunnel, configuration,
DNS and Access; reuse of objects that already exist; a Cloudflare error
surfacing as the audited message; the manifest carrying `tunnel` only for
the device's own bearer), and `cloud/e2e/run_tunnel_e2e.py` runs the same
flow end to end through `wrangler dev` against an in-process fake of the
Cloudflare API (the `CF_API_BASE` var points the worker at it): enrollment
with and without an operator email, **Create** / **Recreate tunnel**, the
manifest block per bearer, a refusal mid-way and the retry. The player
tests cover the token file (contents,
mode 600), the restart through a fake `systemctl` and the no-op on an
unchanged token. What needs the real account: the API token's permissions
actually sufficing (a missing one shows up in the device's
`device_tunnel_failed` audit entry and the Devices banner as
`Cloudflare API POST /accounts/.../cfd_tunnel: Authentication error` or
similar, naming the call that was refused; fix the token in the dashboard
and click **Create tunnel** again), `cloudflared` on arm64
connecting, and Access issuing the PIN. Verify once on one Pi: **Create
tunnel**, wait for the next sync, `sudo systemctl status
projector-cloudflared.service` on the Pi should show `Registered tunnel
connection`, then **Live** in a new tab, the PIN, and the bridge player.
