// /settings (admin only, cloud-only page): site timezone, screenshot and camera intervals,
// default image duration, the group/playlist new devices get on first enrollment and the remote
// update policy (player release, nightly auto-update + window), stored in the settings table
// (db.loadSettings / saveSetting), plus the device enrollment key (shown
// masked, rotatable; POST /api/enroll checks it) and the admin's personal API tokens
// (api_tokens; the flasher presents one on GET /api/operator/enrollment to fetch that key),
// and the Wyze account for camera zero-config (encrypted in `secrets`, shown only as set /
// not set; every player fetches it through GET /api/camera-config), and the alert channels
// (offline / repeat minutes, email addresses, webhook URL, Twilio SMS in `secrets`; each with
// a Send test button; alerts.js), and the automatic camera tunnel status (cloudflare.js: the
// three worker secrets are set or not; read-only, `wrangler secret put` sets them).
import * as alerts from "../alerts.js";
import * as audit from "../audit.js";
import * as auth from "../auth.js";
import * as cloudflare from "../cloudflare.js";
import * as db from "../db.js";
import * as secrets from "../secrets.js";
import { esc, fail, floatField, idParam, intField, isValidTimeZone, localTime, nowUtc, str, zoneName } from "../util.js";
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
  if (!name || [...name].length > MAX_TOKEN_NAME) fail(400, `Token name must be 1-${MAX_TOKEN_NAME} characters`);
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
    <caption class="sr-only">API tokens</caption>
    <thead><tr><th scope="col">Name</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
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
  <p class="muted small">Every Pi fetches this Wyze login on its own and uses it to show its camera, so a freshly flashed Pi needs no per-device setup. Stored encrypted; never shown again. Status: <strong>${configured ? "configured" : "not configured"}</strong>${configured ? "" : " (the flasher's provision script only installs the bridge once an email and password are set)"}.</p>
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
    <p class="help small">The API key id and key come from the Wyze developer portal. The pattern names each device's camera in the Wyze app: <code>{device_name}</code> and <code>{device_id}</code> are substituted; a device can override it on the Devices page. Saving any change makes every player pick up the new camera settings on its next sync.</p>
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

// Alert channels: thresholds, addresses, webhook, Twilio (password inputs: filled replaces,
// empty keeps, like the Wyze panel) and one Send test button per channel.
const TWILIO_FIELDS = [["twilio_account_sid", "Twilio account SID"], ["twilio_auth_token", "Twilio auth token"],
  ["twilio_from", "Text messages from (phone number with country code, e.g. +15551234567)"], ["twilio_to", "Text messages to (phone number with country code, e.g. +15551234567)"]];

