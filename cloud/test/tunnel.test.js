// Auto tunnel (G): the Cloudflare API client against a fake fetch (request shapes, idempotency
// when the tunnel / DNS / Access app already exist, error surfacing), the operator email
// fallback, provisioning at enrollment and from the Devices page button, the manifest `tunnel`
// block gated by the device bearer (never on a page), graceful degradation without the secrets
// and the Settings status panel.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as cloudflare from "../src/cloudflare.js";
import * as db from "../src/db.js";
import { BASE, query } from "./helpers.js";
import { audits, detail, device, one, post, roleMatrix, roles } from "./pages_common.js";

const CF = { CF_API_TOKEN: "cf-test-token", CF_ACCOUNT_ID: "acct1", CF_ZONE_ID: "zone1" };
const API = cloudflare.API;
const ACCT = `${API}/accounts/acct1`;
const ZONE = `${API}/zones/zone1`;

// The three secrets are absent in vitest.config.js; the worker reads the same env object the
// tests import, so setting them here turns the feature on for SELF requests too.
function configure(on = true) {
  for (const k of Object.keys(CF)) {
    if (on) env[k] = CF[k];
    else delete env[k];
  }
}

// In-memory Cloudflare: tunnels, DNS records, Access apps and their policies, answering the
// routes cloudflare.js uses with the v4 envelope. `calls` records every request; `refuse`
// makes one "METHOD path" answer success:false with `message`.
function fakeCloudflare() {
  const state = { tunnels: [], dns: [], apps: [], policies: {}, ingress: {}, seq: 0 };
  const calls = [];
  const fake = { state, calls, refuse: null, status: null };
  const id = (p) => `${p}-${++state.seq}`;
  vi.stubGlobal("fetch", async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const path = u.pathname.replace("/client/v4", "");
    calls.push({ method, path, query: Object.fromEntries(u.searchParams), body, auth: new Headers(init.headers).get("authorization") });
    if (fake.status) return new Response("<html>gateway</html>", { status: fake.status });
    if (fake.refuse && fake.refuse.key === `${method} ${path}`) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: fake.refuse.message }], result: null }), { status: 400 });
    }
    let result;
    let m;
    if (method === "GET" && path === "/accounts/acct1/cfd_tunnel") result = state.tunnels.filter((t) => t.name === u.searchParams.get("name"));
    else if (method === "POST" && path === "/accounts/acct1/cfd_tunnel") state.tunnels.push(result = { id: id("tun"), ...body });
    else if ((m = /^\/accounts\/acct1\/cfd_tunnel\/([^/]+)\/configurations$/.exec(path)) && method === "PUT") result = state.ingress[m[1]] = body.config;
    else if ((m = /^\/accounts\/acct1\/cfd_tunnel\/([^/]+)\/token$/.exec(path)) && method === "GET") result = `eyJ-token-for-${m[1]}`;
    else if ((m = /^\/accounts\/acct1\/cfd_tunnel\/([^/]+)\/connections$/.exec(path)) && method === "DELETE") result = [];
    else if ((m = /^\/accounts\/acct1\/cfd_tunnel\/([^/]+)$/.exec(path)) && method === "DELETE") {
      const i = state.tunnels.findIndex((t) => t.id === m[1]);
      if (i < 0) return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "tunnel not found" }] }), { status: 404 });
      [result] = state.tunnels.splice(i, 1);
    }
    else if (method === "GET" && path === "/zones/zone1/dns_records") result = state.dns.filter((r) => r.name === u.searchParams.get("name"));
    else if (method === "POST" && path === "/zones/zone1/dns_records") state.dns.push(result = { id: id("dns"), ...body });
    else if ((m = /^\/zones\/zone1\/dns_records\/([^/]+)$/.exec(path)) && method === "PUT") Object.assign(result = state.dns.find((r) => r.id === m[1]), body);
    else if (method === "GET" && path === "/accounts/acct1/access/apps") result = state.apps.filter((a) => a.domain === u.searchParams.get("domain"));
    else if (method === "POST" && path === "/accounts/acct1/access/apps") state.apps.push(result = { id: id("app"), ...body });
    else if ((m = /^\/accounts\/acct1\/access\/apps\/([^/]+)\/policies$/.exec(path)) && method === "GET") result = state.policies[m[1]] || [];
    else if ((m = /^\/accounts\/acct1\/access\/apps\/([^/]+)\/policies$/.exec(path)) && method === "POST") (state.policies[m[1]] ||= []).push(result = { id: id("pol"), ...body });
    else if ((m = /^\/accounts\/acct1\/access\/apps\/([^/]+)\/policies\/([^/]+)$/.exec(path)) && method === "PUT") Object.assign(result = state.policies[m[1]].find((p) => p.id === m[2]), body);
    else return new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: `no route ${method} ${path}` }] }), { status: 404 });
    return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return fake;
}

