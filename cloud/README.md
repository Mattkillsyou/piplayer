# PiPlayer Cloud

The PiPlayer manager as a Cloudflare Worker: `https://projection5000.com` (also `www.projection5000.com`; the original `https://projectors.photogen5000.com` still serves every device and SD Flasher already set up with it). It is a
port of the Python CMS in `cms/app/` (same pages, same routes, same device API, byte-compatible
`/api/sync` manifest) on Workers + D1 (SQLite) + R2 (media) + static assets, so the operator
uploads video and adjusts settings on a site that is always on, and each Raspberry Pi keeps
running the **unchanged** player from `player/` — it just points at a different `CMS_URL`.

Plain ES-module JavaScript, no framework, no runtime dependencies. Dev dependencies only:
`wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`. Node 24 / npm 11.

## Layout

```
wrangler.toml          bindings: DB (D1 piplayer-cloud-db), MEDIA (R2 piplayer-cloud-media),
                       ASSETS (public/, run_worker_first), ALERT_MAIL (send_email), [vars]
                       PIPLAYER_*, crons 0 3 * * * (housekeeping) + */5 * * * * (alerts),
                       custom domain route
migrations/            D1 schema, applied in name order (0001_init.sql = cms/app/db.py + settings,
                       sessions, login_failures, uploads, meta; later files add to it); add
                       000N_*.sql, never edit old ones
src/index.js           fetch + scheduled entry, session/CSRF/first-run gate, error mapping
src/router.js, util.js, db.js, auth.js, audit.js
src/api.js, media.js, manifest.js, schedules.js, uploads.js, alerts.js (evaluator + channels)
src/pages/*.js         server-rendered pages (layout.js = base.html)
public/                style.css + sortable.min.js (verbatim from the CMS), app.js, upload.js, sha256.js
test/                  vitest inside workerd (unit + integration, every route x role)
e2e/                   Python black-box suites against `wrangler dev` (run_e2e.py,
                       run_upload_e2e.py, run_operator_e2e.py, run_player_e2e.py — that one
                       drives the real player — run_alerts_e2e.py and run_tunnel_e2e.py)
scripts/deploy.md      deployment runbook;  scripts/backup.md  D1 + R2 backups
MODULES.md             module contracts for contributors
```

## Local development

```sh
cd cloud
npm install
npm run migrate:local -- --persist-to /tmp/piplayer-state     # apply migrations/ to local D1
npm run dev -- --persist-to /tmp/piplayer-state               # wrangler dev --local (Miniflare D1/R2), port 8787
```

`npm run dev` passes throwaway `SESSION_SECRET` / `SETUP_TOKEN` (`dev-setup-token`) via
`--var` and `--local-upstream 127.0.0.1:8787 --upstream-protocol http`, so manifest media URLs
and the install command point at the local server instead of the production route; no
`.dev.vars` file is needed. Open `http://127.0.0.1:8787/` — with an empty database
every page redirects to `/setup`; use `http://127.0.0.1:8787/setup?token=dev-setup-token` to
create the first admin. Local D1/R2 state lives under `--persist-to` (default
`.wrangler/state`, gitignored); pass a different directory per checkout or per agent so two
dev servers never share a database.

Cron locally: `npx wrangler dev --test-scheduled ...` then
`curl "http://127.0.0.1:8787/__scheduled?cron=0+3+*+*+*"` runs the housekeeping (audit
retention, uploads older than 24 h aborted, expired sessions and throttle rows dropped, closed
alerts older than 90 days and hour-old enrollment codes pruned);
`cron=*/5+*+*+*+*` runs one alert evaluation (`src/alerts.js`). The `ALERT_MAIL` send_email
binding is simulated locally (nothing leaves the machine); in production it needs Email
Routing on photogen5000.com, see `docs/automation.md` section F.

