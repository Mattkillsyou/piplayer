// /settings (admin only, cloud-only page): site timezone, screenshot and camera intervals,
// default image duration, the group/playlist new devices get on first enrollment and the remote
// update policy (player release, nightly auto-update + window), stored in the settings table
// (db.loadSettings / saveSetting), plus the device enrollment key (shown
// masked, rotatable; POST /api/enroll checks it) and the admin's personal API tokens
// (api_tokens; the flasher presents one on GET /api/operator/enrollment to fetch that key),
// and the Wyze account for camera zero-config (encrypted in `secrets`, shown only as set /
// not set; every player fetches it through GET /api/camera-config).
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as db from "../db.js";
import * as secrets from "../secrets.js";
import { esc, fail, floatField, idParam, intField, isValidTimeZone, localTime, nowUtc, redirect, str, zoneName } from "../util.js";
import { alertBox, csrfInput, layout } from "./layout.js";

export const MIN_SCREENSHOT_INTERVAL = 15;
export const MIN_CAMERA_INTERVAL = 5;
export const MAX_TOKEN_NAME = 60;

function timeZoneOptions() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

// <option>s for a nullable-id select; a stored id whose row was deleted matches nothing = none.
function optionList(rows, selected) {
  return rows.map((r) => `<option value="${r.id}"${r.id === selected ? " selected" : ""}>${esc(r.name)}</option>`).join("\n          ");
}

// Shared with the Users page (admins manage any user's tokens there): the create form, the
// shown-once plaintext block and the token table. `revokePath(t)` names the revoke route.
export const userTokens = (env, userId) => db.all(env,
  "SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC", userId);

// Validated name from a create form, or 400.
export function tokenName(form) {
  const name = str(form, "name").trim();
  if (!name || [...name].length > MAX_TOKEN_NAME) fail(400, `name must be 1-${MAX_TOKEN_NAME} chars`);
  return name;
}

export const newTokenBlock = (newToken) => (newToken ? `<div class="alert ok" role="alert">New token (copy it now, it is not shown again):</div>
  <div class="enrollment-key">
    <label for="new-api-token" class="small">Token</label>
    <input type="text" id="new-api-token" value="${esc(newToken)}" readonly spellcheck="false" autocomplete="off">
  </div>` : "");

export const tokenCreateForm = (ctx, action, label = "Token name") => `<form method="post" action="${action}" class="inline">
    ${csrfInput(ctx)}
    <input type="text" name="name" placeholder="token name (e.g. office laptop)" maxlength="${MAX_TOKEN_NAME}" required autocomplete="off" aria-label="${esc(label)}">
    <button type="submit" class="primary small">Create token</button>
  </form>`;

export function tokenTable(ctx, tokens, tz, revokePath) {
  if (!tokens.length) return "";
  const rows = tokens.map((t) => `<tr>
      <td class="name">${esc(t.name)}</td>
      <td class="muted nowrap">${esc(localTime(t.created_at, tz))}</td>
      <td class="muted nowrap">${t.last_used_at ? esc(localTime(t.last_used_at, tz)) : "never"}</td>
      <td>
        <form method="post" action="${revokePath(t)}" class="inline" data-confirm="Revoke the token ${esc(t.name)}? Flashers using it stop working.">
          ${csrfInput(ctx)}
          <button type="submit" class="danger small">Revoke</button>
        </form>
      </td>
    </tr>`).join("\n    ");
  return `<div class="table-wrap">
  <table class="data">
    <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead>
    <tbody>
    ${rows}
    </tbody>
  </table>
  </div>`;
}

// The admin's own tokens (never the hash) and the create form; `newToken` is the plaintext
// of a token created by this very request, shown once and never again.
async function tokensPanel(ctx, me, newToken, tz) {
  const tokens = await userTokens(ctx.env, me.id);
  return `<div class="panel">
  <h2>My API tokens</h2>
  <p class="muted small">Personal tokens for the flasher (<code>GET /api/operator/enrollment</code>, <code>Authorization: Bearer p5k_...</code>): it fetches the current enrollment key on every launch, so cards never carry a stale key. A token acts with your role; revoke it if the machine holding it is lost. Tokens for other admins and editors are issued on the <a href="/users">Users</a> page.</p>
  ${newTokenBlock(newToken)}
  ${tokenCreateForm(ctx, "/settings/tokens")}
  ${tokenTable(ctx, tokens, tz, (t) => `/settings/tokens/${t.id}/revoke`)}
</div>`;
}

// Wyze account: four password inputs that replace the stored value when filled and keep it
// when left empty, the camera name pattern, and a Clear button. Values are never rendered.
const WYZE_FIELDS = [["wyze_email", "Wyze account email"], ["wyze_password", "Wyze account password"],
  ["wyze_api_id", "API key id"], ["wyze_api_key", "API key"]];