async function alertsPanel(ctx, s) {
  const have = await secrets.names(ctx.env);
  const c = await alerts.configured(ctx.env, s);
  const badge = (on, text = on ? "configured" : "not configured") => `<span class="badge ${on ? "badge-active" : "badge-muted"}">${text}</span>`;
  const setBadge = (n) => `<span class="badge ${have.has(n) ? "badge-active" : "badge-muted"}" title="Twilio credential">${have.has(n) ? "set" : "not set"}</span>`;
  const testForm = (channel, enabled) => `<form method="post" action="/settings/alerts/test" class="inline">
      ${csrfInput(ctx)}
      <input type="hidden" name="channel" value="${channel}">
      <button type="submit" class="small"${enabled ? "" : " disabled"}>Send test ${channel}</button>
    </form>`;
  return `<div class="panel">
  <h2>Alerts</h2>
  <p class="muted small">Every 5 minutes the console checks each device for: ${alerts.KINDS.map((k) => esc(alerts.KIND_TEXT[k] || k)).join(", ")}. An alert opens once per device and condition, is sent again while it stays open (repeat interval), and a recovery message follows when it clears. <a href="/alerts">Open and recent alerts</a>.</p>
  <form method="post" action="/settings/alerts">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <label>Offline after (minutes without a sync)
        <input type="number" name="alert_offline_minutes" value="${esc(s.alert_offline_minutes)}" min="1" max="1440" step="1" required>
      </label>
      <label>Repeat while open (minutes, 0 = never)
        <input type="number" name="alert_repeat_minutes" value="${esc(s.alert_repeat_minutes)}" min="0" max="10080" step="1" required>
      </label>
      <label>Email ${badge(c.email)}${c.email && !c.email_binding ? ' <span class="badge badge-stale">mail binding missing</span>' : ""}
        <input type="email" multiple name="alert_email" value="${esc(s.alert_email)}" placeholder="you@example.net, team@example.net" maxlength="1000" autocomplete="off">
      </label>
      <label>Webhook URL ${badge(c.webhook)}
        <input type="url" name="alert_webhook_url" value="${esc(s.alert_webhook_url)}" placeholder="https://hooks.slack.com/services/..." pattern="https://.*" maxlength="2048" autocomplete="off" spellcheck="false">
      </label>
      ${TWILIO_FIELDS.map(([n, label]) => `<label>${label} ${setBadge(n)}
        <input type="password" name="${n}" value="" placeholder="${have.has(n) ? "leave empty to keep" : "not set"}" autocomplete="off" spellcheck="false" maxlength="200">
      </label>`).join("\n      ")}
    </div>
    <p class="help small">Email is sent from <code>${esc(alerts.EMAIL_FROM)}</code> through Cloudflare Email Routing (each destination must be verified there; comma-separate several). ${cloudflare.configured(ctx.env) ? "These addresses are also the only people allowed to open a device's live camera page (Cloudflare Access); saving updates every device's camera access. " : ""}The webhook gets a JSON POST with <code>title</code>, <code>text</code>, <code>content</code> and <code>message</code>, so a Slack, Discord or ntfy URL works as is. SMS ${badge(c.sms)}: Twilio credentials are stored encrypted and never shown again.</p>
    <div class="row">
      <button type="submit" class="primary">Save alert settings</button>
    </div>
  </form>
  <div class="row">
    ${testForm("email", c.email)}
    ${testForm("webhook", c.webhook)}
    ${testForm("sms", c.sms)}
    ${alerts.TWILIO_NAMES.some((n) => have.has(n)) ? `<form method="post" action="/settings/alerts/twilio/clear" class="inline" data-confirm="Clear the Twilio credentials? SMS alerts stop.">
      ${csrfInput(ctx)}
      <button type="submit" class="danger small">Clear Twilio</button>
    </form>` : ""}
  </div>
</div>`;
}

// Automatic camera tunnels (G): configured when CF_API_TOKEN, CF_ACCOUNT_ID and CF_ZONE_ID are
// set as worker secrets (never entered here), which of the three are missing otherwise, the
// zone the hostnames go under and the operator emails the Access policy will allow.
async function tunnelPanel(ctx, s) {
  const on = cloudflare.configured(ctx.env);
  const emails = await cloudflare.operatorEmails(ctx.env, s);
  const badge = (ok, text) => `<span class="badge ${ok ? "badge-active" : "badge-muted"}">${text}</span>`;
  const n = (await db.first(ctx.env, "SELECT COUNT(*) AS n FROM devices WHERE tunnel_id IS NOT NULL")).n;
  return `<div class="panel">
  <h2>Camera tunnels (Cloudflare) ${badge(on, on ? "configured" : "not configured")}</h2>
  <p class="muted small">With the worker secrets set, every device gets its own private camera address when it enrolls (or from "Create tunnel" on the Devices page): <code>&lt;device_id&gt;-cam.${esc(cloudflare.zoneName(ctx.env))}</code>, which only the operators below can open (Cloudflare Access). The Pi receives the tunnel key on its next sync; nothing is stored here.${on ? "" : ` Missing: ${cloudflare.missing(ctx.env).map((k) => `<code>${k}</code>`).join(", ")} (set as worker secrets by whoever deploys the console; the API token needs Account &gt; Cloudflare Tunnel: Edit, Zone &gt; DNS: Edit, Account &gt; Access: Apps and Policies: Edit). Until then, paste a live URL per device.`}</p>
  <p class="muted small">Operator emails (Access policy): ${emails ? emails.map((e) => `<code>${esc(e)}</code>`).join(", ") : '<span class="badge badge-stale">none</span> set the alert email addresses above (or make an admin username an email address) before creating a tunnel'}. Devices with a tunnel: ${n}.</p>
</div>`;
}

