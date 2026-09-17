// Cloudflare API client for the automatic camera tunnel (feature G, cloud only). Per device:
// a remotely-managed tunnel named p5k-<device_id>, a proxied CNAME <device_id>-cam.<zone> ->
// <tunnel_id>.cfargotunnel.com, the tunnel's ingress (that hostname -> http://127.0.0.1:5000,
// the Wyze bridge on the Pi; catch-all 404) and an Access self-hosted application on the
// hostname with one allow policy for the operator emails. Every step looks before it creates,
// so provision() is safe to run again after a partial failure or from the "Create tunnel"
// button. The tunnel token is fetched on every sync (api.js tunnelBlock) and never stored.
// Needs the worker secrets CF_API_TOKEN (permissions: Account > Cloudflare Tunnel: Edit,
// Zone > DNS: Edit, Account > Access: Apps and Policies: Edit), CF_ACCOUNT_ID and CF_ZONE_ID;
// without all three configured() is false, nothing here is called, the Settings panel says
// "not configured" and the manual live URL field keeps working.
import * as audit from "./audit.js";
import * as db from "./db.js";

export const API = "https://api.cloudflare.com/client/v4";
export const ZONE_NAME = "photogen5000.com"; // CF_ZONE_NAME var overrides (must match CF_ZONE_ID)
export const INGRESS_SERVICE = "http://127.0.0.1:5000";
export const POLICY_NAME = "p5k operators";
export const SECRET_NAMES = ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_ZONE_ID"];
const FETCH_TIMEOUT_MS = 15000;

export const configured = (env) => SECRET_NAMES.every((n) => Boolean(env[n]));
export const missing = (env) => SECRET_NAMES.filter((n) => !env[n]);
export const tunnelName = (deviceId) => `p5k-${deviceId}`;
export const zoneName = (env) => env.CF_ZONE_NAME || ZONE_NAME;
export const hostnameFor = (env, deviceId) => `${deviceId}-cam.${zoneName(env)}`;

// One API call; the `result` on success, else an Error carrying Cloudflare's messages (or the
// HTTP status) so the Devices page banner / audit row can say why.
async function call(env, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.success === false) {
    const errors = data && Array.isArray(data.errors) ? data.errors.map((e) => e.message || e.code).filter(Boolean) : [];
    throw new Error(`Cloudflare API ${method} ${path.split("?")[0]}: ${errors.length ? errors.join("; ") : `HTTP ${res.status}`}`);
  }
  return data.result;
}

const acct = (env) => `/accounts/${env.CF_ACCOUNT_ID}`;
const zone = (env) => `/zones/${env.CF_ZONE_ID}`;

// The tunnel id for the device: an existing p5k-<device_id> (not deleted), else a new
// remotely-managed one (config_src cloudflare: the ingress lives in the API, not on the Pi).
async function ensureTunnel(env, deviceId) {
  const name = tunnelName(deviceId);
  const found = await call(env, "GET", `${acct(env)}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`);
  const hit = (found || []).find((t) => t.name === name);
  if (hit) return hit.id;
  return (await call(env, "POST", `${acct(env)}/cfd_tunnel`, { name, config_src: "cloudflare" })).id;
}

// PUT replaces the whole configuration, so it is idempotent by itself.
function putIngress(env, tunnelId, hostname) {
  return call(env, "PUT", `${acct(env)}/cfd_tunnel/${tunnelId}/configurations`, {
    config: { ingress: [{ hostname, service: INGRESS_SERVICE }, { service: "http_status:404" }] },
  });
}

// The proxied CNAME; an existing record pointing elsewhere (a recreated tunnel) is updated.
async function ensureDns(env, hostname, tunnelId) {
  const content = `${tunnelId}.cfargotunnel.com`;
  const record = { type: "CNAME", name: hostname, content, proxied: true, ttl: 1 };
  const rows = await call(env, "GET", `${zone(env)}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`);
  const hit = (rows || []).find((r) => r.name === hostname);
  if (!hit) await call(env, "POST", `${zone(env)}/dns_records`, record);
  else if (hit.content !== content || !hit.proxied) await call(env, "PUT", `${zone(env)}/dns_records/${hit.id}`, record);
}