async function wyzePanel(ctx, s) {
  const have = await secrets.names(ctx.env);
  const badge = (n) => (have.has(n) ? '<span class="badge badge-active">set</span>' : '<span class="badge badge-muted">not set</span>');
  const configured = have.has("wyze_email") && have.has("wyze_password");
  return `<div class="panel">
  <h2>Wyze account (camera zero-config)</h2>
  <p class="muted small">Players fetch these credentials over their own device token (<code>GET /api/camera-config</code>) and run the Wyze bridge with them, so a freshly flashed Pi shows its camera without any per-device setup. Stored encrypted; never shown again. Status: <strong>${configured ? "configured" : "not configured"}</strong>${configured ? "" : " (the flasher's provision script only installs the bridge once an email and password are set)"}.</p>
  <form method="post" action="/settings/wyze">
    ${csrfInput(ctx)}
    <div class="form-grid">
      ${WYZE_FIELDS.map(([n, label]) => `<label>${label} ${badge(n)}
        <input type="password" name="${n}" value="" placeholder="${have.has(n) ? "leave empty to keep" : "not set"}" autocomplete="off" spellcheck="false" maxlength="500">
      </label>`).join("\n      ")}
      <label>Camera name pattern
        <input type="text" name="wyze_camera_pattern" value="${esc(s.wyze_camera_pattern)}" placeholder="${esc(db.DEFAULT_WYZE_CAMERA_PATTERN)}" maxlength="100" required>
      </label>
    </div>
    <p class="help small">The API key id and key come from the Wyze developer portal. The pattern names each device's camera in the Wyze app: <code>{device_name}</code> and <code>{device_id}</code> are substituted; a device can override it on the Devices page. Saving any change bumps <code>camera_config_version</code> (now ${s.camera_config_version}) so every player refetches on its next sync.</p>
    <div class="row">
      <button type="submit" class="primary">Save Wyze settings</button>
    </div>
  </form>
  ${configured || have.size ? `<form method="post" action="/settings/wyze/clear" class="inline" data-confirm="Clear the Wyze account? Players lose their camera on the next sync.">
    ${csrfInput(ctx)}
    <button type="submit" class="danger">Clear Wyze account</button>
  </form>` : ""}
</div>`;
}