Note: because `wrangler.toml` declares the custom-domain route, `wrangler dev` presents
requests to the worker with the host `projectors.photogen5000.com` (that is wrangler's route
emulation, not something the code does). `npm run dev` overrides it with `--local-upstream`,
so manifest media URLs and the install command show `http://127.0.0.1:8787`; a bare
`npx wrangler dev` (as the e2e runner uses) shows the route host. In production it is the
real request origin.

## Migrations

`migrations/0001_init.sql` is the base schema; `0002_camera`, `0003_automation`,
`0004_device_codes`, `0005_pi_model`, `0006_indexes`, `0007_command_undeliverable`,
`0008_login_failures_index`, `0009_device_owner`, `0010_default_playlist`, `0011_password_reset`,
`0012_device_decode_mode`, `0013_device_frame_pacing`, `0014_device_decoder`,
`0015_device_render_profile` and `0016_accounts` add to it (see the Schema section of MODULES.md
for what each one adds; the database is at `schema_version` 16).
`0006` heals duplicate media rows and duplicate open alerts itself before its unique indexes go
on, so no manual step precedes it. `0010` creates the "Default" playlist (unless one of that name
exists), points `settings.default_playlist_id` at it and appends every media file that is in no
playlist at all, so nothing that was uploaded before it stays silent.

`0016_accounts` makes every account its own private space (see "Accounts" below). It adds
`owner_id` to `media`, `playlists`, `device_groups` and `audit_log`, the tables `account_settings`
and `account_secrets`, and gives everything that existed before (the shared library, playlists,
groups, uploads in flight with no uploader, every setting but the enrollment key, the Wyze and
Twilio secrets) to the **site admin**, the lowest-id user with role admin; the site Default
playlist becomes that admin's Default and every other user gets an empty Default of their own.
A projector owned by another account than the site admin loses the playlist, group and schedule
rules that now belong to someone else (one audit row each, reason "migration 0016"), so it plays
its owner's (empty) Default until its owner picks something; the header comment of the file has
the two SELECTs that list those projectors and rules before you apply it. Nothing else is
deleted. On a database with no users yet (a fresh install) the rows keep no owner and `/setup`
hands them to the first admin. Playlist and group names become unique per account: the old
`name` column cannot lose its site-wide UNIQUE in D1 (a table others point at cannot be rebuilt),
so it is renamed `legacy_name` and keeps an unseen value (the old name, a random token for new
rows), and a new `name` column, unique per account, takes its place.

To change the schema, add the next `migrations/000N_<name>.sql`
(one higher than the last file present; never edit an existing one; `ALTER TABLE ... ADD COLUMN`,
new tables, indexes; end it with the `schema_version` write and bump `db.SCHEMA_VERSION` to match)
and apply with `npm run migrate:local` (dev) / `npm run migrate:remote` (production; `npm run
deploy` runs it first). The worker reads `meta.schema_version` once per isolate and, until it is
at least `db.SCHEMA_VERSION`, refuses every request (`/api/health` included) with a plain-English
500 naming `npm run migrate:remote`. Tests apply the migrations automatically
(`test/apply-migrations.js`).

## Tests

```sh
npm test          # vitest run — every test/*.test.js inside workerd with local D1/R2
npm run e2e       # the e2e scripts below in turn, each against a wrangler dev it starts and stops itself
```

`npm test` covers units (schedules, hash, csrf, pbkdf2, validation, sha256.js) and integration
(every route x role in `test/roles_csrf.test.js`, device API golden manifest, media Range,
chunked uploads, screenshots, command cap, setup flow, settings/timezone effects, XSS escaping
and session security in `test/security.test.js`). The accounts model has two suites of its own:
`test/tenants.test.js` signs two people up and checks every page, form and API route against the
other account's ids (the same answer as a missing id, nothing changed), the manifests, media,
alerts and the admin handing a projector over; `test/migrations.test.js` runs the real migration
files on a seeded schema-9 database and on an empty one (the `MIGRATION_DB` / `FRESH_DB`
bindings in `vitest.config.js`).