async function settingsPage(ctx, newToken = "") {
  const me = auth.requireRole(ctx, "admin");
  const s = await ctx.settings();
  const groups = await db.all(ctx.env, "SELECT id, name FROM device_groups ORDER BY name");
  const playlists = await db.all(ctx.env, "SELECT id, name FROM playlists ORDER BY name");
  const content = `<div class="page-head">
  <h1>Settings</h1>
  <span class="page-meta"><strong>site time ${esc(localTime(nowUtc(), s.timezone))}</strong><br>schedules, the audit log and every timestamp on these pages use this zone</span>
</div>
<div class="panel">
  <h2>Site settings</h2>
  ${s.timezone_problem ? alertBox(`The saved timezone "${s.timezone_problem}" is no longer accepted, so the console is using UTC. Pick a timezone from the list and save.`, "warn") : ""}
  <form method="post" action="/settings">
    ${csrfInput(ctx)}
    <div class="form-grid">
      <label>Site timezone (e.g. America/New_York)
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
    <p class="help small">Zone ${esc(zoneName(s.timezone))}. The screenshot interval is sent to every player on its next sync; a device is flagged stale after 3 intervals without a screenshot; the camera interval works the same way for room camera snapshots. The image duration applies to images without a per-item override. The group and playlist are applied when a new Pi enrolls for the first time; a known device that enrolls again keeps its current assignment.</p>
    <h3>Player updates</h3>
    <div class="form-grid">
      <label>Player software version (release name)
        <input type="text" name="player_release" value="${esc(s.player_release)}" placeholder="main" maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._/-]{0,99}" required>
      </label>
      <label>Auto-update
        <select name="auto_update">
          ${db.AUTO_UPDATE_MODES.map((m) => `<option value="${m}"${m === s.auto_update ? " selected" : ""}>${m}</option>`).join("\n          ")}
        </select>
      </label>
      <label>Auto-update window (HH:MM-HH:MM, on the Pi's clock, which is set to the site timezone when the card is flashed)
        <input type="text" name="auto_update_window" value="${esc(s.auto_update_window)}" placeholder="03:00-05:00" pattern="([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]" required>
      </label>
    </div>
    <p class="help small">"Update player" on the Devices page (and "Update all players") checks this release out on the Pi and reinstalls the player. With auto-update <code>nightly</code> every player does the same by itself inside the window, at most once a day, and skips when it is already on that release. Each Pi reports the outcome on its next sync (Devices page).</p>
    <h3>Projector power</h3>
    <div class="form-grid">
      <label>Switch on before a schedule starts (minutes)
        <input type="number" name="projector_lead_minutes" value="${esc(s.projector_lead_minutes)}" min="0" max="${db.MAX_PROJECTOR_MINUTES}" step="1" required>
      </label>
      <label>Switch off after playback ends (minutes)
        <input type="number" name="projector_idle_minutes" value="${esc(s.projector_idle_minutes)}" min="0" max="${db.MAX_PROJECTOR_MINUTES}" step="1" required>
      </label>
    </div>
    <p class="help small">For devices whose projector power mode is <code>auto</code> (Devices page): the player switches the projector on while a playlist is active or this many minutes before the next schedule rule starts, and off once nothing has played for the idle delay.</p>
    <div class="row">
      <button type="submit" class="primary">Save settings</button>
    </div>
  </form>
</div>

<div class="panel">
  <h2>Device enrollment</h2>
  <p class="muted small">The flasher fetches this key with an API token (below) and writes it to every card; a Pi presents it on first boot and receives its own device token. Rotate it if a card is lost: cards flashed with the old key that have not booted yet stop working.</p>
  <div class="enrollment-key">
    <label for="enrollment-key" class="small">Enrollment key</label>
    <input type="password" id="enrollment-key" value="${esc(s.enrollment_key)}" readonly spellcheck="false" autocomplete="off">
    <button type="button" class="small" data-reveal="enrollment-key">Show</button>
  </div>
  <form method="post" action="/settings/enrollment/rotate" class="inline" data-confirm="Make a new enrollment key? Cards flashed with the old key that have not booted yet will fail to enroll.">
    ${csrfInput(ctx)}
    <button type="submit" class="danger">New key</button>
  </form>
</div>

${await wyzePanel(ctx, s)}

${await alertsPanel(ctx, s)}

${await tunnelPanel(ctx, s)}

${await tokensPanel(ctx, me, newToken, s.timezone)}`;
  return layout(ctx, { title: "Settings", content });
}