async function settingsPage(ctx, newToken = "") {
  const me = auth.requireRole(ctx, "admin");
  const s = await ctx.settings();
  const groups = await db.all(ctx.env, "SELECT id, name FROM device_groups ORDER BY name");
  const playlists = await db.all(ctx.env, "SELECT id, name FROM playlists ORDER BY name");
  const saved = ctx.url.searchParams.get("saved") === "1";
  const rotated = ctx.url.searchParams.get("rotated") === "1";
  const revoked = ctx.url.searchParams.get("revoked") === "1";
  const content = `<div class="page-head">
  <h1>Settings</h1>
  <span class="page-meta"><strong>site time ${esc(localTime(nowUtc(), s.timezone))}</strong><br>schedules, the audit log and every timestamp on these pages use this zone</span>
</div>
${saved ? alertBox("Settings saved.", "ok") : ""}
${rotated ? alertBox("Enrollment key rotated. Cards flashed with the old key must be re-flashed.", "ok") : ""}
${revoked ? alertBox("API token revoked.", "ok") : ""}

<div class="panel">
  <h2>Site settings</h2>
  <form method="post" action="/settings">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <label>Site timezone (IANA name)
        <input type="text" name="timezone" value="${esc(s.timezone)}" list="tz-list" placeholder="America/Los_Angeles" required>
        <datalist id="tz-list">
          ${timeZoneOptions().map((tz) => `<option value="${esc(tz)}">`).join("\n          ")}
        </datalist>
      </label>
      <label>Screenshot interval (seconds, at least ${MIN_SCREENSHOT_INTERVAL})
        <input type="number" name="screenshot_interval" value="${esc(s.screenshot_interval)}" min="${MIN_SCREENSHOT_INTERVAL}" step="1" required>
      </label>
      <label>Camera snapshot interval (seconds, at least ${MIN_CAMERA_INTERVAL})
        <input type="number" name="camera_interval" value="${esc(s.camera_interval)}" min="${MIN_CAMERA_INTERVAL}" step="1" required>
      </label>
      <label>Default image duration (seconds)
        <input type="number" name="default_image_duration" value="${esc(s.default_image_duration)}" min="0.5" max="86400" step="0.5" required>
      </label>
      <label>New devices join group
        <select name="enroll_group_id">
          <option value="">— none —</option>
          ${optionList(groups, s.enroll_group_id)}
        </select>
      </label>
      <label>New devices get playlist
        <select name="enroll_playlist_id">
          <option value="">— none —</option>
          ${optionList(playlists, s.enroll_playlist_id)}
        </select>
      </label>
    </div>
    <p class="help small">Zone ${esc(zoneName(s.timezone))}. The screenshot interval is sent to every player on its next sync; a device is flagged stale after 3 intervals without a screenshot; the camera interval works the same way for room camera snapshots. The image duration applies to images without a per-item override. The group and playlist are applied when a device enrolls for the first time (<code>POST /api/enroll</code>); re-enrolling a known device keeps its current assignment.</p>
    <h3>Player updates</h3>
    <div class="form-grid">
      <label>Player release (git tag, branch or sha)
        <input type="text" name="player_release" value="${esc(s.player_release)}" placeholder="main" maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._/-]{0,99}" required>
      </label>
      <label>Auto-update
        <select name="auto_update">
          ${db.AUTO_UPDATE_MODES.map((m) => `<option value="${m}"${m === s.auto_update ? " selected" : ""}>${m}</option>`).join("\n          ")}
        </select>
      </label>
      <label>Auto-update window (site time, HH:MM-HH:MM)
        <input type="text" name="auto_update_window" value="${esc(s.auto_update_window)}" placeholder="03:00-05:00" pattern="([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d" required>
      </label>
    </div>
    <p class="help small">"Update player" on the Devices page (and "Update all players") checks this release out on the Pi and reinstalls the player. With auto-update <code>nightly</code> every player does the same by itself inside the window, at most once a day, and skips when it is already on that release. Each Pi reports the outcome on its next sync (Devices page).</p>
    <div class="row">
      <button type="submit" class="primary">Save settings</button>
    </div>
  </form>
</div>

<div class="panel">
  <h2>Device enrollment</h2>
  <p class="muted small">The flasher fetches this key with an API token (below) and writes it to every card; a Pi presents it on first boot (<code>POST /api/enroll</code>) and receives its own device token. Rotate it if a card is lost: cards flashed with the old key that have not booted yet stop working.</p>
  <div class="enrollment-key">
    <label for="enrollment-key" class="small">Enrollment key</label>
    <input type="password" id="enrollment-key" value="${esc(s.enrollment_key)}" readonly spellcheck="false" autocomplete="off">
    <button type="button" class="small" data-reveal="enrollment-key">Show</button>
  </div>
  <form method="post" action="/settings/enrollment/rotate" class="inline" data-confirm="Rotate the enrollment key? Cards flashed with the old key that have not booted yet will fail to enroll.">
    ${csrfInput(ctx)}
    <button type="submit" class="danger">Rotate key</button>
  </form>
</div>

${await wyzePanel(ctx, s)}

${await tokensPanel(ctx, me, newToken, s.timezone)}`;
  return layout(ctx, { title: "Settings", content });
}

