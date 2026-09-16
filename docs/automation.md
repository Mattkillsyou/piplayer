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
  immediately.
- `GET /api/operator/enrollment` with `Authorization: Bearer p5k_<token>`
  returns `{console_url, enrollment_key, groups: [{id, name}],
  playlists: [{id, name}], timezone, wyze_configured}`. `wyze_configured` is
  always `false` until feature D lands; it then turns `true` once Wyze
  credentials exist, so the flasher's provision script can pass
  `--with-wyze`. The endpoint is read-only, answers only tokens whose user
  is an admin or editor, and returns 401 for anything else: a missing or
  malformed header, an unknown or revoked token, or a viewer's token. The
  token's `last_used_at` is refreshed and an `api_token_used` audit entry is written
  at most once per hour per token, so the audit log shows who is flashing
  without filling up on every launch.

**Flasher.** On first run the tool asks for the console URL and an operator
token and stores them in `%APPDATA%\Projection5000\flasher.json`. The token is
protected with Windows DPAPI (`CryptProtectData` via ctypes, tied to the
Windows user account, no extra package); if DPAPI fails the token is stored in
plain text and the log warns you. (Plain form values such as the last Wi-Fi
name live in a separate `%LOCALAPPDATA%\Projection5000\flasher.json`.) Every
later launch calls `GET /api/operator/enrollment`, shows the console name and
URL plus the fetched group and playlist lists, and passes the fresh
enrollment key into the provision script it writes to the card. There is no per-card group or playlist choice: the site-wide defaults
from section A decide what a new device gets. `build.ps1` no longer bakes a
key; `-Key <enrollment key>` (with `-ConsoleUrl <url>`, or the env vars
`FLASHER_ENROLL_KEY` / `FLASHER_CONSOLE_URL`) remains for offline builds where
the console cannot be reached at flash time. The card layout and
`firstrun.sh` are unchanged apart from where the key comes from, and the
paste-a-device-token path still bypasses enrollment. See `tools/flasher/README.md` for the tool itself.

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

Coming in this branch.

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