async function settingsSave(ctx) {
  auth.requireRole(ctx, "admin");
  const form = await ctx.form();
  const timezone = str(form, "timezone").trim();
  if (!isValidTimeZone(timezone)) fail(400, "Pick a timezone from the list, for example America/New_York (short names like EST are not accepted)");
  // Every message names the field by its on-page label: the owner reads it on the error page.
  const interval = intField(str(form, "screenshot_interval"), "Screenshot interval");
  if (interval === null || interval < MIN_SCREENSHOT_INTERVAL) fail(400, `Screenshot interval must be a whole number of at least ${MIN_SCREENSHOT_INTERVAL} seconds`);
  const camera = intField(str(form, "camera_interval"), "Camera snapshot interval");
  if (camera === null || camera < MIN_CAMERA_INTERVAL) fail(400, `Camera snapshot interval must be a whole number of at least ${MIN_CAMERA_INTERVAL} seconds`);
  const durationMsg = "Default image duration must be between 0.5 and 86400 seconds";
  const duration = floatField(str(form, "default_image_duration"), "Default image duration", durationMsg);
  if (duration === null || duration < 0.5 || duration > 86400) fail(400, durationMsg);
  const enrollGroup = intField(str(form, "enroll_group_id"), "New devices join group");
  if (enrollGroup !== null && !(await db.first(ctx.env, "SELECT id FROM device_groups WHERE id = ?", enrollGroup))) fail(400, "Pick a group from the list");
  const enrollPlaylist = intField(str(form, "enroll_playlist_id"), "New devices get playlist");
  if (enrollPlaylist !== null && !(await db.first(ctx.env, "SELECT id FROM playlists WHERE id = ?", enrollPlaylist))) fail(400, "Pick a playlist from the list");
  // Update policy: an omitted (empty) field keeps its current value, so older callers that
  // only post the four site fields never lose it.
  const current = await ctx.settings();
  const release = str(form, "player_release").trim() || current.player_release;
  if (!db.isGitRef(release)) fail(400, "Player software version may only contain letters, digits, dots, slashes, hyphens and underscores (at most 100)");
  const autoUpdate = str(form, "auto_update").trim() || current.auto_update;
  if (!db.AUTO_UPDATE_MODES.includes(autoUpdate)) fail(400, `Auto-update must be ${db.AUTO_UPDATE_MODES.join(" or ")}`);
  const window = str(form, "auto_update_window").trim() || current.auto_update_window;
  if (!db.UPDATE_WINDOW_RE.test(window)) fail(400, "Auto-update window must be HH:MM-HH:MM");
  const values = { timezone, screenshot_interval: interval, camera_interval: camera, default_image_duration: duration,
    enroll_group_id: enrollGroup, enroll_playlist_id: enrollPlaylist,
    player_release: release, auto_update: autoUpdate, auto_update_window: window };
  // Projector lead / idle minutes: stored (and audited) only when the form posts them.
  for (const [key, label] of [["projector_lead_minutes", "Switch on before a schedule starts"], ["projector_idle_minutes", "Switch off after playback ends"]]) {
    if (!str(form, key).trim()) continue;
    const v = intField(str(form, key), label);
    if (!db.isProjectorMinutes(v)) fail(400, `${label} must be a whole number of minutes, 0-${db.MAX_PROJECTOR_MINUTES}`);
    values[key] = v;
  }
  // null (none) deletes the row so the settings table only holds what is set
  await db.batch(ctx.env, Object.entries(values).map(([k, v]) => (v === null
    ? ["DELETE FROM settings WHERE key = ?", k]
    : ["INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, String(v)])));
  await audit.log(ctx, "settings_update", "settings", null, values);
  return auth.flashRedirect(ctx, "/settings", "Settings saved.");
}

// Filled fields replace, empty keep; the audit row says which changed, never a value.
async function wyzeSave(ctx) {
  auth.requireRole(ctx, "admin");
  const form = await ctx.form();
  const current = await ctx.settings();
  const pattern = str(form, "wyze_camera_pattern").trim() || current.wyze_camera_pattern;
  if (!db.isCameraPattern(pattern)) fail(400, "Camera name pattern must be 1-100 printable characters");
  const changed = {};
  for (const [name, label] of WYZE_FIELDS) {
    const v = str(form, name);
    if (!v) continue;
    if (v.length > 500 || /[\x00-\x1f\x7f]/.test(v)) fail(400, `${label} must be at most 500 printable characters`);
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
  return auth.flashRedirect(ctx, "/settings", "Settings saved.");
}

async function wyzeClear(ctx) {
  auth.requireRole(ctx, "admin");
  for (const name of secrets.WYZE_NAMES) await secrets.set(ctx.env, name, "");
  await db.bumpCameraConfigVersion(ctx.env);
  await audit.log(ctx, "wyze_settings_cleared", "settings", "wyze");
  return auth.flashRedirect(ctx, "/settings", "Settings saved.");
}

// Thresholds, addresses and webhook go to `settings` (an empty address / URL turns that
// channel off); filled Twilio fields replace the secret, empty keep it. The audit row never
// carries a credential.
async function alertsSave(ctx) {
  auth.requireRole(ctx, "admin");
  const before = (await ctx.settings()).alert_email;
  const form = await ctx.form();
  const offline = intField(str(form, "alert_offline_minutes"), "Offline after");
  if (!db.isAlertOfflineMinutes(offline)) fail(400, "Offline after must be a whole number of minutes, 1-1440");
  const repeat = intField(str(form, "alert_repeat_minutes"), "Repeat while open");
  if (!db.isAlertRepeatMinutes(repeat)) fail(400, "Repeat while open must be a whole number of minutes, 0-10080");
  const email = str(form, "alert_email").trim();
  if (email && !db.parseEmails(email)) fail(400, "Enter one or more email addresses, separated by commas");
  const webhook = str(form, "alert_webhook_url").trim();
  if (webhook && !db.isWebhookUrl(webhook)) fail(400, "The webhook must be an https:// address");
  const twilio = {};
  for (const [name, label] of TWILIO_FIELDS) {
    const v = str(form, name).trim();
    if (!v) continue;
    if (v.length > 200 || /[\x00-\x1f\x7f]/.test(v)) fail(400, `${label.split(" (")[0]} must be at most 200 printable characters`);
    twilio[name] = v;
  }
  const values = { alert_offline_minutes: offline, alert_repeat_minutes: repeat, alert_email: email, alert_webhook_url: webhook };
  await db.batch(ctx.env, Object.entries(values).map(([k, v]) => (v === ""
    ? ["DELETE FROM settings WHERE key = ?", k]
    : ["INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, String(v)])));
  // Audit rows are readable by every role; a webhook URL is a write credential for its channel.
  const details = { ...values, alert_webhook_url: webhook ? "set" : "" };
  for (const [name, v] of Object.entries(twilio)) {
    await secrets.set(ctx.env, name, v);
    details[name] = "set";
  }
  await audit.log(ctx, "alert_settings_update", "settings", "alerts", details);
  // The addresses double as the camera Access policy: push a changed list to every tunnel now,
  // so a removed operator does not keep the live camera pages until each tunnel is recreated.
  const accessError = email !== before ? await cloudflare.syncAccess(ctx) : null;
  if (accessError) return auth.flashRedirect(ctx, "/settings", `Saved, but the camera access list could not be updated on every device: ${accessError}. Click Recreate tunnel on each device on the Devices page.`, "error");
  return auth.flashRedirect(ctx, "/settings", "Settings saved.");
}

async function twilioClear(ctx) {
  auth.requireRole(ctx, "admin");
  for (const name of alerts.TWILIO_NAMES) await secrets.set(ctx.env, name, "");
  await audit.log(ctx, "alert_settings_update", "settings", "alerts", { twilio: "cleared" });
  return auth.flashRedirect(ctx, "/settings", "Settings saved.");
}

// One test message through one channel; the outcome comes back as a banner (never a 500).
async function alertsTest(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const channel = str(await ctx.form(), "channel").trim();
  if (!alerts.CHANNELS.includes(channel)) fail(400, "Pick a channel to test");
  const error = await alerts.sendTest(ctx.env, await ctx.settings(), channel, me.username);
  await audit.log(ctx, "alert_test_sent", "settings", channel, error ? { error: error.slice(0, 200) } : null);
  if (error) return auth.flashRedirect(ctx, "/settings", `Test alert failed: ${channel}: ${error.slice(0, 200)}`, "error");
  return auth.flashRedirect(ctx, "/settings", `Test ${channel} alert sent.`);
}

async function enrollmentRotate(ctx) {
  auth.requireRole(ctx, "admin");
  await db.generateEnrollmentKey(ctx.env);
  await audit.log(ctx, "enrollment_key_rotated", "settings", "enrollment_key");
  return auth.flashRedirect(ctx, "/settings", "Enrollment key rotated. Cards flashed with the old key must be re-flashed.");
}

// Create a token and render the page with the plaintext once (no redirect: the secret must
// not travel in a URL). Only the hash is stored; the audit row carries the name, never the token.
async function tokenCreate(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const name = tokenName(await ctx.form());
  const { token } = await auth.issueApiToken(ctx, me.id, name);
  return settingsPage(ctx, token);
}

async function tokenRevoke(ctx) {
  const me = auth.requireRole(ctx, "admin");
  const tokenId = idParam(ctx.params.token_id, "token_id");
  const row = await db.first(ctx.env, "SELECT id, name FROM api_tokens WHERE id = ? AND user_id = ?", tokenId, me.id);
  if (!row) fail(404, "token not found");
  await db.run(ctx.env, "DELETE FROM api_tokens WHERE id = ?", tokenId);
  await audit.log(ctx, "api_token_revoked", "api_token", tokenId, { name: row.name });
  return auth.flashRedirect(ctx, "/settings", "API token revoked.");
}

export function register(router) {
  router.post("/settings/tokens", tokenCreate);
  router.post("/settings/tokens/:token_id/revoke", tokenRevoke);
  router.get("/settings", settingsPage);
  router.post("/settings", settingsSave);
  router.post("/settings/enrollment/rotate", enrollmentRotate);
  router.post("/settings/wyze", wyzeSave);
  router.post("/settings/wyze/clear", wyzeClear);
  router.post("/settings/alerts", alertsSave);
  router.post("/settings/alerts/twilio/clear", twilioClear);
  router.post("/settings/alerts/test", alertsTest);
}