// The Access app on the hostname and its single policy; the policy is rewritten every time so
// a changed operator list reaches every device on its next provision.
async function ensureAccess(env, deviceId, hostname, emails) {
  const apps = await call(env, "GET", `${acct(env)}/access/apps?domain=${encodeURIComponent(hostname)}`);
  let app = (apps || []).find((a) => a.domain === hostname);
  if (!app) {
    app = await call(env, "POST", `${acct(env)}/access/apps`,
      { name: `${tunnelName(deviceId)} camera`, domain: hostname, type: "self_hosted", session_duration: "24h" });
  }
  const body = { name: POLICY_NAME, decision: "allow", include: emails.map((email) => ({ email: { email } })) };
  const policies = await call(env, "GET", `${acct(env)}/access/apps/${app.id}/policies`);
  const policy = (policies || []).find((p) => p.name === POLICY_NAME);
  if (!policy) await call(env, "POST", `${acct(env)}/access/apps/${app.id}/policies`, body);
  else await call(env, "PUT", `${acct(env)}/access/apps/${app.id}/policies/${policy.id}`, body);
  return app.id;
}

// Tunnel + ingress + DNS + Access for one device_id; {tunnel_id, hostname}. Throws on the
// first API refusal (the steps already done stay, the next run finds them).
export async function provision(env, deviceId, emails) {
  const hostname = hostnameFor(env, deviceId);
  const tunnelId = await ensureTunnel(env, deviceId);
  await putIngress(env, tunnelId, hostname);
  await ensureDns(env, hostname, tunnelId);
  await ensureAccess(env, deviceId, hostname, emails);
  return { tunnel_id: tunnelId, hostname };
}

// The connector token `cloudflared tunnel run --token` takes (a string).
export const tunnelToken = (env, tunnelId) => call(env, "GET", `${acct(env)}/cfd_tunnel/${tunnelId}/token`);

// Who may open the camera pages: the Settings alert email addresses, else the admin usernames
// that are email addresses; null when neither yields one (provisionDevice refuses: an Access
// app with no allowed email would lock everyone out).
export async function operatorEmails(env, settings) {
  const fromSettings = db.parseEmails(settings.alert_email);
  if (fromSettings) return fromSettings;
  const admins = await db.all(env, "SELECT username FROM users WHERE role = 'admin' ORDER BY id");
  const list = admins.map((u) => u.username).filter((u) => db.parseEmails(u));
  return list.length ? list : null;
}

// Provision for one devices row ({id, device_id}), store tunnel_id / tunnel_hostname, point
// camera_live_url at the hostname (the Live embed works once the operator is logged in to
// Access) and audit device_tunnel_created. Throws with the reason when not configured, when no
// operator email is known or when the API refuses; the callers decide whether that is fatal
// (never for an enrollment, a banner for the button).
export async function provisionDevice(ctx, device) {
  if (!configured(ctx.env)) throw new Error(`${missing(ctx.env).join(", ")} not set`);
  const emails = await operatorEmails(ctx.env, await ctx.settings());
  if (!emails) throw new Error("no operator email known: set the alert email addresses in Settings (or make an admin username an email address)");
  const { tunnel_id, hostname } = await provision(ctx.env, device.device_id, emails);
  await db.run(ctx.env, "UPDATE devices SET tunnel_id = ?, tunnel_hostname = ?, camera_live_url = ? WHERE id = ?",
    tunnel_id, hostname, `https://${hostname}/`, device.id);
  await audit.log(ctx, "device_tunnel_created", "device", device.id, { device_id: device.device_id, tunnel_id, hostname, emails: emails.length });
  return { tunnel_id, hostname };
}

// provisionDevice that never throws: {tunnel_id, hostname, error: null}, or {error} with the
// failure logged and audited as device_tunnel_failed (enrollment must succeed without a
// tunnel; the Devices page shows the error as a banner and the operator retries).
export async function tryProvisionDevice(ctx, device) {
  try {
    return { ...await provisionDevice(ctx, device), error: null };
  } catch (e) {
    const error = String(e && e.message || e).slice(0, 200);
    console.error(`tunnel for ${device.device_id} failed: ${error}`);
    await audit.log(ctx, "device_tunnel_failed", "device", device.id, { device_id: device.device_id, error });
    return { error };
  }
}

export function register() {}