The e2e directory holds six Python scripts (`cms/.venv` python with `requests`; `ffmpeg` on
PATH for test media; the browser half of `run_upload_e2e.py` drives a headless Chrome through
the `websockets` package that `cms/.venv` has, so run `npm run e2e` with that python first on
PATH). Each starts `npx wrangler dev --local` on its own port, applies migrations,
waits for `/api/health`, runs, and always kills the dev server:

```sh
python e2e/run_e2e.py        --port 8787 --persist-to <dir>   # setup, CSRF, authz matrix, contract-10 sweep,
                                                             # XSS, device API, media/Range, screenshots,
                                                             # commands, settings/timezone, audit, cookies/sessions,
                                                             # two sign-ups as two private accounts
python e2e/run_upload_e2e.py --port 8790 --persist-to <dir>   # 12 MiB upload through init/part/complete + resume,
                                                             # the same bytes in a second account
python e2e/run_operator_e2e.py --port 8789 --persist-to <dir> # operator API tokens: Settings/Users create + revoke,
                                                             # bearer GET /api/operator/enrollment, audit throttle,
                                                             # an editor's token sees its own account only
python e2e/run_player_e2e.py --port 8788 --persist-to <dir>   # the REAL player/player daemon with a fake mpv
python e2e/run_alerts_e2e.py --port 9100 --persist-to <dir>   # alerts: settings, */5 cron opens/closes, pages,
                                                             # Send test banners, Twilio secrets (wrangler --test-scheduled),
                                                             # a sign-up's projector judged in its own account
python e2e/run_tunnel_e2e.py --port 9120 --persist-to <dir>   # auto camera tunnel against an in-process fake Cloudflare
                                                             # API on port+1 (CF_API_BASE var): enrollment / Create tunnel,
                                                             # Recreate (a new tunnel), manifest tunnel block, refusal
                                                             # banners, a sign-up's own operator list
```

`run_e2e.py` prints a PASS/FAIL table and exits non-zero on any failure; a 501 answer is
reported per route so an unfinished module is visible. `--base http://host:port` runs the same
checks against an already-running server (it then needs the admin `admin`/`test1234`, which is
what the suite creates through `/setup` on a fresh state directory). After the plain-http run
`run_e2e.py` restarts wrangler dev with `--local-protocol https` (self-signed cert) and logs in
over TLS to prove the session cookie carries `Secure` there and is accepted back; with `--base`
that phase is not run (the script does not control the server).

## Deployment

The step-by-step runbook (D1/R2 creation, `migrations apply --remote`, generated secrets,
moving `projectors.photogen5000.com` off `hackthon5000`, `wrangler deploy`, the first `/setup`
URL, rollback) is `scripts/deploy.md`. Short version:

```sh
npx wrangler d1 create piplayer-cloud-db          # id -> wrangler.toml
npx wrangler r2 bucket create piplayer-cloud-media
npm run migrate:remote
npx wrangler secret put SESSION_SECRET            # random 48 bytes
npx wrangler secret put SETUP_TOKEN               # random 24 bytes
# remove the custom domain from hackthon5000 (dashboard or Workers Domains API), then
npm run deploy                                    # = npm run migrate:remote && wrangler deploy
# hand over: https://projectors.photogen5000.com/setup?token=<SETUP_TOKEN>
```

`npm run deploy:dry` bundles without uploading and is the check to run from a package branch.

## First-run setup and accounts

`/` is the public home page (`public/download.html`: Sign in / Create an account, a Forgot password link); signed in, `/`
goes to `/dashboard`. `/flasher` (any signed-in role, "SD Flasher" in the top bar) has the SD
flasher downloads (`FLASHER_VERSION` in `src/pages/flasher.js` names the release) and the
first-run steps; the old `/download` address goes there when signed in, to `/` otherwise.
While the `users` table is empty every page redirects to `/setup`; `GET /setup?token=<SETUP_TOKEN>`
shows the form (username, password twice), `POST /setup` creates the admin and logs in. Wrong
or missing token → 403; once a user exists `/setup` → 404 (the first admin also adopts whatever
the migrations seeded before any user existed, `accounts.adoptOrphans`).

