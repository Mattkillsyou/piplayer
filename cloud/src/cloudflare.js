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
// "not configured" and the manual live URL field keeps working. The tunnels stay per device; who
// may open one is the projector's own account's business (operatorEmails of its content account:
// the owner, or the site admin for an ownerless projector).
import * as accounts from "./accounts.js";
import * as audit from "./audit.js";
import * as db from "./db.js";

export const API = "https://api.cloudflare.com/client/v4"; // CF_API_BASE var overrides (local e2e fake only)
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
  const res = await fetch((env.CF_API_BASE || API) + path, {
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
    // Label the call without the account / zone ids: the message lands in the audit log, the
    // Devices banner URL and the worker log, none of which should carry secrets.
    const where = path.split("?")[0].replace(acct(env), "/accounts/...").replace(zone(env), "/zones/...");
    const err = new Error(`Cloudflare API ${method} ${where}: ${errors.length ? errors.join("; ") : `HTTP ${res.status}`}`);
    err.status = res.status;
    throw err;
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

// Who may open the camera pages of an account's projectors: its Settings alert email addresses,
// else its own email address (users.email), else its username when that is an address; null
// when none yields one (provisionDevice refuses: an Access app with no allowed email would lock
// everyone out). `settings` are that account's.
export async function operatorEmails(env, settings, ownerId) {
  const fromSettings = db.parseEmails(settings.alert_email);
  if (fromSettings) return fromSettings;
  const user = ownerId === null || ownerId === undefined ? null : await db.first(env, "SELECT username, email FROM users WHERE id = ?", ownerId);
  const list = user ? [user.email, user.username].filter((v) => v && db.parseEmails(v)).slice(0, 1) : [];
  return list.length ? list : null;
}

// Provision for one devices row ({id, device_id, owner_id or content_owner}), store tunnel_id /
// tunnel_hostname, point camera_live_url at the hostname (the Live embed works once the operator
// is logged in to Access) and audit device_tunnel_created. Throws with the reason when not
// configured, when no operator email is known or when the API refuses; the callers decide whether
// that is fatal (never for an enrollment, a banner for the button).
export async function provisionDevice(ctx, device) {
  if (!configured(ctx.env)) throw new Error(`${missing(ctx.env).join(", ")} not set`);
  const owner = await accounts.contentOwnerOf(ctx.env, device);
  const emails = await operatorEmails(ctx.env, await db.loadSettings(ctx.env, owner), owner);
  if (!emails) throw new Error("no operator email known: set the alert email addresses in Settings (or give the account an email address)");
  const { tunnel_id, hostname } = await provision(ctx.env, device.device_id, emails);
  await db.run(ctx.env, "UPDATE devices SET tunnel_id = ?, tunnel_hostname = ?, camera_live_url = ? WHERE id = ?",
    tunnel_id, hostname, `https://${hostname}/`, device.id);
  await audit.log(ctx, "device_tunnel_created", "device", device.id, { device_id: device.device_id, tunnel_id, hostname, emails: emails.length }, undefined, device.owner_id ?? null);
  return { tunnel_id, hostname };
}

// The operator list changed (an account's alert email addresses, a user added, removed or
// re-roled, a projector handed to another account): rewrite the Access policy of every tunnelled
// projector concerned so the change reaches them now, not on their next provision. `ownerId`
// limits it to the projectors of that content account; omitted, every tunnelled projector gets its
// own account's list (a user change can move who the site admin is). `deviceId` limits it to one
// projector. null on success or when there is nothing to do (not configured, no email known, no
// tunnels), else the reason for the caller's banner; audits camera_access_updated per account.
// Settings are re-read: the caller has just saved them and ctx.settings() is memoised.
export async function syncAccess(ctx, ownerId = undefined, deviceId = undefined) {
  if (!configured(ctx.env)) return null;
  const where = ["d.tunnel_id IS NOT NULL"];
  const params = [];
  if (ownerId !== undefined) { where.push(`${accounts.contentOwnerSql("d")} = ?`); params.push(ownerId); }
  if (deviceId !== undefined) { where.push("d.id = ?"); params.push(deviceId); }
  const devices = await db.all(ctx.env,
    `SELECT d.id, d.device_id, ${accounts.contentOwnerSql("d")} AS content_owner FROM devices d WHERE ${where.join(" AND ")}`, ...params);
  const byOwner = new Map();
  for (const d of devices) {
    if (!byOwner.has(d.content_owner)) byOwner.set(d.content_owner, []);
    byOwner.get(d.content_owner).push(d);
  }
  const settings = await db.loadSettingsFor(ctx.env, [...byOwner.keys()]);
  for (const [owner, list] of byOwner) {
    if (owner === null) continue;
    const emails = await operatorEmails(ctx.env, settings.get(owner), owner);
    if (!emails) continue;
    try {
      for (const d of list) await ensureAccess(ctx.env, d.device_id, hostnameFor(ctx.env, d.device_id), emails);
    } catch (e) {
      return String(e && e.message || e).slice(0, 200);
    }
    await audit.log(ctx, "camera_access_updated", "settings", "operators", { devices: list.length, emails: emails.length }, undefined, owner);
  }
  return null;
}

// A new tunnel for a device whose connector token may have leaked: delete the old tunnel (its
// connections first, Cloudflare refuses to delete a tunnel that still has any) and provision
// again, so the Pi gets a fresh token on its next sync and the old one stops working. A tunnel
// already gone (404) is fine. Returns what provisionDevice returns and throws like it does.
export async function rotateTunnel(ctx, device) {
  if (!configured(ctx.env)) throw new Error(`${missing(ctx.env).join(", ")} not set`);
  if (device.tunnel_id) {
    const base = `${acct(ctx.env)}/cfd_tunnel/${device.tunnel_id}`;
    for (const path of [`${base}/connections`, base]) {
      await call(ctx.env, "DELETE", path).catch((e) => { if (e.status !== 404) throw e; });
    }
  }
  return provisionDevice(ctx, device);
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
    await audit.log(ctx, "device_tunnel_failed", "device", device.id, { device_id: device.device_id, error }, undefined, device.owner_id ?? null);
    return { error };
  }
}

export function register() {}
