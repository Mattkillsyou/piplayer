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
  always `false` until feature D lands; it then turns `true` once Wyze
  credentials exist, so the flasher's provision script can pass
  `--with-wyze`. The endpoint is read-only, answers only tokens whose user
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
| `update-all` | `update-player` then `update-os` |

Buttons for all three sit in each device's Recent commands area. The Devices
page header has **Update all players** (editor and above, with a confirm),
which queues `update-player` for every device using the release ref from
Settings. Each issue is audited.

**Settings** (Settings page, admin):

| Setting | Key | Values |
|---|---|---|
| Player release | `player_release` | git ref: tag, branch or commit sha; default `main` |
| Auto-update | `auto_update` | `off` (default) or `nightly` |
| Auto-update window | `auto_update_window` | `HH:MM-HH:MM` in the console timezone; default `03:00-05:00` |

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
lost. Then `update-player.sh <ref>` (root, allowed by the sudoers drop-in
`/etc/sudoers.d/projector-player` that `install-player.sh` writes; a
`/usr/bin/bash` prefix is accepted too) does, in order:

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
6. Restarts `projector-player.service` last.

The new daemon reads `update-status.json` on its first start after the
update and sends it to the console as the `update_status` query parameter of
its next sync. The console stores it in the device row's `last_update_at`,
`last_update_ok`, `last_update_message` and `last_update_ref` columns.

**Rollback.** The script arms a post-check (a systemd timer two minutes
after the restart, backed by `OnFailure` on the service). If the new daemon
fails to import or has exited within 60 s of starting three times, the
post-check moves `/opt/piplayer/player.prev` back into place, restarts the
service and writes a failed status with the reason, so the Devices page shows
the rollback and the Pi keeps playing on the previous code. The console does
nothing on its own: it only records what the Pi reports. To roll back by
hand, set `player_release` to the previous tag or sha and issue
`update-player` again.

**`update-os`.** `update-os.sh` runs `apt-get update`, `apt-get -y -o
Dpkg::Options::=--force-confold upgrade` (existing config files win over
package defaults) and `apt-get -y autoremove`, logging to the same
`update.log`. If `/var/run/reboot-required` exists afterwards the Pi reports
the result first and then reboots. Expect a few minutes of downtime on a slow
card; issue it inside the quiet window or use `auto_update`.

**Auto mode.** With `auto_update = nightly` the daemon checks on every sync:
if the local time is inside `auto_update_window`, and the last update attempt
(from `update-status.json`) started more than 20 hours ago, it runs
`update-player` with the manifest's `update.release`, exactly as if the
console had queued the command. The 20 h guard is what stops it re-running
every poll for the length of the window; with the ref unchanged the run is
the "already at <sha>" no-op anyway. Auto mode never runs `update-os`;
queue that yourself or with **Update all players**.

**What the console shows.** The Devices page shows `player_version` with the
short sha from `RELEASE` appended, and an update status per device: ok or
failed, the message, and when; failures are highlighted. Audit actions cover
every issue of the three commands, the fleet action, and each setting change.

**Logs on the Pi** when something needs a closer look:

```bash
sudo cat /var/lib/projector-player/update-status.json
sudo tail -n 100 /var/lib/projector-player/update.log
journalctl -u projector-player.service -n 100
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
README. Players installed before this feature need one manual upgrade
(README, "Upgrading a player in place") to get the update scripts, the
sudoers entries and the `RELEASE` file; from then on they update remotely.

**Not covered by the automated tests.** The player tests cover the command's
invocation shape, parsing and reporting of `update-status.json`, the auto
window with a frozen clock and the no-double-run guard; the cloud tests cover
the commands, settings validation, the manifest key, sync storage and page
rendering; the shell scripts are checked with `bash -n`. A real update,
including the rollback path, the systemd timer and the `apt-get` run, needs
a Pi: verify it on one device with `update-player` at the current ref (expect
"already at <sha>"), then at a tag one commit ahead, before using **Update
all players**.

## D. Camera zero-config (cloud + player)

Coming in this branch. Cloud-only; on a Python console the camera is
configured by hand as described in [camera.md](camera.md).

## E. Projector power (player + cloud + cms)

Coming in this branch.

## F. Alerts (cloud only)

Coming in this branch.

## G. Live camera without manual tunnel (cloud + player)

Coming in this branch. Cloud-only; on a Python console use the manual live
URL described in [camera.md](camera.md).
