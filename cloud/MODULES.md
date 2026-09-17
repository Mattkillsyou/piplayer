# PiPlayer Cloud — module guide for package authors

Read this together with the spec (`cloud_spec.md`). Everything below exists and is tested
(`npm test`, `npm run e2e`). Your module plugs in by replacing its stub; do not change the
scaffold files (`index.js`, `router.js`, `util.js`, `db.js`, `auth.js`, `audit.js`,
`pages/layout.js`, `pages/login.js`, `pages/setup.js`) without telling the scaffold owner.

## Running things

| what | command |
|---|---|
| install | `npm install` (wrangler 4, vitest 4, @cloudflare/vitest-pool-workers 0.22 — dev deps only) |
| unit/integration tests | `npm test` (vitest inside workerd; migrations applied automatically by `test/apply-migrations.js`) |
| local D1 migration | `npm run migrate:local -- --persist-to <your scratch>/state` |
| dev server | `npm run dev -- --port <your port> --persist-to <your scratch>/state` (later flags override the script's `--port 8787`; the script passes throwaway `SESSION_SECRET`/`SETUP_TOKEN` via `--var`) |
| e2e | `python e2e/run_e2e.py --port <your port> --persist-to <dir>` (starts + migrates + kills wrangler dev itself; append your checks to `CHECKS`); feature suites live beside it (`run_upload_e2e.py`, `run_operator_e2e.py`, `run_player_e2e.py`) |
| deploy check | `npm run deploy:dry` (never plain `deploy` from a package) |

**Ports / persist-to rule:** every agent runs `wrangler dev` on its own assigned port and with
`--persist-to <its scratch subfolder>/state`, never the default `.wrangler/state`, so local
D1/R2 files never collide. Kill your dev server in a `finally` (`taskkill /PID <pid> /T /F`);
wrangler respawns workerd if you only kill the child — kill the `node` parent.

`compatibility_date` is `2026-08-22`: the newest date the workerd bundled with
vitest-pool-workers 0.22 accepts (a later date makes `npm test` fail to boot).

## Request flow (`src/index.js`)

1. `/static/*` → `env.ASSETS.fetch` (public/ is the assets root: `/static/style.css` = `public/style.css`).
2. `db.assertMigrated(env)` — once per isolate; `SELECT 1 FROM meta` failing → 500
   `{"detail":"database not migrated: run npm run migrate:local (or migrate:remote)"}`.
3. Router match. No route → 404 `{"detail":"Not Found"}`; path matches but not the method → 405;
   a `:param` with a broken percent sequence → 400 `{"detail":"malformed path"}`.
   `/openapi.json`, `/docs`, `/redoc` are therefore 404 for free — do not register them.
4. `ctx` is built (below).
5. Non-`/api/` paths: `auth.loadSession(ctx, {create})` — `create` only for `GET /login` and
   `GET /setup` (an anonymous 1 h session + cookie so the form has a CSRF token); every other
   request just reads the cookie, so a cookieless `GET /dashboard` redirects without a D1
   write. Then for any method other than GET/HEAD/OPTIONS:
   no logged-in user (session expired, logged out elsewhere, user deleted) and the path is not
   `/login` or `/setup` → 303 `/login?expired=1` (the login page shows "Your session expired;
   please sign in again"); a `/login` POST whose cookie carried no live session → the same 303
   (a fresh form instead of a JSON 403); otherwise `auth.requireCsrf(ctx)` (403
   `{"detail":"CSRF token missing or invalid"}`). Then the first-run gate: while `users` is
   empty every path except `/setup` → 303 `/setup`.
   `/api/` paths: the session is only *read* (`loadSession(ctx, {create:false})`) so
   `/api/media` can accept a logged-in browser; bearer auth is the handler's job.
6. `await handler(ctx)` → Response. Cookies queued in `ctx.cookies` are appended.
7. Errors: a thrown `Response` is returned as-is (that is how `requireUser` redirects);
   `HttpError` → `{"detail"}` with its status; a D1 constraint error nobody mapped → 409
   `"conflicts with an existing record or references one that does not exist"` (like
   main.py's IntegrityError handler); anything else → `console.error` + 500
   `{"detail":"internal server error"}`.

`scheduled` dispatches on `event.cron`: `*/5 * * * *` (`alerts.CRON`) runs `alerts.evaluate(env)`
in a try/catch; `0 3 * * *` calls `housekeeping(env)` of every module that exports one, each in its
own try/catch. Locally: `wrangler dev --test-scheduled` then `GET /__scheduled?cron=0+3+*+*+*`
(or `cron=*/5+*+*+*+*`). The entry module may only export handlers: keep constants elsewhere.

## ctx

```js
{
  request,           // Request
  env,               // bindings: DB (D1), MEDIA (R2), ASSETS, PIPLAYER_* vars, SESSION_SECRET, SETUP_TOKEN
  exec,              // ExecutionContext (exec.waitUntil)
  url,               // new URL(request.url); url.searchParams for query strings
  params,            // {name: string} from ':name' segments (strings! use idParam())
  user,              // {id, username, role} or null
  session,           // {id, user_id, csrf, expires_at} or null
  csrf,              // the session's CSRF token (string) — null only on /api/ requests without a session
  ip,                // CF-Connecting-IP header or null
  cookies,           // Set-Cookie strings to append (auth.js fills it; you normally never touch it)
  form(),            // Promise<FormData>, memoised (the CSRF check already read it; reading again is free);
                     //   malformed body → 400. Use util.str(form, "name") for string fields.
  settings(),        // Promise<{timezone, screenshot_interval, camera_interval, default_image_duration, enrollment_key,
                     //   enroll_group_id, enroll_playlist_id, player_release, auto_update, auto_update_window}>, memoised
}
```

## Router (`src/router.js`)

```js
export function register(router) {
  router.get("/devices", devicesPage);                       // add(method, pattern, handler)
  router.post("/devices/:device_id/assign", devicesAssign);  // ':param' segments → ctx.params.device_id
  router.put("/library/upload/:id/part/:n", uploadPart);
}
```
`router.add(method, pattern, handler)`; `get/post/put` are shorthands. Patterns are literal except
`:name` (one segment, URL-decoded). First registered match wins; order in `index.js` MODULES is
pages first then api/media/uploads. HEAD matches GET routes. `isApiPath(path)` = `/api` or `/api/...`.

## util.js

| helper | semantics |
|---|---|
| `class HttpError(status, detail, headers?)` / `fail(status, detail)` | throw → JSON `{"detail"}` response with that status |
| `esc(v)` | HTML-escape `& < > " '`; null/undefined → `''`. Every interpolation goes through it |
| `json(data, status=200, headers={})` | JSON Response |
| `redirect(location, status=303)` | redirect Response (also throwable) |
| `html(body, status=200, headers={})` | `text/html; charset=utf-8` Response (layout() uses it) |
| `str(form, name, fallback='')` | string field of a FormData (File/missing → fallback) |
| `intField(value, field)` | `''`→null, non-integer → 400 `"<field> must be an integer"` (web._form_int) |
| `floatField(value, field, msg?)` | `''`→null, non-finite/junk → 400 (`msg` or `"<field> must be a number"`) |
| `idParam(value, field='id')` | path param must be `\d+` else 400 `"<field>: value is not a valid integer"` (FastAPI int converter) |
| `normalizeHhmm(v)` | `'7:05'`/`'07:05'` → `'07:05'`, invalid → null (schedules.normalize_hhmm) |
| `isoDate(v)` | real `YYYY-MM-DD` → same string, else null |
| `isoDateField(v, field)` | `''`→null, bad → 400 `"<field> must be a date in YYYY-MM-DD form"` |
| `jsonObject(request)` | body as a JSON object or 400 `"body must be a JSON object"` |
| `nowUtc(date?)` | `'YYYY-MM-DD HH:MM:SS'` UTC (same shape as sqlite `datetime('now')`) |
| `parseDbUtc(v)` | DB timestamp string → Date (UTC) or null |
| `wallClock(tz, date?)` | `{year, month, day, hour, minute, second, weekday (0=Mon..6=Sun), zone}` in `tz` — schedules evaluate on this |
| `zoneOffsetMinutes(tz, date?)` | numeric UTC offset in minutes |
| `localTime(v, tz)` | DB timestamp → `'2026-09-14 15:03 PDT'` (Jinja `local` filter) |
| `serverTimeIso(tz, date?)` | `'2026-09-14T15:03:07-07:00'` (manifest `server_time`) |
| `zoneName(tz)` | `'PDT'` |
| `isValidTimeZone(tz)` | IANA check via Intl (settings page) |
| `ageText(seconds)` / `ageSeconds(dbValue)` | `'12 s ago'`, `'3 min ago'`, `'2 h ago'`, `'5 d ago'`, `'never'` |
| `randomToken(nbytes=32)` | `secrets.token_urlsafe` equivalent (device tokens, ids) |
| `b64url`, `fromB64url`, `hex`, `sha256Hex(string|bytes)`, `utf8Len(s)` | encoding bits |
| `envInt(env, name, fallback)`, `envFloat(...)` | parse a `PIPLAYER_*` var |

## db.js

All take `env` (not ctx) so housekeeping can use them too.

| helper | semantics |
|---|---|
| `all(env, sql, ...params)` | rows array |
| `first(env, sql, ...params)` | first row or null |
| `run(env, sql, ...params)` | `{changes, last_row_id}` |
| `batch(env, [[sql, ...params], ...])` | one D1 batch = one transaction; returns the per-statement D1 results |
| `isConstraintError(e)` | UNIQUE/FK/CHECK violation (map it to a friendly 409/404 in your route; unmapped ones become the generic 409) |
| `assertMigrated(env)` | the once-per-isolate schema guard |
| `loadSettings(env)` / `defaultSettings(env)` / `saveSetting(env, key, value)` / `SETTING_KEYS` | settings table (see below) |
| `pruneAuditLog(env, days)` | used by audit.housekeeping |

Positions/orderings: keep the Python `ORDER BY position, id` style; D1 is SQLite, the schema is the
same, so the SQL from web.py/api.py ports verbatim (`?` placeholders, `datetime('now')`).

## auth.js

| helper | semantics |
|---|---|
| `hashPassword(pw)` | `pbkdf2$100000$<salt b64url>$<hash b64url>` (WebCrypto PBKDF2-SHA256); >1024 bytes → HttpError 400 |
| `verifyPassword(pw, hash)` | constant-time; false for any malformed hash |
| `passwordProblem(pw)` | `''` when OK, else the 400 message (`< 6 chars` / `> 1024 bytes`). Use it in users create/password/setup |
| `MIN_PASSWORD_CHARS`, `MAX_PASSWORD_BYTES`, `PASSWORD_TOO_SHORT_MSG`, `PASSWORD_TOO_LONG_MSG`, `CSRF_ERROR`, `ROLES` | constants |
| `timingSafeEqual(a, b)` | strings or bytes |
| `burnPasswordCheck(pw)` | equalises timing when the username does not exist |
| `loadSession(ctx, {create=true})` | fills `ctx.session/user/csrf` (index.js does this; you never call it) |
| `createSession(ctx, userId)` / `rotateSession(ctx, userId)` / `destroySession(ctx)` | login rotates, logout destroys; cookie `piplayer_session=<id>.<hmac>` HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600 (`ANON_SESSION_MAX_AGE` 3600 for anonymous); `Secure` is dropped only with `PIPLAYER_INSECURE_COOKIES=1` (dev/e2e command lines) |
| `currentUser(ctx)` | `ctx.user` |
| `requireUser(ctx)` | user or **throws** `redirect('/login')` |
| `requireRole(ctx, 'editor'|'admin')` | user or 303 `/login` / 403 `{"detail":"requires editor role"}`; ranks viewer < editor < admin |
| `csrfToken(ctx)` | `ctx.csrf` (the layout emits it; `csrfInput(ctx)` for forms) |
| `requireCsrf(ctx)` | header `X-CSRF-Token` or form field `csrf_token`; index.js already applies it to every non-`/api/` unsafe request, JSON and raw-body endpoints included (so fetch/PUT callers must send the header) |
| `loginLockedFor(env, ip, username, max?, seconds?)` / `recordLoginFailure` / `clearLoginFailures` | D1 `login_failures`; 5 failures in 30 s → seconds remaining. `POST /api/enroll` reuses it with username `ENROLL_KEY` and `ENROLL_MAX_FAILURES` (10) / `ENROLL_LOCK_SECONDS` (60) |
| `deviceFromHeader(ctx)` | `{id, device_id, name, playlist_id, group_id}` for `Authorization: Bearer <token>`; 401 `"Missing bearer token"` / `"Invalid device token"`. The path `device_id` must equal `row.device_id` else 403 — your check |
| `operatorFromHeader(ctx)` | `{token_id, token_name, id, username, role}` for `Authorization: Bearer p5k_<32 urlsafe>` (api_tokens, looked up by SHA-256 hex, `timingSafeEqual` on the stored hash); 401 `"Missing bearer token"` / `"Invalid API token"`. Role is the caller's check (`GET /api/operator/enrollment` wants editor+) |
| `newApiToken()` / `apiTokenHash(token)` / `touchApiToken(env, id)` | mint `p5k_` + 32 chars; SHA-256 hex; stamp `last_used_at` at most once per `API_TOKEN_USED_AUDIT_HOURS` (returns true when it did, so the caller audits `api_token_used` then) |
| `requireSetupToken(ctx, token)` | 403 unless equal to `SETUP_TOKEN` |
| `hasUsers(env)` | cached once true |
| `housekeeping(env)` | expired sessions + throttle rows |

## audit.js

`await audit.log(ctx, action, targetType=null, targetId=null, details=null, user=undefined)` —
user defaults to `ctx.user`; pass `null` for `login_failed`; `details` is JSON-encoded when
non-empty by `audit.pyJson()` (Python `json.dumps` text: `{"a": 1, "b": [1, 2]}`, non-ASCII as
`\uXXXX`, so the Details column matches the CMS); `ip` = `CF-Connecting-IP`. Never throws. Action/target names are exactly web.py's:
`login`, `login_failed`, `logout`, `upload_media`, `delete_media`, `create_playlist`,
`playlist_add_item`, `playlist_set_duration`, `playlist_reorder`, `playlist_remove_item`,
`playlist_rename`, `playlist_delete`, `register_device`, `device_assign_playlist`,
`device_set_group`, `device_regen_token`, `device_delete`, `device_send_command`,
`device_schedule_create`, `device_schedule_delete`, `group_create`, `group_assign_playlist`,
`group_delete`, `user_create`, `user_set_role`, `user_set_password`, `user_delete`
(+ new: `settings_update`, `enrollment_key_rotated`, `device_enrolled`, `device_reenrolled`,
`device_update_all` (fleet button: `{command, queued}`), `device_update_reported` (user null: the
player's post-update report `{device_id, ref, ok, message}`)). `audit.clientIp(ctx)` is exported too.

## pages/layout.js

```js
import { layout, csrfInput, alertBox, APP_NAME } from "./layout.js";
return layout(ctx, { title: "Devices", content, status: 200, message: "", messageKind: "error", scripts: ["/static/sortable.min.js"] });
```
`layout()` is a plain function (not middleware): it wraps `content` (already-escaped HTML) in
base.html's shell: `<meta name="csrf-token">`, the Projection5000 wordmark, the nav with active
states (`Users` and `Settings` for admins only), the user badge + logout form, the message slot
(`alertBox`), then `scripts` and `/static/app.js`. No nav when `ctx.user` is null (login/setup;
those pass `bodyClass: "login"` and render `SCENE` + `wordmark(true)` inside the `.auth-card`).
Titles render as `"<title> · Projection5000"`. Put `${csrfInput(ctx)}` inside **every**
`<form method="post">`. `public/style.css` is the Python CMS stylesheet verbatim plus a short
cloud-only block at the end (upload queue, settings panel); edit the block, not the copy.

`public/app.js` provides: the delegated `data-confirm` submit listener (no inline `onsubmit`);
`data-autosubmit` on a `<select>` replaces `onchange="this.form.submit()"` (goes through
`requestSubmit`, so confirm + CSRF apply); `window.piplayer.postJson(url, body)` (JSON POST with
the CSRF header, rejects on a login redirect); and the playlist reorder Sortable init for
`<tbody id="sortable-body" data-playlist-id="N">` rows with `data-item-id` + `.drag-handle`
+ `.position-cell` (include `/static/sortable.min.js` via `scripts`). `data-readonly` disables it.

## Conventions

```js
// src/pages/groups.js
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import { esc, fail, idParam, intField, redirect, str } from "../util.js";
import { csrfInput, layout } from "./layout.js";

async function groupsCreate(ctx) {
  const user = auth.requireRole(ctx, "editor");            // viewer → 403, anonymous → 303 /login
  const form = await ctx.form();                            // CSRF already verified by index.js
  const name = str(form, "name").trim();
  if (!name) fail(400, "Name required");                    // 400 {detail}
  let id;
  try {
    id = (await db.run(ctx.env, "INSERT INTO device_groups (name) VALUES (?)", name)).last_row_id;
  } catch (e) {
    if (db.isConstraintError(e)) fail(409, "A group with that name already exists");  // friendly 409
    throw e;
  }
  await audit.log(ctx, "group_create", "device_group", id, { name });
  return redirect("/groups");
}

async function groupsAssign(ctx) {
  auth.requireRole(ctx, "editor");
  const groupId = idParam(ctx.params.group_id, "group_id");
  const pid = intField(str((await ctx.form()), "playlist_id"), "playlist_id");
  if (!(await db.first(ctx.env, "SELECT id FROM device_groups WHERE id = ?", groupId))) fail(404, "Group not found");
  if (pid !== null && !(await db.first(ctx.env, "SELECT id FROM playlists WHERE id = ?", pid))) fail(404, "Playlist not found");
  ...
}

export function register(router) {
  router.get("/groups", groupsPage);
  router.post("/groups", groupsCreate);
  router.post("/groups/:group_id/assign", groupsAssign);
}
```

- Read-only pages: `auth.requireUser(ctx)`; writes: `auth.requireRole(ctx, "editor")`;
  users/settings: `"admin"`. Viewers never see device tokens (`user.role !== "viewer"`).
- Validate before touching the DB; 400 for malformed, 404 for missing rows, 409 for conflicts
  with a friendly message, never sqlite text. Path ids: `idParam(ctx.params.x, "x")`.
- Every timestamp you render: `localTime(value, (await ctx.settings()).timezone)`.
- Device API (`/api/*`): `const dev = await auth.deviceFromHeader(ctx); if (dev.device_id !== ctx.params.device_id) fail(403, "...")`.
- Library modules (`manifest.js`, `schedules.js`) export functions + an empty `register`.
- Housekeeping: export `housekeeping(env)`; keep it idempotent.
- No console noise except `console.warn` for failed logins and `console.error` for real failures.

## Settings (`settings` table, `/settings` page)

| key | default | used by |
|---|---|---|
| `timezone` | `UTC` (IANA name, validate with `isValidTimeZone`) | every rendered timestamp, `server_time`, schedule evaluation |
| `screenshot_interval` | `PIPLAYER_SCREENSHOT_INTERVAL` (60) | manifest `screenshot_interval_seconds`, stale badge (`> 3 ×`) |
| `camera_interval` | `PIPLAYER_CAMERA_INTERVAL` (10, min 5) | manifest `camera_interval_seconds`, camera snapshot stale badge (`> 3 ×`) |
| `default_image_duration` | `PIPLAYER_DEFAULT_IMAGE_DURATION` (10) | effective duration of images |
| `enrollment_key` | random 32-byte urlsafe token, generated on the first `loadSettings` (never from env) | `POST /api/enroll` (the flasher fetches it live through `GET /api/operator/enrollment` and writes it to each card); `/settings` shows it and `POST /settings/enrollment/rotate` replaces it (`db.generateEnrollmentKey`) |
| `enroll_group_id` / `enroll_playlist_id` | none (int or null; a deleted row reads as none) | applied to a device on its first `POST /api/enroll` only |
| `player_release` | `PIPLAYER_PLAYER_RELEASE` (`main`); git tag/branch/sha, `db.isGitRef` (alphanumeric first char, `[A-Za-z0-9._/-]`, no `..`, <= 100) | manifest `update.release`: what `update-player` checks out on the Pi |
| `auto_update` | `PIPLAYER_AUTO_UPDATE` (`off`); `off` or `nightly` (`db.AUTO_UPDATE_MODES`) | manifest `update.auto` |
| `auto_update_window` | `PIPLAYER_AUTO_UPDATE_WINDOW` (`03:00-05:00`); `HH:MM-HH:MM` site time, may wrap midnight (`db.UPDATE_WINDOW_RE`) | manifest `update.window` |
| `wyze_camera_pattern` | `{device_name}` (`db.isCameraPattern`: 1-100 printable chars; `{device_name}` / `{device_id}` substituted) | the Wyze camera name a device gets unless it overrides it (`pages/devices.wyzeCameraName`) |
| `camera_config_version` | 0; `db.bumpCameraConfigVersion` (+1) on any Wyze / pattern / per-device camera-source change | manifest `camera_config_version`: the player refetches `GET /api/camera-config` when it differs from the one it applied |
| `alert_offline_minutes` | 10 (`db.isAlertOfflineMinutes`: integer 1-1440; never below the Devices page's 180 s) | `alerts.conditions`: a device whose last sync is older is `offline` |
| `alert_repeat_minutes` | 240 (`db.isAlertRepeatMinutes`: integer 0-10080; 0 = never) | an alert still open this long after its last notification is sent again |
| `alert_email` | `''` (`db.parseEmails`: one or more addresses, comma-separated; the row is deleted when empty) | email channel destinations (`ALERT_MAIL` binding, sender `alerts.EMAIL_FROM`) |
| `alert_webhook_url` | `''` (`db.isWebhookUrl`: absolute https, no credentials, <= 2048) | webhook channel |
| `projector_lead_minutes` / `projector_idle_minutes` | 3 / 10 (`db.isProjectorMinutes`: integer 0-1440; a junk row reads as the default) | manifest `projector.want` (`manifest.projector_want`): on from `lead` minutes before the next schedule rule starts, off once nothing has been active for `idle` minutes. Stored (and audited) only when the form posts them |

**Remote updates (feature C).** `pages/devices.COMMANDS` gains `update-player`, `update-os`,
`update-all` (per-device buttons under Actions, each with a `data-confirm`); `POST /devices/update-all`
(editor+, form field `command` in `FLEET_COMMANDS`, default `update-player`) queues that command
for every device that is not already waiting for the same one (one `INSERT ... SELECT ... WHERE NOT
EXISTS`), audits `device_update_all` and redirects to `/devices?queued=<n>` (ok banner). The daemon
that starts after the update script ran reports once through `GET /api/sync/:id?update_status=<json>`
(`{ref, started, finished, ok, message, previous_version}`; `api.storeUpdateStatus`): stored in
`devices.last_update_at` (the report's `finished`, else now) / `last_update_ok` (1/0) /
`last_update_message` (<= 200) / `last_update_ref` (<= 100), audited `device_update_reported`; a value
that is not a JSON object is ignored so the sync never fails on it. `pages/devices.updateStatus(d, tz)`
renders it under the facts: `p.update-status.muted.small` "Update ok ..." or `.alert.error.update-status`
"Update failed ..." (ref, age + local time, message). A save of `/settings` that omits the three update
fields keeps their current values (older callers only post the four site fields).

**Operator API tokens** (`api_tokens`, migration 0003): the admin's own tokens live in the
"My API tokens" panel of `/settings`. `POST /settings/tokens` (`name`, 1-60 chars) mints
`p5k_<32 urlsafe chars>`, stores only its SHA-256 hex and renders the page with the plaintext
once (no redirect, so the secret never sits in a URL); `POST /settings/tokens/:id/revoke` deletes
the caller's own token (404 for anyone else's). The Users page does the same for any admin or
editor: `POST /users/:user_id/tokens` (400 for a viewer) and `POST /users/:user_id/tokens/:id/revoke`
(404 unless the token belongs to that user). `GET /api/operator/enrollment` with
`Authorization: Bearer p5k_...` (token owner must be editor or admin, else 401) answers
`{console_url, enrollment_key, groups: [{id, name}], playlists: [{id, name}], timezone,
wyze_configured}` (`wyze_configured` = `secrets.wyzeConfigured`: a Wyze email and password are set). Audit:
`api_token_created`, `api_token_revoked` (both carry the name, never the token) and
`api_token_used` at most once per hour per token (`last_used_at`).

Other limits stay env vars: `PIPLAYER_MAX_UPLOAD_BYTES` (5 GiB), `PIPLAYER_MAX_SCREENSHOT_BYTES`
(5 MiB), `PIPLAYER_MAX_CAMERA_BYTES` (2 MiB), `PIPLAYER_AUDIT_RETENTION_DAYS` (365). Read them with `envInt(env, name, fallback)`.
Optional `PIPLAYER_PUBLIC_BASE_URL`: when set, the Devices install snippet prints it as `CMS_URL`
and drops the "edit it if this Pi reaches the CMS another way" note (`pages/devices.installBaseUrl`).

## Schema (`migrations/0001_init.sql`)

Identical to `cms/app/db.py` (users, media, playlists, playlist_items, device_groups, devices
incl. `last_error`, device_schedules, device_commands incl. `delivery_count`, audit_log, all
CHECKs/FKs/indexes) plus:

- `settings(key PK, value)`
- `sessions(id TEXT PK, user_id → users ON DELETE CASCADE (NULL = anonymous), csrf, created_at, expires_at)`
- `login_failures(id, ip, username, at INTEGER unix seconds)`
- `uploads(id TEXT PK, user_id, key, upload_id, name, size, sha256, media_type, duration_seconds, width, height, parts JSON '[]', received, created_at)`
- `meta(key PK, value)` with `schema_version = 1`

`migrations/0002_camera.sql` (schema_version 2) adds to `devices`: `last_camera_at TEXT`,
`camera_error TEXT` (player's last camera capture error, NULL = healthy) and `camera_live_url TEXT`
(validated https URL or NULL). `migrations/0003_automation.sql` (schema_version 3) adds
`api_tokens(id, user_id → users ON DELETE CASCADE, name, token_hash UNIQUE, created_at, last_used_at)`,
rebuilds `device_commands` (rename-copy-drop, rows and ids kept, index recreated) so its CHECK admits
`reboot`, `force-sync`, `restart-mpv`, `update-player`, `update-os`, `update-all`, `projector-on`,
`projector-off` and `ir-learn:%` (E reuses this, never rebuild again), and adds to `devices`:
`last_update_at TEXT`, `last_update_ok INTEGER`, `last_update_message TEXT`, `last_update_ref TEXT`;
for E: `projector_control TEXT NOT NULL DEFAULT 'none'` (CHECK none | broadlink | cec),
`projector_ir_codes TEXT` (JSON `{power_on, power_off, input_hdmi1}` base64 packets or NULL),
`broadlink_host TEXT`, `projector_power_mode TEXT NOT NULL DEFAULT 'manual'` (CHECK manual | auto),
`projector_power_state TEXT`, `projector_error TEXT`; for G: `tunnel_id TEXT`, `tunnel_hostname TEXT` (the
Cloudflare Tunnel id and public hostname; the token is never stored).
The test harness applies every file in `migrations/` in order
(`vitest.config.js` readD1Migrations + `test/apply-migrations.js`), so a new migration needs no wiring.

Foreign keys are enforced by D1. Add columns with a new `migrations/000N_*.sql`, never by editing 0001.

## Secrets (`secrets.js`, table `secrets`, migration 0003)

Operator credentials the players need (the Wyze account; later Twilio). `set(env, name, value)`
(empty deletes) / `get` / `getMany(names)` / `names()` (a Set of the names whose value still decrypts: the
"set / not set" badges). Values are AES-256-GCM under a key HKDF-derived from `SESSION_SECRET` (info
`p5k-secrets`, `secrets.HKDF_INFO`), stored as `v1:<iv b64url>:<ciphertext b64url>` with the
name bound as additional data; `decrypt` answers null (never throws) for a tampered value or
one written under another `SESSION_SECRET`, so rotating that secret reads as "not set". Nothing
renders a plaintext: the only reader is `GET /api/camera-config` (device bearer).

**Camera zero-config (feature D).** `/settings` panel "Wyze account": `POST /settings/wyze`
(admin) with `wyze_email`, `wyze_password`, `wyze_api_id`, `wyze_api_key` (each: filled replaces,
empty keeps; <= 500 printable chars) and `wyze_camera_pattern`; `POST /settings/wyze/clear` deletes
the four. Both bump `camera_config_version` when something changed and audit
`wyze_settings_update` (`{field: "set"}`, the pattern's value) / `wyze_settings_cleared`.
Devices row "Camera" `<details>` gains `POST /devices/:id/camera-source` (editor+): `camera_source`
`''` = site default (row NULL; wyze when the account is set, else none) | `none` | `wyze` | `rtsp`
(`pages/devices.CAMERA_SOURCES`), `camera_rtsp_url` (`rtsp://` / `rtsps://`, required for rtsp),
`camera_wyze_name` (<= 100, empty = pattern); an unchanged save does not bump; audit
`device_set_camera_source` (source, name, `camera_rtsp_url: "set"`, never the URL).
`GET /api/camera-config/:device_id` (own device bearer; `pages/devices.cameraConfig`) answers
`{source: "none", version}` | `{source: "rtsp", rtsp_url, version}` | `{source: "wyze", version,
wyze: {email, password, api_id, api_key, camera}}`; wyze without an account and rtsp without a
URL both fall back to none. Audited `camera_config_fetched` at most once a day per device
(`devices.camera_config_audited_at`).

## Alerts (feature F, `alerts.js`, table `alerts`, migration 0003)

`alerts(id, device_id -> devices ON DELETE CASCADE, kind, opened_at, closed_at, notified_at)`:
one open row (`closed_at NULL`) per (device, kind). `conditions(deviceRow, settings, now)` returns
the active kinds (`alerts.KINDS`): `offline` (last_seen_at older than `alert_offline_minutes`,
never below `OFFLINE_AFTER_SECONDS`; a device that never synced has none; while offline no other
kind is evaluated, so those alerts neither open nor close), `mpv-down` (player_status),
`screenshot-stale` (last_screenshot_at set and > 3 x screenshot_interval), `sync-error`
(last_error), `update-failed` (last_update_ok = 0), `camera-error`, `projector-error`.
`evaluate(env, now)` (the `*/5` cron; `now` is injectable for tests) opens a row + audits
`alert_opened` (target device_id, `{kind}`), closes + audits `alert_closed` when the condition
clears, and re-stamps `notified_at` when `alert_repeat_minutes` (> 0) have passed; then one
`digest(events)` (`{subject, text}`: ALERT / RECOVERED / STILL OPEN lines) goes to every configured
channel (`configured(env, settings)`), returning `{opened, closed, repeated, sent, errors}`. A
channel failure is `console.error`ed and audited `alert_notify_failed` (target the channel,
`{error}`), never retried: `notified_at` is stamped before sending.

Channels (`send(env, settings, channel, msg)` -> null or an error string, never throws):
`email` = the `ALERT_MAIL` send_email binding (`wrangler.toml [[send_email]]`; `rawEmail()` builds
the RFC 5322 text, one `EmailMessage` per address; "not configured" when the binding is absent,
which the Settings page shows as a badge), `webhook` = `POST` JSON `{site, title, text, content,
message}` (`webhookPayload`; Slack / Discord / ntfy read one of those), `sms` = Twilio
`POST /2010-04-01/Accounts/{sid}/Messages.json` with basic auth and `From`/`To`/`Body` (`smsBody`,
<= 600 chars); the four `alerts.TWILIO_NAMES` live in `secrets`. Both HTTP channels use
`AbortSignal.timeout(10 s)`. `sendTest(env, settings, channel, username)` is the "Send test"
button.

Pages: `/settings` panel "Alerts": `POST /settings/alerts` (admin; thresholds, addresses, URL;
Twilio password inputs replace when filled / keep when empty; audit `alert_settings_update` with
credentials as `"set"`), `POST /settings/alerts/twilio/clear`, `POST /settings/alerts/test`
(`channel` in `alerts.CHANNELS`, 400 otherwise; redirects `?tested=<channel>` or
`?test_error=<channel>: <why>`; audit `alert_test_sent`). `/alerts` (`pages/alerts.js`, any role)
lists the open rows and the last 100 recovered; the dashboard's fourth card links there with the
open count (`alerts.openCount`); "Alerts" sits in the nav for every role. Closed rows older than
90 days are pruned by the nightly housekeeping (`alerts.housekeeping`).

## Camera feed (room camera on the Pi)

Mirrors the screenshot path end to end; the Pi side is `player/player/camera.py`, setup in
`docs/camera.md`.

| where | what |
|---|---|
| `POST /api/camera/:device_id` (`api.js` uploadCamera, shares `receiveJpeg` with screenshots) | bearer = own device; multipart, first file part, JPEG magic, `PIPLAYER_MAX_CAMERA_BYTES`; stores R2 `camera/<device_id>.jpg` (`media.putCamera`), stamps `last_camera_at`, clears `camera_error` |
| `GET /api/sync/:device_id?camera_error=` | trimmed to `MAX_SYNC_ERROR_LEN` (200), empty/absent -> NULL, stored in `devices.camera_error` on every sync |
| manifest | `camera_interval_seconds` from the `camera_interval` setting |
| `GET /devices/:id/camera` (`pages/devices.js`) | session users only, `image/jpeg`, `cache-control: no-store`, nosniff; 404 "no camera snapshot yet". The pages link it with `?t=<last_camera_at>` |
| `pages/devices.cameraScreen(d, opts)` | the `.device-screen.device-camera` thumb + `cam · <age>` chip + live/stale chip (stale = `> 3 × camera_interval`, set by `decorateDevices` as `camera_age` / `camera_stale`), then `camera_error` as `.alert.warn.small`; renders only the alert when there is no snapshot yet. Used by the Devices rows and the dashboard tiles |
| `POST /devices/:id/camera-url` (editor+) | form field `camera_live_url`: empty clears, else `liveUrl()` (absolute https, no credentials, <= 2048 chars) or 400; audit `device_set_camera_url` |
| Devices row "Camera" `<details>` | the live URL form (disabled for viewers), and when the stored URL passes `liveUrl()` again: a "Live" new-tab link and a `Show live` button (`public/app.js` `data-live-frame`) that copies the iframe's `data-src` into `src` on first click; the iframe is `sandbox="allow-same-origin allow-scripts" referrerpolicy="no-referrer"` and starts `hidden`. A stored value that fails validation is never rendered |
| delete device | removes `camera/<device_id>.jpg` alongside the screenshot |

## Projector power (feature E)

The Pi side is `player/player/projector.py` (Broadlink RM4 mini over IR, or HDMI-CEC); the
console holds the configuration, the learned codes and what the player last reported.

| where | what |
|---|---|
| Devices row "Projector" `<details>` (`pages/devices.projectorBlock`) | the state lamp (`projectorState(d)`: `.status.status-playing` on / `.status-offline` off / `.status-idle` unknown, from `projector_power_state`; the dashboard tiles show the same lamp when `projector_control` is not none, and the `projector_error` line whenever set), "wants on/off" (`decorateDevices` sets `projector_want` from the same rows as the active playlist), `projector_error` as `.alert.warn.small`, the form below, then for a control other than none the `Projector on` / `Projector off` buttons (commands), and for `broadlink` a learned / not-learned badge per code (`manifest.IR_CODE_NAMES`) and one `Learn <name>` button each (`ir-learn:<name>`; the RM4 listens 30 s) |
| `POST /devices/:id/projector` (editor+) | `projector_control` (`manifest.PROJECTOR_CONTROLS`, empty = none), `projector_power_mode` (`PROJECTOR_MODES`, empty = manual), `broadlink_host` (`BROADLINK_HOST_RE`: hostname or IP literal, empty = discover on the LAN); never touches the codes; audit `device_set_projector` |
| commands | `pages/devices.isCommand`: `COMMANDS` (now with `projector-on`, `projector-off`) or `ir-learn:<name>` with a known name; anything else is 400 "unknown command" |
| `POST /api/commands/:id/result` for an `ir-learn:<name>` command (`api.storeLearnedCode`) | the base64 packet in `code`, in a JSON-string `result` `{"learned": name, "code": b64}` (what the player sends), or the whole `result` when it is base64 (`IR_CODE_RE`, 20-4000 chars), is stored under `name` in `devices.projector_ir_codes` (`manifest.ir_codes` reads it back, dropping unknown names and junk); a "timeout" result changes nothing; audit `device_ir_code_learned` (device_id, name, never the packet) |
| `GET /api/sync/:id?projector_state=&projector_error=` | `projector_state` on \| off \| unknown (`manifest.PROJECTOR_STATES`; absent or junk keeps the stored value, so a player without projector support never resets it); `projector_error` trimmed to 200, empty/absent -> NULL like `camera_error` |
| manifest `projector` | `null` when `projector_control` is none (absence = feature off for the player), else `{control, mode, want: "on" \| "off", codes: {name: base64}, broadlink_host}` (`manifest.projector_block`); `want` = `projector_want(device, scheduleRows, groupPlaylistId, wall, settings)`: on while `pick_playlist` finds a playlist (device / group default included), from `projector_lead_minutes` before `schedules.next_start` starts, and while any of the last `projector_idle_minutes` minutes had a playlist; off otherwise. `auth.deviceFromHeader` selects the projector columns so the sync needs no extra statement; `manifest_for_device` reads the schedule rows once for the playlist, `next_rule` and `want` |

## Auto camera tunnel (feature G, `cloudflare.js`, migration 0003)

Cloud only. With the worker secrets `CF_API_TOKEN` (Account > Cloudflare Tunnel: Edit, Zone > DNS:
Edit, Account > Access: Apps and Policies: Edit), `CF_ACCOUNT_ID` and `CF_ZONE_ID` set
(`cloudflare.configured(env)`; `missing(env)` names what is not), every device gets its own
Cloudflare Tunnel so the console's Live embed needs no hand-made tunnel. Without them nothing in
the module is called: the Settings panel says "not configured", the Devices page hides the button
and the manual live URL keeps working.

| where | what |
|---|---|
| `cloudflare.provision(env, deviceId, emails)` | four idempotent steps over `fetch` to `api.cloudflare.com/client/v4` (bearer `CF_API_TOKEN`, 15 s timeout; a `success: false` envelope or a non-2xx answer throws `Cloudflare API <METHOD> <path>: <messages or HTTP status>`): tunnel `p5k-<device_id>` (`GET cfd_tunnel?name=&is_deleted=false`, else `POST` with `config_src: cloudflare`), `PUT .../configurations` with ingress `<hostname> -> http://127.0.0.1:5000` + `http_status:404`, the proxied CNAME `<device_id>-cam.<zone>` -> `<tunnel_id>.cfargotunnel.com` (`GET dns_records?type=CNAME&name=`, `POST`, or `PUT` when it points elsewhere), the Access self-hosted app on the hostname (`GET access/apps?domain=`, else `POST`) with one policy `p5k operators` (allow, `include: [{email}]`; `POST` or `PUT` so a changed operator list is applied on the next run). Returns `{tunnel_id, hostname}`; `hostnameFor(env, deviceId)` uses `CF_ZONE_NAME` or `photogen5000.com` |
| `cloudflare.operatorEmails(env, settings)` | who the Access policy allows: `db.parseEmails(settings.alert_email)`, else the admin usernames that are addresses, else null (provisioning refuses with "no operator email known") |
| `cloudflare.provisionDevice(ctx, {id, device_id})` / `tryProvisionDevice` | provision + `UPDATE devices SET tunnel_id, tunnel_hostname, camera_live_url = https://<hostname>/` + audit `device_tunnel_created` (`{device_id, tunnel_id, hostname, emails: n}`); the try variant never throws: it logs, audits `device_tunnel_failed` (`{device_id, error}`) and returns `{error}` |
| `POST /api/enroll` (`api.enroll`) | when configured, a first enrollment and a re-enrollment of a device without `tunnel_id` call `tryProvisionDevice` after the audit row; the enrollment answer never depends on it |
| `POST /devices/:id/tunnel` (editor+, `pages/devices.devicesCreateTunnel`) | the "Create tunnel" / "Recreate tunnel" button in the Camera block; 400 when not configured, 404 unknown device; redirects `?tunnel=<hostname>` or `?tunnel_error=<why>` and the page shows the banner. The block also shows the `tunnel · <hostname>` / `no tunnel` badge (every role) |
| `GET /api/sync/:id` (`api.tunnelBlock`) | manifest `tunnel`: `{token, hostname}` with the token from `GET cfd_tunnel/<id>/token` on every sync (never stored, never rendered; `auth.deviceFromHeader` selects `tunnel_id` / `tunnel_hostname`), `null` when the device has no tunnel, the secrets are unset or the API fails (the sync still answers; the player keeps the token it already wrote) |
| `/settings` panel "Camera tunnels (Cloudflare)" | configured / not configured badge with the missing secret names and the permissions, the zone, the operator emails the policy will get (or a warning to set `alert_email`), the count of devices with a tunnel. Read-only: the secrets are `wrangler secret put` |

Deleting a device leaves its tunnel, CNAME and Access app in Cloudflare (still gated by Access);
remove them by hand or recreate the device with the same id to reuse them.

## Tests

`test/helpers.js`: `Client` (cookie jar over `SELF.fetch`, `get/post/postJson/csrf/login`),
`setupAdmin(username, password)` (runs `/setup`, returns a logged-in client), `query(sql, ...params)`,
`SETUP_TOKEN`. Storage is isolated per test; `beforeAll` writes are visible to the file's tests.
Note the worker caches "users exist" per isolate, so create the admin in `beforeAll` and never
expect the `/setup` redirect after that in the same file.