**Accounts** (migration 0016, `src/accounts.js`). Every account is its own private space: its
projectors (`devices.owner_id`), media library and uploads, playlists (with its own Default
playlist), groups, schedules, device commands, projector power and IR codes, camera settings and
credentials, alert channels and alerts, settings (time zone, new-projector defaults, update window,
and the rest: `account_settings`) and the audit rows about it. Nobody else can list, read, change
or even learn the name of any of it: another account's id gets exactly the answer a missing id
gets (404 "Playlist not found", the same 404 for a media file, and so on), names are unique per
account (two accounts may both have a "Lobby"), and the same file uploaded by two accounts is two
library entries and two R2 objects. Roles say what a user may do inside their own account:
`viewer` reads; `editor` has full control of everything in it (library, playlists, groups,
schedules, its projectors and their tokens, Settings, alerts, camera, API tokens); `admin` is an
editor of its own account plus the site: the Devices page lists **every** projector with its
owner and keeps the device controls (rename, commands, updates, camera, projector, tunnel, delete)
and the Owner select, the Users page, the site-wide enrollment key and `/authorize`. What another
account's projector plays (its playlist, group and schedule) and its device token stay that
account's: the admin sees them read-only and gets a 403 that says to hand the projector over
first. Handing a projector to another account (`accounts.reassignDevice`) clears what pointed at
the old account's content (playlist, group, schedule rules, audited), so a projector only ever
plays its owner's content. An admin's library, playlists, groups, schedules, settings, dashboard,
alerts and audit log are its own like anyone's (the audit log also shows admins the rows about no
account). A projector with no owner (enrolled with the site key, or left without one) plays the
**site admin's** content (the lowest-id admin) and follows that account's settings. The role names
stay `admin`, `editor`, `viewer` because `users.role` has a CHECK constraint SQLite cannot change
without rebuilding the table; `editor` was redefined (it used to mean "may edit the shared
content") rather than adding a fourth role.

Anyone can create their own account from the login page (`/signup`, linked as "create an
account"): it starts as an **editor** of its own new, empty account straight away, with its own
Default playlist, no invite or approval (the owner's choice), capped at 5 attempts per address per
10 minutes and audited as `user_signup`. It sees nothing of anyone else's and has no Users page. Sign-up asks for an email
address (`users.email`, one account per address, `auth.emailProblem`); admins put one on older
accounts from the Users page. Forgot password (`/forgot`, linked from the sign-in card and the
home page) takes a username or email and always answers the same card; when the account has an
address a link with a one-off token goes out through the `EMAIL` send_email binding (only the
token's sha256 is stored, 30 minutes, 3 per account per hour), and `/reset?token=` changes the
password and ends every session of that account. On the Workers Free plan Email Routing delivers
only to addresses verified in the Cloudflare dashboard; any address needs Workers Paid plus
Email Sending with `photogen5000.com` onboarded (`wrangler.toml` has the notes). Usernames everywhere are
letters, digits, `. _ - @` only (`auth.usernameProblem`), so no invisible or look-alike names;
`enroll`, `signup` and `forgot` are reserved for the throttle. After a POST the pages answer with a one-shot notice (`auth.flashRedirect`,
a short-lived `piplayer_flash` cookie the next page shows once), not a `?saved=1` query string.

Passwords: PBKDF2-SHA256 (100 000 iterations, WebCrypto), min 6 chars, max 1024 bytes. Five
failed logins for one ip+username within 30 s lock that pair out for 30 s (429); twenty failures
from one address under any usernames in 30 s lock that address, and twenty failures for one
username from anywhere within 10 minutes lock that account for the rest of the window.
Addresses are IPv4 or an IPv6 /64. Usernames are capped at 64 characters on the login form.
Failed logins are audit-logged as `login_failed` with the real account name only (never what
was typed). Sessions are D1 rows referenced by an HMAC-signed cookie
(`piplayer_session`, `HttpOnly; Secure; SameSite=Lax; Max-Age=14 days`). `Secure` is always
set; plain-http `wrangler dev` needs `--var PIPLAYER_INSECURE_COOKIES:1` (`npm run dev` and the
e2e runners pass it, production never does) or browsers and `requests` drop the cookie. Only
`GET /login`, `/signup`, `/forgot`, `/reset` (and `GET /setup` while no user exists yet) start an anonymous session (1 h, just
a CSRF token for the form); any other cookieless request is answered without touching D1. Every
session insert also prunes the expired rows (the daily housekeeping does too). Login rotates the
session; logout, deleting the user or an admin resetting their password invalidates it
immediately. Every non-`/api/` POST/PUT needs the CSRF
token (`csrf_token` form field or `X-CSRF-Token` header, from `<meta name="csrf-token">`);
a write whose session is gone (no cookie, expired, logged out elsewhere, user deleted —
`POST /login` without a session included) is answered `303 /login?expired=1` before the token
check (the login page explains) rather than a JSON 403, so a form left open past the 14 days
lands on the sign-in page; the 403 is for a live session with a missing or wrong token. This
mirrors `cms/app/auth.py require_csrf`.

## Pointing a Pi at it

Register the device on `/devices`, open its "Token / install" block (editors and admins, on the
projector's own account: the token also reads that account's Wyze login) and run the printed
command on the Pi from the directory the repo was cloned into:

```sh
cd piplayer/player && \
DEVICE_ID=<device id> \
DEVICE_TOKEN=<token> \
CMS_URL=https://projectors.photogen5000.com \
sudo -E bash deploy/install-player.sh
```

Nothing in `player/` changes: the device API (`/api/health`, `/api/sync/{device_id}`,
`/api/media/{filename}` with `Range`, `/api/screenshots/{device_id}`,
`/api/commands/{id}/result`) is reproduced from `cms/app/routes/api.py`, including the manifest
hash formula, the 5-delivery cap on remote commands and the `sync_error` report shown on the
Devices page. What the player reports about itself on `GET /api/sync` (`current_filename`,
`player_status`, `player_version`) is stored capped at 200 characters like its error strings;
`POST /api/screenshots` and `/api/camera` answer 411 when the upload carries no
`Content-Length`. The SD flasher (v0.7.0+) signs in with `POST /api/operator/login`
`{"username", "password", "hostname"}` (no browser, no enrollment key): editors and admins get a
`p5k_` operator token named `SD Flasher on <hostname>`, viewers a 403 with the words to read to
the owner; `GET /api/operator/me` says who the token is and lists groups and playlists; and
`POST /api/operator/devices` `{"device_id", "name", "pi_model"}` registers the projector for that
account and hands back the device token the flasher writes onto the card (see the enrollment
note below). `GET /api/operator/enrollment` (admin's token only; returns the enrollment key) is
kept for flashers before v0.7.0. Regenerating a token on the Devices page invalidates the old one at once and,
when the device has an automatic camera tunnel, recreates that too (the tunnel key travels in
every sync, so a leaked device token means a leaked tunnel key). The Devices page also has a
Rename form per device (editor+); the flasher's name is otherwise only changed by re-flashing.

## Limits and design notes

- **Plan.** The account runs on Workers Free today. Two platform limits
  (developers.cloudflare.com/workers/platform/limits) matter: CPU time is 10 ms per request on
  Free (30 s default on Paid, and Paid may raise it with `[limits] cpu_ms`, which Free refuses),
  so upload completion hashes files only up to `PIPLAYER_VERIFY_SHA_MAX_BYTES` (8 MiB) and a
  PBKDF2-SHA256 derivation at 100 000 iterations (≈ 13-15 ms) sits at the edge of that budget on
  `/login`, `/setup` and `/users` (Cloudflare error 1102, `Worker exceeded resource limits`, is
  the symptom if it ever trips; the Paid plan removes it). Subrequests
  also count against a per-invocation budget and every D1 statement and R2 call is one: Free
  allows 50 external + 1 000 to Cloudflare services, Paid 10 000 (configurable). `/devices`
  and `/dashboard` load the fleet's schedules, group defaults, playlist names, schedule counts,
  tokens and recent commands with one statement each (a window function for the per-device
  command limit), so their D1 cost does not grow with the number of devices. Check the plan
  before deploying: `npx wrangler whoami` shows the account, the dashboard shows the plan under
  Workers & Pages → Plans; a Free-plan deploy fails only at runtime, not at `wrangler deploy`.
- **Request bodies are capped at 100 MB** on the Free/Pro zone plan (Cloudflare Workers limits), and
  the worker has no ffprobe. Uploads therefore never send a multipart form: `public/upload.js`
  reads the file in the browser, extracts metadata there (`<video preload=metadata>` for
  duration/width/height, `<img>` for images; codec is unknown → `null`), computes the SHA-256
  incrementally with the vendored `public/sha256.js` while reading 8 MiB slices, and drives
  `POST /library/upload/init` → `PUT /library/upload/{id}/part/{n}` (8 MiB parts, an R2
  multipart upload; the last part may be smaller, R2 requires ≥ 5 MiB otherwise) →
  `POST /library/upload/{id}/complete`. `GET /library/upload/{id}` returns `{received, parts}`
  so a reload resumes by skipping received parts (the browser re-hashes from 0). Uploads
  abandoned for 24 h are aborted by the daily cron.
- **Dedupe before bytes move**, within one account: `init` checks the client's sha256 against
  the uploader's own library and answers 409 with that file's name (never another account's); it
  also refuses (409) a name whose storage key (`<sha16>_u<account id>_<name>`, so two accounts'
  copies are two objects and deleting one never removes the other) is already held by a library
  file or an in-flight upload, and `media(owner_id, sha256)` is UNIQUE since migration 0016
  (`media.sha256` site-wide from 0006), so a same-instant race cannot slip a duplicate in either. The size is checked against `PIPLAYER_MAX_UPLOAD_BYTES` (5 GiB) at init too. Upload
  error messages are plain English ("That file type (.exe) is not supported...", "This file is
  X GB; the limit is Y GB.", "Already in the library as ...").
- **Every upload joins the uploader's Default playlist**: `complete` appends the new media row
  to the uploading account's Default (`default_playlist_id` in its `account_settings`, created at
  sign-up, on the Users page, at `/setup` and by migration 0016; its Settings page can point it at
  another of its playlists) in the same transaction as the media row, after its last item, and
  bumps that playlist's `updated_at`; the `upload_media` audit row carries `playlist: <id>`. A
  projector plays its account's Default whenever no schedule rule matches and neither the device
  nor its group has a playlist of its own (`manifest.pick_playlist`: schedule → device default →
  group default → the account's Default, every step from the projector's own account only), so a
  fresh upload plays on every one of that account's projectors that nobody has assigned anything
  to. The Playlists page marks it with a `default`
  badge and refuses to delete it until another playlist is made the default on Settings.
- **Complete verifies the hash**: `POST /library/upload/{id}/complete` re-hashes the stored
  object and refuses a mismatch with 400, deleting the object, so a wrong browser hash never
  reaches the library or the dedupe check. Files up to `PIPLAYER_VERIFY_SHA_MAX_BYTES` (8 MiB,
  the Workers Free CPU budget; on Paid add `[limits] cpu_ms = 300000` and raise the var to the
  5 GiB upload limit) are verified; a file above it is recorded with the
  browser hash and the audit row carries `sha_verified: false` (the player still verifies every
  download and reports a mismatch as `sync_error` on the Devices page).
- **Animated GIF**: the server never sees the frames; `upload.js` counts Graphic Control
  Extension blocks in the slices it hashes and sends `animated: true` when it finds more than
  one, in which case the `.gif` is stored as `video` (mpv plays it through; image display
  duration does not apply). A block straddling two 8 MiB slices, or a false match inside pixel
  data, mis-classifies that GIF — the same limitation the CMS has without ffprobe.
- **Per-account projectors** (`POST /api/operator/devices`, `api.registerDevice`, migration
  0009 `devices.owner_id`): the flasher registers each projector as the account signed in to the
  app before it writes the card, and the card carries the device token (no enrollment key on
  cards). A new `device_id` gets a row owned by that user with that account's Settings
  group/playlist defaults (201, `created: true`, audit `device_registered` with `owner`); the user's own id gets
  a NEW token (200, `created: false`, the old card stops syncing, a rename is audited as
  `renamed_from` under `device_reregistered`); an id owned by another account is a 409 ("belongs
  to another account; pick another name"; device ids are one namespace for the whole site, so
  that answer is the one thing an account can learn about another: that an id is taken). Admins
  may re-register any id, and an ownerless one (from before migration 0009 or `/api/enroll`)
  becomes theirs, dropping what it pointed at of the site admin's unless that is theirs too
  (`accounts.reassignDevice`); editors get the 409 for those too. A projector added with the
  Devices page form belongs to whoever added it. Editors and viewers see only their own projectors
  on the console, admins see every projector and can change the owner. The new-id cap below
  applies.
- **Zero-touch enrollment** (legacy: cards written by flashers before v0.7.0): `POST /api/enroll`
  `{"key", "device_id", "name"}` trades the site's enrollment key (the admins' Settings page;
  "Rotate" invalidates cards not yet booted) for the device's token: `{"device_id", "token", "cms_url"}`.
  The row it creates has no owner, so it plays the site admin's content until an admin gives it one. Re-enrolling a known `device_id` issues a NEW token: the old
  card (and anything that learned the old token) stops syncing, the console's view of the
  device (group, playlist, history) is kept and a rename is audited as `renamed_from`. The
  enrollment key alone can re-enroll any device id, so rotate it whenever a card, a flasher PC
  or an operator token is lost. Wrong key: 401, throttled per ip (10 failures / 60 s → 429 with
  `Retry-After`); new device ids are capped fleet-wide at 20 per hour whichever endpoint creates
  them (429 with `Retry-After: 3600`, audited as `device_enroll_capped`); re-enrollments are not
  counted. Audit: `device_enrolled`, `device_reenrolled`, `enrollment_key_rotated`.
- **Timezone is a per-account setting**, not the server's clock: each account's `/settings`
  stores an IANA zone (validated with `Intl.DateTimeFormat`), default `UTC`. A stored zone that no
  longer validates (a D1 edit, a restore) does not break the console: the account falls back to
  `UTC`, `loadSettings` reports the stored value as `timezone_problem`, and the Settings page
  warns with it so its owner can pick a real zone. Schedule rules of a projector evaluate
  wall-clock time in its account's zone (`formatToParts`), every timestamp a user sees is
  rendered in their own zone with the zone abbreviation, and the manifest `server_time` carries
  the projector's account's offset. Timestamps in D1 stay
  UTC (`datetime('now')`). Wrap-midnight windows are anchored to the day they start, as in the
  CMS.
- **Media serving** streams R2 objects with `Content-Type` from the stored metadata,
  `Accept-Ranges: bytes`, `ETag`, `Content-Length`, `X-Content-Type-Options: nosniff`, `Range`
  (single range 206, disjoint ranges as `multipart/byteranges` laid out like Starlette's
  `FileResponse`, 416 when unsatisfiable, `If-Range` honoured, more than 100 parts → the whole
  object) and HEAD. Malformed and inverted ranges are 400; like Starlette these 400/416 answers
  are `text/plain`, not the JSON `{detail}` envelope. A device token only unlocks the files of the playlist
  it currently resolves to (schedule → device default → group default → its account's Default); a
  signed-in user may fetch the files of their own library only (another account's file is the same
  404 as a missing one, admins included). A media filename starts with 16 hex chars of the file's sha256, so the bytes
  behind a name never change: media goes out with `Cache-Control: public, max-age=31536000,
  immutable` and a plain GET is kept in the edge cache (`caches.default`, keyed on the URL, looked
  up only after the auth and scoping checks) so the next projector on the same edge gets the edge
  copy instead of another read from R2. Range requests always go to R2. Screenshots and camera
  snapshots stay `no-store`.
- **Screenshots** must start with the JPEG magic `FF D8 FF` and stay under
  `PIPLAYER_MAX_SCREENSHOT_BYTES` (5 MiB, 413 otherwise); they live at
  `screenshots/<device_id>.jpg` in R2 and a stale badge appears after 3 × the screenshot interval.
- **Errors** are JSON `{"detail": ...}` with the CMS status codes: 400 malformed input, 404
  missing rows, 409 conflicts with a friendly message, 403 CSRF/role, 401 device auth; an
  unmapped D1 constraint error becomes a 409, never a bare 500. Outside `/api/`, when the
  request's `Accept` includes `text/html` (a page navigation or a form post), a thrown
  `HttpError` and the 409 constraint fallback are rendered as an HTML page instead (the normal
  layout, the message in the alert box, a Back link); the device API contract is unchanged.
  `GET /setup` with a wrong or missing token shows a friendly "not set up yet" card at 403. 405
  answers carry an `Allow` header. `/openapi.json`, `/docs`, `/redoc` are 404.
- **Response headers**: every response carries `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Content-Security-Policy:
  default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src https:;
  frame-ancestors 'none'` (blob: so the Library page can read a picked file's size and duration
  before uploading it) and
  `Strict-Transport-Security: max-age=31536000`; every HTML page is `Cache-Control: no-store`.
  For page work: the CSP forbids inline `<script>`, inline `style` attributes, `on*=` handlers
  and `javascript:` links, so behaviour goes in `public/app.js` and styles in `style.css`.
- **Housekeeping** (the `0 3 * * *` cron): audit rows older than
  `PIPLAYER_AUDIT_RETENTION_DAYS` (365), abandoned uploads, expired sessions, throttle rows,
  closed alerts older than 90 days, and enrollment codes older than an hour (an approved but
  never-claimed flasher token is deleted with its code); it also encrypts any camera RTSP URL
  still stored in plain text from before encryption.
- **The dashboard's audit tail shows people's actions only** (rows with a username) about the
  reader's own account; device syncs and cron rows are on `/audit`, which shows each account the
  rows about itself and its own actions (admins also the rows about no account). Every validation message on the pages is plain English
  for a non-technical owner.
- **Alerts** (`*/5 * * * *`, `src/alerts.js`): offline / mpv-down / stale screenshot / sync,
  update, camera and projector errors per device; one row per (device, kind) while it holds,
  notified on open, on recovery and every `alert_repeat_minutes` while open, through email
  (`ALERT_MAIL`), a JSON webhook and Twilio SMS as set on `/settings`. Each projector is judged by
  its own account's thresholds and reported through its own account's channels only (one digest
  per account); `/alerts` lists the reader's own projectors' alerts.

## Backups

`scripts/backup.md`: `wrangler d1 export piplayer-cloud-db --remote --output ...` for the
database (restore with `wrangler d1 execute --remote --file`), and `rclone copy` (S3 API) or a
`wrangler r2 object get` loop for the media bucket.