async function settingsSave(ctx) {
  auth.requireRole(ctx, "admin");
  const form = await ctx.form();
  const timezone = str(form, "timezone").trim();
  if (!isValidTimeZone(timezone)) fail(400, "timezone must be a valid IANA name (e.g. America/Los_Angeles)");
  const interval = intField(str(form, "screenshot_interval"), "screenshot_interval");
  if (interval === null) fail(400, "screenshot_interval required");
  if (interval < MIN_SCREENSHOT_INTERVAL) fail(400, `screenshot_interval must be at least ${MIN_SCREENSHOT_INTERVAL} seconds`);
  const camera = intField(str(form, "camera_interval"), "camera_interval");
  if (camera === null) fail(400, "camera_interval required");
  if (camera < MIN_CAMERA_INTERVAL) fail(400, `camera_interval must be at least ${MIN_CAMERA_INTERVAL} seconds`);
  const duration = floatField(str(form, "default_image_duration"), "default_image_duration",
    "default_image_duration must be a positive number");
  if (duration === null) fail(400, "default_image_duration required");
  if (duration <= 0 || duration > 86400) fail(400, "default_image_duration must be a positive number of seconds (at most 86400)");
  const enrollGroup = intField(str(form, "enroll_group_id"), "enroll_group_id");
  if (enrollGroup !== null && !(await db.first(ctx.env, "SELECT id FROM device_groups WHERE id = ?", enrollGroup))) fail(400, "enroll_group_id: unknown group");
  const enrollPlaylist = intField(str(form, "enroll_playlist_id"), "enroll_playlist_id");
  if (enrollPlaylist !== null && !(await db.first(ctx.env, "SELECT id FROM playlists WHERE id = ?", enrollPlaylist))) fail(400, "enroll_playlist_id: unknown playlist");
  // Update policy: an omitted (empty) field keeps its current value, so older callers that
  // only post the four site fields never lose it.
  const current = await ctx.settings();
  const release = str(form, "player_release").trim() || current.player_release;
  if (!db.isGitRef(release)) fail(400, "player_release must be a git tag, branch or sha (letters, digits, . _ / -; at most 100 chars)");
  const autoUpdate = str(form, "auto_update").trim() || current.auto_update;
  if (!db.AUTO_UPDATE_MODES.includes(autoUpdate)) fail(400, `auto_update must be one of ${db.AUTO_UPDATE_MODES.join(", ")}`);
  const window = str(form, "auto_update_window").trim() || current.auto_update_window;
  if (!db.UPDATE_WINDOW_RE.test(window)) fail(400, "auto_update_window must be HH:MM-HH:MM (24-hour, site time)");
  const values = { timezone, screenshot_interval: interval, camera_interval: camera, default_image_duration: duration,
    enroll_group_id: enrollGroup, enroll_playlist_id: enrollPlaylist,
    player_release: release, auto_update: autoUpdate, auto_update_window: window };
  // null (none) deletes the row so the settings table only holds what is set
  await db.batch(ctx.env, Object.entries(values).map(([k, v]) => (v === null
    ? ["DELETE FROM settings WHERE key = ?", k]
    : ["INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, String(v)])));
  await audit.log(ctx, "settings_update", "settings", null, values);
  return redirect("/settings?saved=1");
}

// Filled fields replace, empty keep; the audit row says which changed, never a value.
async function wyzeSave(ctx) {
  auth.requireRole(ctx, "admin");
  const form = await ctx.form();
  const current = await ctx.settings();
  const pattern = str(form, "wyze_camera_pattern").trim() || current.wyze_camera_pattern;
  if (!db.isCameraPattern(pattern)) fail(400, "wyze_camera_pattern must be 1-100 printable chars");
  const changed = {};
  for (const [name] of WYZE_FIELDS) {
    const v = str(form, name);
    if (!v) continue;
    if (v.length > 500 || /[\x00-\x1f\x7f]/.test(v)) fail(400, `${name} must be at most 500 printable chars`);
    changed[name] = v;
  }
  for (const [name, v] of Object.entries(changed)) await secrets.set(ctx.env, name, v);
  if (pattern !== current.wyze_camera_pattern) {
    await db.saveSetting(ctx.env, "wyze_camera_pattern", pattern);
    changed.wyze_camera_pattern = pattern;
  }
  if (Object.keys(changed).length) {
    await db.bumpCameraConfigVersion(ctx.env);
    await audit.log(ctx, "wyze_settings_update", "settings", "wyze",
      Object.fromEntries(Object.keys(changed).map((k) => [k, k === "wyze_camera_pattern" ? pattern : "set"])));
  }
  return redirect("/settings?saved=1");
}

async function wyzeClear(ctx) {
  auth.requireRole(ctx, "admin");
  for (const name of secrets.WYZE_NAMES) await secrets.set(ctx.env, name, "");
  await db.bumpCameraConfigVersion(ctx.env);
  await audit.log(ctx, "wyze_settings_cleared", "settings", "wyze");
  return redirect("/settings?saved=1");
}

async function enrollmentRotate(ctx) {
  auth.requireRole(ctx, "admin");
  await db.generateEnrollmentKey(ctx.env);
  await audit.log(ctx, "enrollment_key_rotated", "settings", "enrollment_key");
  return redirect("/settings?rotated=1");
}

// Create a token and render the page with the plaintext once (no redirect: the secret must
// not travel in a URL). Only the hash is stored; the audit row carries the name, never the token.
async function tokenCreate(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const name = tokenName(await ctx.form());
  const token = auth.newApiToken();
  const id = (await db.run(ctx.env, "INSERT INTO api_tokens (user_id, name, token_hash) VALUES (?, ?, ?)",
    me.id, name, await auth.apiTokenHash(token))).last_row_id;
  await audit.log(ctx, "api_token_created", "api_token", id, { name });
  return settingsPage(ctx, token);
}

async function tokenRevoke(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const tokenId = idParam(ctx.params.token_id, "token_id");
  const row = await db.first(ctx.env, "SELECT id, name FROM api_tokens WHERE id = ? AND user_id = ?", tokenId, me.id);
  if (!row) fail(404, "token not found");
  await db.run(ctx.env, "DELETE FROM api_tokens WHERE id = ?", tokenId);
  await audit.log(ctx, "api_token_revoked", "api_token", tokenId, { name: row.name });
  return redirect("/settings?revoked=1");
}

export function register(router) {
  router.post("/settings/tokens", tokenCreate);
  router.post("/settings/tokens/:token_id/revoke", tokenRevoke);
  router.get("/settings", settingsPage);
  router.post("/settings", settingsSave);
  router.post("/settings/enrollment/rotate", enrollmentRotate);
  router.post("/settings/wyze", wyzeSave);
  router.post("/settings/wyze/clear", wyzeClear);
}
