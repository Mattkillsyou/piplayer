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

Coming in this branch.

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
