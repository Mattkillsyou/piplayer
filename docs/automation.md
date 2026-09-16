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
settings). Sections marked "coming in this branch" are filled in as the
feature lands.

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

Coming in this branch.

## G. Live camera without manual tunnel (cloud + player)

Coming in this branch. Cloud-only; on a Python console use the manual live
URL described in [camera.md](camera.md).
