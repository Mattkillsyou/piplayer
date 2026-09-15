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
| e2e | `python e2e/run_e2e.py --port <your port> --persist-to <dir>` (starts + migrates + kills wrangler dev itself; append your checks to `CHECKS`) |
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

`scheduled` (cron `0 3 * * *`): calls `housekeeping(env)` of every module that exports one, each
in its own try/catch. Locally: `wrangler dev --test-scheduled` then `GET /__scheduled?cron=0+3+*+*+*`.

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
  settings(),        // Promise<{timezone, screenshot_interval, default_image_duration}>, memoised
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
| `loginLockedFor(env, ip, username)` / `recordLoginFailure` / `clearLoginFailures` | D1 `login_failures`; 5 failures in 30 s → seconds remaining |
| `deviceFromHeader(ctx)` | `{id, device_id, name, playlist_id, group_id}` for `Authorization: Bearer <token>`; 401 `"Missing bearer token"` / `"Invalid device token"`. The path `device_id` must equal `row.device_id` else 403 — your check |
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
(+ new: `settings_update`). `audit.clientIp(ctx)` is exported too.

## pages/layout.js

```js
import { layout, csrfInput, alertBox, APP_NAME } from "./layout.js";
return layout(ctx, { title: "Devices", content, status: 200, message: "", messageKind: "error", scripts: ["/static/sortable.min.js"] });
```
`layout()` is a plain function (not middleware): it wraps `content` (already-escaped HTML) in
base.html's shell — `<meta name="csrf-token">`, the nav with active states (`Users` and `Settings`
for admins only), the user badge + logout form, the message slot (`alertBox`), then `scripts`
and `/static/app.js`. No nav when `ctx.user` is null (login/setup). Titles render as
`"<title> — PiPlayer"`. Put `${csrfInput(ctx)}` inside **every** `<form method="post">`.

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
| `default_image_duration` | `PIPLAYER_DEFAULT_IMAGE_DURATION` (10) | effective duration of images |

Other limits stay env vars: `PIPLAYER_MAX_UPLOAD_BYTES` (5 GiB), `PIPLAYER_MAX_SCREENSHOT_BYTES`
(5 MiB), `PIPLAYER_AUDIT_RETENTION_DAYS` (365). Read them with `envInt(env, name, fallback)`.
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

Foreign keys are enforced by D1. Add columns with a new `migrations/000N_*.sql`, never by editing 0001.

## Tests

`test/helpers.js`: `Client` (cookie jar over `SELF.fetch`, `get/post/postJson/csrf/login`),
`setupAdmin(username, password)` (runs `/setup`, returns a logged-in client), `query(sql, ...params)`,
`SETUP_TOKEN`. Storage is isolated per test; `beforeAll` writes are visible to the file's tests.
Note the worker caches "users exist" per isolate, so create the admin in `beforeAll` and never
expect the `/setup` redirect after that in the same file.