const EMAILS = ["ops@example.net", "matt@example.net"];
const INGRESS = { ingress: [{ hostname: "lobby-cam.photogen5000.com", service: "http://127.0.0.1:5000" }, { service: "http_status:404" }] };
const POLICY = { name: "p5k operators", decision: "allow", include: [{ email: { email: "ops@example.net" } }, { email: { email: "matt@example.net" } }] };
const shapes = (calls) => calls.map((c) => `${c.method} ${c.path}`);
const devRow = (id) => one("SELECT tunnel_id, tunnel_hostname, camera_live_url FROM devices WHERE id = ?", id);
const sync = (d) => SELF.fetch(`${BASE}/api/sync/${d.device_id}`, { headers: { authorization: `Bearer ${d.token}` } });
const enroll = (body) => SELF.fetch(`${BASE}/api/enroll`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

let r;
let lobby;
let key;

beforeAll(async () => {
  r = await roles();
  lobby = await device("lobby", "Lobby");
  key = (await db.loadSettings(env)).enrollment_key;
});

afterEach(() => {
  vi.unstubAllGlobals();
  configure(false);
});

describe("cloudflare client", () => {
  it("configured needs all three secrets; hostnames and tunnel names derive from the device_id", () => {
    expect(cloudflare.configured({})).toBe(false);
    expect(cloudflare.configured({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" })).toBe(false);
    expect(cloudflare.missing({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" })).toEqual(["CF_ZONE_ID"]);
    expect(cloudflare.configured(CF)).toBe(true);
    expect(cloudflare.missing(CF)).toEqual([]);
    expect(cloudflare.tunnelName("lobby")).toBe("p5k-lobby");
    expect(cloudflare.hostnameFor(CF, "lobby")).toBe("lobby-cam.photogen5000.com");
    expect(cloudflare.hostnameFor({ ...CF, CF_ZONE_NAME: "example.org" }, "lobby")).toBe("lobby-cam.example.org");
  });

  it("CF_API_BASE points the client at a local fake (e2e); production uses api.cloudflare.com", async () => {
    const fake = fakeCloudflare();
    const seen = [];
    const orig = globalThis.fetch;
    vi.stubGlobal("fetch", (url, init) => { seen.push(String(url)); return orig(url, init); });
    await cloudflare.tunnelToken(CF, "tun-x");
    await cloudflare.tunnelToken({ ...CF, CF_API_BASE: "http://127.0.0.1:9121/client/v4" }, "tun-x");
    expect(seen).toEqual([`${API}/accounts/acct1/cfd_tunnel/tun-x/token`, "http://127.0.0.1:9121/client/v4/accounts/acct1/cfd_tunnel/tun-x/token"]);
    expect(fake.calls.length).toBe(2);
  });

  it("provision from scratch: tunnel, ingress, proxied CNAME, Access app + policy, each with the bearer", async () => {
    const fake = fakeCloudflare();
    expect(await cloudflare.provision(CF, "lobby", EMAILS)).toEqual({ tunnel_id: "tun-1", hostname: "lobby-cam.photogen5000.com" });
    expect(shapes(fake.calls)).toEqual([
      "GET /accounts/acct1/cfd_tunnel",
      "POST /accounts/acct1/cfd_tunnel",
      "PUT /accounts/acct1/cfd_tunnel/tun-1/configurations",
      "GET /zones/zone1/dns_records",
      "POST /zones/zone1/dns_records",
      "GET /accounts/acct1/access/apps",
      "POST /accounts/acct1/access/apps",
      "GET /accounts/acct1/access/apps/app-3/policies",
      "POST /accounts/acct1/access/apps/app-3/policies",
    ]);
    expect(fake.calls.every((c) => c.auth === "Bearer cf-test-token")).toBe(true);
    expect(fake.calls[0].query).toEqual({ name: "p5k-lobby", is_deleted: "false" });
    expect(fake.calls[1].body).toEqual({ name: "p5k-lobby", config_src: "cloudflare" });
    expect(fake.calls[2].body).toEqual({ config: INGRESS });
    expect(fake.calls[3].query).toEqual({ type: "CNAME", name: "lobby-cam.photogen5000.com" });
    expect(fake.calls[4].body).toEqual({ type: "CNAME", name: "lobby-cam.photogen5000.com", content: "tun-1.cfargotunnel.com", proxied: true, ttl: 1 });
    expect(fake.calls[5].query).toEqual({ domain: "lobby-cam.photogen5000.com" });
    expect(fake.calls[6].body).toEqual({ name: "p5k-lobby camera", domain: "lobby-cam.photogen5000.com", type: "self_hosted", session_duration: "24h" });
    expect(fake.calls[8].body).toEqual(POLICY);
    expect(fake.calls.filter((c) => c.method === "GET").every((c) => c.body === undefined)).toBe(true);
    expect(fake.state.ingress["tun-1"]).toEqual(INGRESS);
  });

  it("is idempotent: a second run creates nothing, rewrites the ingress and policy, repoints a stale CNAME", async () => {
    const fake = fakeCloudflare();
    await cloudflare.provision(CF, "lobby", EMAILS);
    fake.calls.length = 0;
    expect(await cloudflare.provision(CF, "lobby", ["new@example.net"])).toEqual({ tunnel_id: "tun-1", hostname: "lobby-cam.photogen5000.com" });
    expect(shapes(fake.calls)).toEqual([
      "GET /accounts/acct1/cfd_tunnel",
      "PUT /accounts/acct1/cfd_tunnel/tun-1/configurations",
      "GET /zones/zone1/dns_records",
      "GET /accounts/acct1/access/apps",
      "GET /accounts/acct1/access/apps/app-3/policies",
      "PUT /accounts/acct1/access/apps/app-3/policies/pol-4",
    ]);
    expect(fake.calls[5].body).toEqual({ name: "p5k operators", decision: "allow", include: [{ email: { email: "new@example.net" } }] });
    expect(fake.state.tunnels.length).toBe(1);
    expect(fake.state.dns.length).toBe(1);
    expect(fake.state.apps.length).toBe(1);
    expect(fake.state.policies["app-3"].length).toBe(1);
    // the CNAME points at an older tunnel (or is not proxied): updated in place, not duplicated
    fake.state.dns[0].content = "old.cfargotunnel.com";
    fake.calls.length = 0;
    await cloudflare.provision(CF, "lobby", EMAILS);
    expect(shapes(fake.calls)).toContain("PUT /zones/zone1/dns_records/dns-2");
    expect(shapes(fake.calls)).not.toContain("POST /zones/zone1/dns_records");
    expect(fake.state.dns).toEqual([{ id: "dns-2", type: "CNAME", name: "lobby-cam.photogen5000.com", content: "tun-1.cfargotunnel.com", proxied: true, ttl: 1 }]);
    // a second device shares nothing
    await cloudflare.provision(CF, "hall", EMAILS);
    expect(fake.state.tunnels.map((t) => t.name)).toEqual(["p5k-lobby", "p5k-hall"]);
    expect(fake.state.apps.map((a) => a.domain)).toEqual(["lobby-cam.photogen5000.com", "hall-cam.photogen5000.com"]);
  });

  it("surfaces Cloudflare's error message (or the HTTP status) and stops at the failing step", async () => {
    const fake = fakeCloudflare();
    fake.refuse = { key: "POST /zones/zone1/dns_records", message: "DNS Validation Error: record already exists" };
    await expect(cloudflare.provision(CF, "lobby", EMAILS)).rejects.toThrow(
      "Cloudflare API POST /zones/.../dns_records: DNS Validation Error: record already exists");
    expect(fake.state.tunnels.length).toBe(1);
    expect(fake.state.apps.length).toBe(0);
    // the retry finds the tunnel and carries on
    fake.refuse = null;
    await cloudflare.provision(CF, "lobby", EMAILS);
    expect(fake.state.tunnels.length).toBe(1);
    expect(fake.state.apps.length).toBe(1);
    fake.status = 502;
    // the account / zone ids never appear in the error: it lands in the audit log and the Devices banner URL
    const err = await cloudflare.tunnelToken(CF, "tun-1").catch((e) => e);
    expect(err.message).toBe("Cloudflare API GET /accounts/.../cfd_tunnel/tun-1/token: HTTP 502");
    expect(err.message).not.toMatch(/acct1|zone1/);
    fake.status = null;
    expect(await cloudflare.tunnelToken(CF, "tun-1")).toBe("eyJ-token-for-tun-1");
    vi.stubGlobal("fetch", async () => { throw new TypeError("connect failed"); });
    await expect(cloudflare.provision(CF, "lobby", EMAILS)).rejects.toThrow("connect failed");
  });

  it("operator emails: the alert addresses, else admin usernames that are addresses, else null", async () => {
    expect(await cloudflare.operatorEmails(env, { alert_email: "a@x.org, b@y.org" })).toEqual(["a@x.org", "b@y.org"]);
    expect(await cloudflare.operatorEmails(env, { alert_email: "" })).toBeNull(); // admin is "admin", ed / vw are not admins
    const uid = (await query("INSERT INTO users (username, password_hash, role) VALUES ('root@example.net', 'x', 'admin') RETURNING id"))[0].id;
    await query("INSERT INTO users (username, password_hash, role) VALUES ('ed@example.net', 'x', 'editor')");
    try {
      expect(await cloudflare.operatorEmails(env, { alert_email: "" })).toEqual(["root@example.net"]);
      expect(await cloudflare.operatorEmails(env, { alert_email: "a@x.org" })).toEqual(["a@x.org"]);
    } finally {
      await query("DELETE FROM users WHERE id = ? OR username = 'ed@example.net'", uid);
    }
  });
});

describe("provisioning", () => {
  it("enrollment provisions when configured (columns, live URL, audit) and succeeds without a tunnel on failure or when not configured", async () => {
    await query("DELETE FROM audit_log WHERE action LIKE 'device_tunnel_%'");
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('alert_email', 'ops@example.net')");
    // not configured: no API call, no tunnel, enrollment fine
    const fake = fakeCloudflare();
    expect((await enroll({ key, device_id: "e-none", name: "x" })).status).toBe(200);
    expect(fake.calls.length).toBe(0);
    expect(await one("SELECT tunnel_id FROM devices WHERE device_id = 'e-none'")).toEqual({ tunnel_id: null });
    // configured: the whole chain runs and the row is filled in
    configure();
    const res = await enroll({ key, device_id: "e-one", name: "Enrolled" });
    expect(res.status).toBe(200);
    const row = await one("SELECT id, tunnel_id, tunnel_hostname, camera_live_url FROM devices WHERE device_id = 'e-one'");
    expect(row).toMatchObject({ tunnel_id: "tun-1", tunnel_hostname: "e-one-cam.photogen5000.com", camera_live_url: "https://e-one-cam.photogen5000.com/" });
    expect(fake.state.apps[0].domain).toBe("e-one-cam.photogen5000.com");
    const [a] = await audits("device_tunnel_created");
    expect(a).toMatchObject({ username: null, target_type: "device", target_id: String(row.id) });
    expect(JSON.parse(a.details)).toEqual({ device_id: "e-one", tunnel_id: "tun-1", hostname: "e-one-cam.photogen5000.com", emails: 1 });
    // re-enroll: nothing new (the device has its tunnel)
    fake.calls.length = 0;
    expect((await enroll({ key, device_id: "e-one", name: "Enrolled" })).status).toBe(200);
    expect(fake.calls.length).toBe(0);
    // a re-enroll of the device that enrolled before the secrets were set gets its tunnel now
    expect((await enroll({ key, device_id: "e-none", name: "x" })).status).toBe(200);
    expect(await one("SELECT tunnel_hostname FROM devices WHERE device_id = 'e-none'")).toEqual({ tunnel_hostname: "e-none-cam.photogen5000.com" });
    // the API refusing: enrollment still 200, audited device_tunnel_failed, row untouched
    fake.refuse = { key: "POST /accounts/acct1/cfd_tunnel", message: "Authentication error" };
    const bad = await enroll({ key, device_id: "e-fail", name: "x" });
    expect(bad.status).toBe(200);
    expect(typeof (await bad.json()).token).toBe("string");
    expect(await devRow((await one("SELECT id FROM devices WHERE device_id = 'e-fail'")).id)).toEqual({ tunnel_id: null, tunnel_hostname: null, camera_live_url: null });
    const [f] = await audits("device_tunnel_failed");
    expect(JSON.parse(f.details)).toEqual({ device_id: "e-fail", error: "Cloudflare API POST /accounts/.../cfd_tunnel: Authentication error" });
    // no operator email known: refused before any API call
    await query("DELETE FROM settings WHERE key = 'alert_email'");
    fake.refuse = null;
    fake.calls.length = 0;
    expect((await enroll({ key, device_id: "e-mail", name: "x" })).status).toBe(200);
    expect(fake.calls.length).toBe(0);
    expect(JSON.parse((await audits("device_tunnel_failed"))[0].details).error).toMatch(/^no operator email known/);
    await query("DELETE FROM devices WHERE device_id LIKE 'e-%'");
  });

  it("Create tunnel button (editor+): provisions, banners the hostname or the error, 400 when not configured", async () => {
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('alert_email', 'ops@example.net')");
    expect(await detail(await post(r.editor, `/devices/${lobby.id}/tunnel`), 400)).toBe("automatic tunnels are not configured (CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID not set)");
    configure();
    const fake = fakeCloudflare();
    await roleMatrix(r, "POST", `/devices/${lobby.id}/tunnel`);
    expect(await devRow(lobby.id)).toEqual({ tunnel_id: "tun-1", tunnel_hostname: "lobby-cam.photogen5000.com", camera_live_url: "https://lobby-cam.photogen5000.com/" });
    expect((await audits("device_tunnel_created"))[0]).toMatchObject({ username: "ed", target_id: String(lobby.id) });
    // the banner is a one-shot flash cookie the test client carries to the next page (audit L24)
    let page = await (await r.editor.get("/devices")).text();
    expect(page).toContain('<div class="alert ok" role="alert">Tunnel ready: https://lobby-cam.photogen5000.com/ (the Pi picks up the tunnel key on its next check-in; open the live view logged in to Cloudflare Access).</div>');
    expect(await (await r.editor.get("/devices")).text()).not.toContain("Tunnel ready");
    // Recreate tunnel on a device that has one rotates it (audit M8): the old tunnel is deleted,
    // a new one made under the same name and hostname, so the old connector token stops working
    fake.calls.length = 0;
    const ok = await post(r.editor, `/devices/${lobby.id}/tunnel`);
    expect([ok.status, ok.headers.get("location")]).toEqual([303, "/devices"]);
    expect(shapes(fake.calls).slice(0, 2)).toEqual(["DELETE /accounts/acct1/cfd_tunnel/tun-1/connections", "DELETE /accounts/acct1/cfd_tunnel/tun-1"]);
    expect(fake.state.tunnels.map((t) => t.id)).toEqual(["tun-5"]);
    expect(await devRow(lobby.id)).toEqual({ tunnel_id: "tun-5", tunnel_hostname: "lobby-cam.photogen5000.com", camera_live_url: "https://lobby-cam.photogen5000.com/" });
    expect((await (await sync(lobby)).json()).tunnel.token).toBe("eyJ-token-for-tun-5");
    expect((await audits("device_tunnel_rotated"))[0]).toMatchObject({ username: "ed", target_id: String(lobby.id) });
    expect(JSON.parse((await audits("device_tunnel_rotated"))[0].details)).toEqual({ device_id: "lobby", old_tunnel_id: "tun-1", tunnel_id: "tun-5", hostname: "lobby-cam.photogen5000.com" });
    page = await (await r.editor.get("/devices")).text();
    expect(page).toContain("Tunnel ready: https://lobby-cam.photogen5000.com/ (the Pi picks up the new tunnel key on its next check-in;");
    expect(page).toContain(`data-confirm="Recreate the camera tunnel for Lobby? The old tunnel key stops working, the Pi gets the new one on its next check-in, and the live URL is reset to the tunnel."`);
    // a manual live URL is replaced by the tunnel's on a recreate
    await query("UPDATE devices SET camera_live_url = 'https://manual.example/' WHERE id = ?", lobby.id);
    await post(r.editor, `/devices/${lobby.id}/tunnel`);
    expect((await devRow(lobby.id))).toEqual({ tunnel_id: "tun-6", tunnel_hostname: "lobby-cam.photogen5000.com", camera_live_url: "https://lobby-cam.photogen5000.com/" });
    // refusal -> banner with the reason, audited, row untouched (the next Recreate finds the half-made tunnel by name)
    fake.refuse = { key: "PUT /accounts/acct1/cfd_tunnel/tun-7/configurations", message: "tunnel is locked" };
    const bad = await post(r.editor, `/devices/${lobby.id}/tunnel`);
    expect([bad.status, bad.headers.get("location")]).toEqual([303, "/devices"]);
    page = await (await r.editor.get("/devices")).text();
    expect(page).toContain('<div class="alert error" role="alert">The camera tunnel could not be recreated: Cloudflare API PUT /accounts/.../cfd_tunnel/tun-7/configurations: tunnel is locked. Click Recreate tunnel on the Devices page to try again.</div>');
    expect((await audits("device_tunnel_failed"))[0]).toMatchObject({ username: "ed", target_id: String(lobby.id) });
    expect((await devRow(lobby.id)).tunnel_id).toBe("tun-6");
    fake.refuse = null;
    // a first-time failure reads as creation failed
    await query("UPDATE devices SET tunnel_id = NULL, tunnel_hostname = NULL WHERE id = ?", lobby.id);
    fake.refuse = { key: "PUT /accounts/acct1/cfd_tunnel/tun-7/configurations", message: "tunnel is locked" };
    expect((await post(r.editor, `/devices/${lobby.id}/tunnel`)).status).toBe(303);
    expect(await (await r.editor.get("/devices")).text()).toContain('<div class="alert error" role="alert">Tunnel creation failed: Cloudflare API PUT /accounts/.../cfd_tunnel/tun-7/configurations: tunnel is locked</div>');
    fake.refuse = null;
    expect((await post(r.editor, "/devices/999999/tunnel")).status).toBe(404);
    expect((await post(r.editor, "/devices/abc/tunnel")).status).toBe(400);
    await query("UPDATE devices SET tunnel_id = NULL, tunnel_hostname = NULL, camera_live_url = NULL WHERE id = ?", lobby.id);
    await query("DELETE FROM settings WHERE key = 'alert_email'");
  });

  it("New token on a device with a tunnel rotates the tunnel too; without one, or unconfigured, only the token changes (audit M8)", async () => {
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('alert_email', 'ops@example.net')");
    const hall = await device("hall-tok", "Hall <tok>");
    const token = () => one("SELECT token FROM devices WHERE id = ?", hall.id).then((x) => x.token);
    // not configured: the token changes, nothing is called, plain banner
    let res = await post(r.admin, `/devices/${hall.id}/regen-token`);
    expect([res.status, res.headers.get("location")]).toEqual([303, `/devices?open=${hall.id}`]);
    expect(await token()).not.toBe(hall.token);
    let page = await (await r.admin.get(`/devices?open=${hall.id}`)).text();
    expect(page).toContain('<div class="alert ok" role="alert">New token made for Hall &lt;tok&gt;: open Token / install and run the install command on the Pi again.</div>');
    expect(page).toContain(`data-confirm="Make a new token for Hall &lt;tok&gt;? The Pi stops syncing until you run the install command with the new token."`);
    configure();
    const fake = fakeCloudflare();
    await post(r.editor, `/devices/${hall.id}/tunnel`);
    expect((await devRow(hall.id)).tunnel_id).toBe("tun-1");
    expect((await (await sync({ ...hall, token: await token() })).json()).tunnel.token).toBe("eyJ-token-for-tun-1");
    page = await (await r.admin.get("/devices")).text();
    expect(page).toContain(`data-confirm="Make a new token for Hall &lt;tok&gt;? The Pi stops syncing until you run the install command with the new token; its camera tunnel is recreated too."`);
    fake.calls.length = 0;
    const before = await token();
    res = await post(r.admin, `/devices/${hall.id}/regen-token`);
    expect([res.status, res.headers.get("location")]).toEqual([303, `/devices?open=${hall.id}`]);
    expect(await token()).not.toBe(before);
    expect(shapes(fake.calls).slice(0, 2)).toEqual(["DELETE /accounts/acct1/cfd_tunnel/tun-1/connections", "DELETE /accounts/acct1/cfd_tunnel/tun-1"]);
    expect((await devRow(hall.id)).tunnel_id).toBe("tun-5");
    expect((await (await sync({ ...hall, token: await token() })).json()).tunnel.token).toBe("eyJ-token-for-tun-5");
    expect((await audits("device_tunnel_rotated"))[0]).toMatchObject({ username: "admin", target_id: String(hall.id) });
    page = await (await r.admin.get(`/devices?open=${hall.id}`)).text();
    expect(page).toContain('<div class="alert ok" role="alert">New token made for Hall &lt;tok&gt;: open Token / install and run the install command on the Pi again. Its camera tunnel was recreated too.</div>');
    // the API refusing: the token still changed, the banner says the tunnel did not
    fake.refuse = { key: "DELETE /accounts/acct1/cfd_tunnel/tun-5", message: "tunnel has active connections" };
    const mid = await token();
    res = await post(r.admin, `/devices/${hall.id}/regen-token`);
    expect(res.status).toBe(303);
    expect(await token()).not.toBe(mid);
    page = await (await r.admin.get(`/devices?open=${hall.id}`)).text();
    expect(page).toContain('<div class="alert error" role="alert">New token made for Hall &lt;tok&gt;: open Token / install and run the install command on the Pi again. The camera tunnel could not be recreated: Cloudflare API DELETE /accounts/.../cfd_tunnel/tun-5: tunnel has active connections. Click Recreate tunnel on the Devices page to try again.</div>');
    expect((await devRow(hall.id)).tunnel_id).toBe("tun-5");
    expect((await audits("device_tunnel_failed"))[0]).toMatchObject({ username: "admin", target_id: String(hall.id) });
    await query("DELETE FROM devices WHERE id = ?", hall.id);
    await query("DELETE FROM settings WHERE key = 'alert_email'");
  });
});

describe("operator list changes and token rotation", () => {
  // The route ctx shape the stage-2 callers (Settings / Users / Devices) hand these helpers.
  const ctx = () => ({ env, user: { id: 1, username: "admin" }, settings: () => db.loadSettings(env) });

  it("syncAccess rewrites the policy of every device with a tunnel; no-op without secrets, emails or tunnels; the API refusing is the reason", async () => {
    await query("DELETE FROM audit_log WHERE action = 'camera_access_updated'");
    await query("UPDATE devices SET tunnel_id = NULL, tunnel_hostname = NULL, camera_live_url = NULL WHERE id = ?", lobby.id);
    const fake = fakeCloudflare();
    expect(await cloudflare.syncAccess(ctx())).toBeNull(); // not configured
    configure();
    await query("DELETE FROM settings WHERE key = 'alert_email'");
    expect(await cloudflare.syncAccess(ctx())).toBeNull(); // no operator email known
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('alert_email', 'ops@example.net, matt@example.net')");
    expect(await cloudflare.syncAccess(ctx())).toBeNull(); // no device has a tunnel
    expect(fake.calls.length).toBe(0);
    expect((await audits("camera_access_updated")).length).toBe(0);
    await cloudflare.provision(CF, "lobby", EMAILS);
    await cloudflare.provision(CF, "hall", EMAILS);
    const hall = await device("hall", "Hall");
    await query("UPDATE devices SET tunnel_id = 'tun-1' WHERE id = ?", lobby.id);
    await query("UPDATE devices SET tunnel_id = 'tun-5' WHERE id = ?", hall.id);
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('alert_email', 'new@example.net')");
    fake.calls.length = 0;
    expect(await cloudflare.syncAccess(ctx())).toBeNull();
    // only the Access app + policy per device: nothing about tunnels or DNS
    expect(shapes(fake.calls)).toEqual([
      "GET /accounts/acct1/access/apps", "GET /accounts/acct1/access/apps/app-3/policies", "PUT /accounts/acct1/access/apps/app-3/policies/pol-4",
      "GET /accounts/acct1/access/apps", "GET /accounts/acct1/access/apps/app-7/policies", "PUT /accounts/acct1/access/apps/app-7/policies/pol-8",
    ]);
    const want = [{ email: { email: "new@example.net" } }];
    expect(fake.state.policies["app-3"][0].include).toEqual(want);
    expect(fake.state.policies["app-7"][0].include).toEqual(want);
    const [a] = await audits("camera_access_updated");
    expect(a).toMatchObject({ target_type: "settings", target_id: "operators", details: '{"devices": 2, "emails": 1}' });
    // a refusal comes back as the reason, nothing audited for it
    fake.refuse = { key: "PUT /accounts/acct1/access/apps/app-3/policies/pol-4", message: "policy is locked" };
    expect(await cloudflare.syncAccess(ctx())).toBe("Cloudflare API PUT /accounts/.../access/apps/app-3/policies/pol-4: policy is locked");
    expect((await audits("camera_access_updated")).length).toBe(1);
    await query("DELETE FROM devices WHERE id = ?", hall.id);
    await query("UPDATE devices SET tunnel_id = NULL WHERE id = ?", lobby.id);
    await query("DELETE FROM settings WHERE key = 'alert_email'");
  });

  it("rotateTunnel deletes the old tunnel (connections first) and provisions a new one with a new token; a tunnel already gone is fine", async () => {
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('alert_email', 'ops@example.net')");
    await query("UPDATE devices SET tunnel_id = NULL, tunnel_hostname = NULL, camera_live_url = NULL WHERE id = ?", lobby.id);
    const fake = fakeCloudflare();
    const row = () => one("SELECT id, device_id, tunnel_id FROM devices WHERE id = ?", lobby.id);
    await expect(cloudflare.rotateTunnel(ctx(), await row())).rejects.toThrow("CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID not set");
    expect(fake.calls.length).toBe(0);
    configure();
    // no tunnel yet: plain provisioning
    expect(await cloudflare.rotateTunnel(ctx(), await row())).toEqual({ tunnel_id: "tun-1", hostname: "lobby-cam.photogen5000.com" });
    expect(fake.calls.filter((c) => c.method === "DELETE").length).toBe(0);
    expect(await cloudflare.tunnelToken(CF, "tun-1")).toBe("eyJ-token-for-tun-1");
    fake.calls.length = 0;
    const out = await cloudflare.rotateTunnel(ctx(), await row());
    expect(out).toEqual({ tunnel_id: "tun-5", hostname: "lobby-cam.photogen5000.com" });
    expect(shapes(fake.calls).slice(0, 4)).toEqual([
      "DELETE /accounts/acct1/cfd_tunnel/tun-1/connections", "DELETE /accounts/acct1/cfd_tunnel/tun-1",
      "GET /accounts/acct1/cfd_tunnel", "POST /accounts/acct1/cfd_tunnel",
    ]);
    expect(fake.state.tunnels.map((t) => t.id)).toEqual(["tun-5"]);
    expect(await devRow(lobby.id)).toEqual({ tunnel_id: "tun-5", tunnel_hostname: "lobby-cam.photogen5000.com", camera_live_url: "https://lobby-cam.photogen5000.com/" });
    // the CNAME follows, the Access app is reused, the new token differs
    expect(fake.state.dns.map((d) => d.content)).toEqual(["tun-5.cfargotunnel.com"]);
    expect(fake.state.apps.length).toBe(1);
    expect(await cloudflare.tunnelToken(CF, "tun-5")).toBe("eyJ-token-for-tun-5");
    // the stored tunnel is already gone on Cloudflare's side: 404 ignored, still rotated
    await query("UPDATE devices SET tunnel_id = 'tun-gone' WHERE id = ?", lobby.id);
    expect((await cloudflare.rotateTunnel(ctx(), await row())).tunnel_id).toBe("tun-5");
    expect(fake.state.tunnels.length).toBe(1);
    // any other refusal is the caller's error
    fake.refuse = { key: "DELETE /accounts/acct1/cfd_tunnel/tun-5", message: "tunnel has active connections" };
    await expect(cloudflare.rotateTunnel(ctx(), await row())).rejects.toThrow("Cloudflare API DELETE /accounts/.../cfd_tunnel/tun-5: tunnel has active connections");
    expect((await devRow(lobby.id)).tunnel_id).toBe("tun-5");
    await query("UPDATE devices SET tunnel_id = NULL, tunnel_hostname = NULL, camera_live_url = NULL WHERE id = ?", lobby.id);
    await query("DELETE FROM settings WHERE key = 'alert_email'");
  });
});

describe("manifest tunnel block", () => {
  it("the device's own sync gets {token, hostname} fetched per sync; null without a tunnel, secrets or API", async () => {
    await query("UPDATE devices SET tunnel_id = 'tun-9', tunnel_hostname = 'lobby-cam.photogen5000.com' WHERE id = ?", lobby.id);
    const hall = await device("hall", "Hall");
    const fake = fakeCloudflare();
    // secrets absent: no call, null (absence = feature off for the player)
    expect((await (await sync(lobby)).json()).tunnel).toBeNull();
    expect(fake.calls.length).toBe(0);
    configure();
    let m = await (await sync(lobby)).json();
    expect(m.tunnel).toEqual({ token: "eyJ-token-for-tun-9", hostname: "lobby-cam.photogen5000.com" });
    expect(shapes(fake.calls)).toEqual(["GET /accounts/acct1/cfd_tunnel/tun-9/token"]);
    expect(fake.calls[0].auth).toBe("Bearer cf-test-token");
    // fetched again on the next sync, never stored
    m = await (await sync(lobby)).json();
    expect(m.tunnel.token).toBe("eyJ-token-for-tun-9");
    expect(fake.calls.length).toBe(2);
    expect((await query("SELECT * FROM devices WHERE id = ?", lobby.id))[0]).not.toMatchObject({ token: expect.stringContaining("eyJ") });
    expect(JSON.stringify(await query("SELECT * FROM devices")) + JSON.stringify(await query("SELECT * FROM settings"))).not.toContain("eyJ-token");
    // no tunnel on this device
    expect((await (await sync(hall)).json()).tunnel).toBeNull();
    // the API down: sync still answers, tunnel null (the player keeps its token file)
    fake.status = 500;
    const down = await sync(lobby);
    expect(down.status).toBe(200);
    expect((await down.json()).tunnel).toBeNull();
    fake.status = null;
    // another device's bearer cannot read it
    const other = await SELF.fetch(`${BASE}/api/sync/lobby`, { headers: { authorization: `Bearer ${hall.token}` } });
    expect(other.status).toBe(403);
    expect(await other.text()).not.toContain("eyJ");
    await query("DELETE FROM devices WHERE id = ?", hall.id);
  });

  it("the token never reaches a page: Devices shows the hostname badge and the button (editors, when configured)", async () => {
    await query("UPDATE devices SET tunnel_id = 'tun-9', tunnel_hostname = 'lobby-cam.photogen5000.com', camera_live_url = 'https://lobby-cam.photogen5000.com/' WHERE id = ?", lobby.id);
    const fake = fakeCloudflare();
    let page = await (await r.editor.get("/devices")).text();
    expect(page).toContain("tunnel · lobby-cam.photogen5000.com");
    expect(page).toContain("Camera · live URL set · tunnel");
    expect(page).toContain("Automatic tunnels are not configured");
    expect(page).not.toContain(`action="/devices/${lobby.id}/tunnel"`);
    configure();
    page = await (await r.editor.get("/devices")).text();
    expect(page).toContain(`action="/devices/${lobby.id}/tunnel"`);
    expect(page).toContain(">Recreate tunnel</button>");
    expect(page).toContain("<code>p5k-lobby</code>");
    expect(page).not.toContain("eyJ");
    expect(fake.calls.length).toBe(0); // rendering never calls the API
    const viewer = await (await r.viewer.get("/devices")).text();
    expect(viewer).toContain("tunnel · lobby-cam.photogen5000.com");
    expect(viewer).not.toContain(`action="/devices/${lobby.id}/tunnel"`);
    await query("UPDATE devices SET tunnel_id = NULL, tunnel_hostname = NULL, camera_live_url = NULL WHERE id = ?", lobby.id);
    page = await (await r.editor.get("/devices")).text();
    expect(page).toContain('<span class="badge badge-muted">no tunnel</span>');
    expect(page).toContain(">Create tunnel</button>");
    expect(page).toContain("<code>lobby-cam.photogen5000.com</code>");
  });
});

describe("settings panel", () => {
  it("shows not configured with the missing secret names, configured otherwise, and the operator emails", async () => {
    let page = await (await r.admin.get("/settings")).text();
    expect(page).toContain("Camera tunnels (Cloudflare) <span class=\"badge badge-muted\">not configured</span>");
    expect(page).toContain("Missing: <code>CF_API_TOKEN</code>, <code>CF_ACCOUNT_ID</code>, <code>CF_ZONE_ID</code>");
    expect(page).toContain('<span class="badge badge-stale">none</span> set the alert email addresses');
    expect(page).toContain("Devices with a tunnel: 0.");
    env.CF_API_TOKEN = "x";
    page = await (await r.admin.get("/settings")).text();
    expect(page).toContain("Missing: <code>CF_ACCOUNT_ID</code>, <code>CF_ZONE_ID</code>");
    configure();
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('alert_email', 'ops@example.net, <b>@x.y')");
    page = await (await r.admin.get("/settings")).text();
    // a junk address list is not one (loadSettings drops it) -> fallback wins; the escape is checked with a valid one below
    expect(page).toContain("Camera tunnels (Cloudflare) <span class=\"badge badge-active\">configured</span>");
    expect(page).not.toContain("Missing:");
    await query("INSERT OR REPLACE INTO settings (key, value) VALUES ('alert_email', 'ops@example.net, matt@example.net')");
    await query("UPDATE devices SET tunnel_id = 't' WHERE id = ?", lobby.id);
    page = await (await r.admin.get("/settings")).text();
    expect(page).toContain("Operator emails (Access policy): <code>ops@example.net</code>, <code>matt@example.net</code>. Devices with a tunnel: 1.");
    expect(page).toContain("<code>&lt;device_id&gt;-cam.photogen5000.com</code>");
    await query("DELETE FROM settings WHERE key = 'alert_email'");
    await query("UPDATE devices SET tunnel_id = NULL WHERE id = ?", lobby.id);
  });
});
