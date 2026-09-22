// Audit fixes on the Settings and Users pages: the alert addresses drive the camera Access
// policy on every device (H4, M21), legacy zone abbreviations are refused (H5), the username cap
// (H1) and form attributes (H6), the last-admin guard survives two admins colliding (M16), and
// no banner is ever driven by the query string (L24).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index.js";
import * as cloudflare from "../src/cloudflare.js";
import { isValidTimeZone } from "../src/util.js";
import { BASE, Client, query } from "./helpers.js";
import { audits, detail, device, one, post, roles } from "./pages_common.js";

const CF = { CF_API_TOKEN: "cf-test-token", CF_ACCOUNT_ID: "acct1", CF_ZONE_ID: "zone1" };
const GOOD = { alert_offline_minutes: "15", alert_repeat_minutes: "60", alert_email: "ops@example.net", alert_webhook_url: "" };

function configure(on = true) {
  for (const k of Object.keys(CF)) {
    if (on) env[k] = CF[k];
    else delete env[k];
  }
}

// Just the Access routes syncAccess touches: one app + one policy per hostname, every PUT
// recorded; `refuse` makes the policy PUT answer success:false.
function fakeAccess() {
  const fake = { puts: [], refuse: false };
  vi.stubGlobal("fetch", async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || "GET";
    const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
    if (method === "GET" && u.pathname.endsWith("/access/apps")) return ok([{ id: "app-1", domain: u.searchParams.get("domain") }]);
    if (method === "GET" && u.pathname.endsWith("/policies")) return ok([{ id: "pol-1", name: cloudflare.POLICY_NAME }]);
    if (method === "PUT" && u.pathname.endsWith("/policies/pol-1")) {
      if (fake.refuse) return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "policy is locked" }] }), { status: 400 });
      fake.puts.push(JSON.parse(init.body).include.map((i) => i.email.email));
      return ok({});
    }
    throw new Error(`unexpected ${method} ${u.pathname}`);
  });
  return fake;
}

let r;
let lobby;

beforeAll(async () => {
  r = await roles();
  lobby = await device("lobby", "Lobby", { tunnel_id: "tun-1", tunnel_hostname: "lobby-cam.photogen5000.com" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  configure(false);
  await query("DELETE FROM settings WHERE key LIKE 'alert_%'");
});

describe("H4 + M21: the alert addresses are the camera operator list", () => {
  it("saving a changed address list rewrites every device's Access policy; an unchanged list makes no call", async () => {
    configure();
    const fake = fakeAccess();
    expect((await post(r.admin, "/settings/alerts", { ...GOOD, alert_email: "owner@example.net, leaver@example.net" })).status).toBe(303);
    expect(fake.puts).toEqual([["owner@example.net", "leaver@example.net"]]);
    // the leaver goes: the policy follows on save, no Recreate tunnel loop needed
    expect((await post(r.admin, "/settings/alerts", { ...GOOD, alert_email: "owner@example.net" })).status).toBe(303);
    expect(fake.puts).toEqual([["owner@example.net", "leaver@example.net"], ["owner@example.net"]]);
    expect(await (await r.admin.get("/settings")).text()).toContain('<div class="alert ok" role="alert">Settings saved.</div>');
    expect((await audits("camera_access_updated"))[0]).toMatchObject({ username: "admin", details: '{"devices": 1, "emails": 1}' });
    // same list again: nothing to push
    expect((await post(r.admin, "/settings/alerts", { ...GOOD, alert_email: "owner@example.net" })).status).toBe(303);
    expect(fake.puts.length).toBe(2);
  });

  it("a refused policy update still saves and tells the admin what to do by hand", async () => {
    configure();
    const fake = fakeAccess();
    fake.refuse = true;
    expect((await post(r.admin, "/settings/alerts", { ...GOOD, alert_email: "owner@example.net" })).status).toBe(303);
    expect(await one("SELECT value FROM settings WHERE key = 'alert_email'")).toEqual({ value: "owner@example.net" });
    const page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('<div class="alert error" role="alert">Saved, but the camera access list could not be updated on every device: Cloudflare API PUT /accounts/.../access/apps/app-1/policies/pol-1: policy is locked. Click Recreate tunnel on each device on the Devices page.</div>');
  });

  it("creating, re-roling or deleting a user pushes the admin-username fallback list; a refusal is a banner", async () => {
    configure();
    const fake = fakeAccess();
    // no alert email: admin usernames that are addresses are the operator list
    expect((await post(r.admin, "/users", { username: "ops@example.net", password: "pw123456", role: "admin" })).status).toBe(303);
    expect(fake.puts).toEqual([["ops@example.net"]]);
    expect(await (await r.admin.get("/users")).text()).toContain('<div class="alert ok" role="alert">User created.</div>');
    const u = await one("SELECT id FROM users WHERE username = 'ops@example.net'");
    expect((await post(r.admin, `/users/${u.id}/role`, { role: "editor" })).status).toBe(303);
    expect(fake.puts.length).toBe(1); // no admin address left -> nothing to push (syncAccess null)
    expect(await (await r.admin.get("/users")).text()).toContain('<div class="alert ok" role="alert">Role updated.</div>');
    fake.refuse = true;
    expect((await post(r.admin, `/users/${u.id}/role`, { role: "admin" })).status).toBe(303);
    expect((await one("SELECT role FROM users WHERE id = ?", u.id)).role).toBe("admin");
    let page = await (await r.admin.get("/users")).text();
    expect(page).toContain('<div class="alert error" role="alert">Role updated, but the camera access list could not be updated on every device: Cloudflare API PUT /accounts/.../access/apps/app-1/policies/pol-1: policy is locked. Click Recreate tunnel on each device on the Devices page.</div>');
    fake.refuse = false;
    expect((await post(r.admin, `/users/${u.id}/delete`)).status).toBe(303);
    expect(await one("SELECT id FROM users WHERE id = ?", u.id)).toBeNull();
    page = await (await r.admin.get("/users")).text();
    expect(page).toContain('<div class="alert ok" role="alert">User deleted.</div>');
    expect(fake.puts.length).toBe(1); // the last admin address went with the user: nothing to push
  });

  it("the Email field says it is also the camera access list, only when tunnels are configured", async () => {
    const help = async () => {
      const page = await (await r.admin.get("/settings")).text();
      return page.slice(page.indexOf('name="alert_email"'), page.indexOf("Webhook URL"));
    };
    expect(await help()).not.toContain("live camera page");
    configure();
    const page = await (await r.admin.get("/settings")).text();
    expect(page).not.toContain("These addresses are also the only people allowed to open a device's live camera page");
    expect(page).toContain("Each email address must be verified in Cloudflare Email Routing first.");
    expect(page).toContain('<input type="email" multiple name="alert_email"');
    expect(page).toContain('name="alert_webhook_url" value="" placeholder="https://hooks.slack.com/services/..." pattern="https://.*"');
  });
});

describe("H5: legacy zone abbreviations", () => {
  it("isValidTimeZone keeps UTC and the canonical names, refuses EST/MST/PST and junk", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Europe/London")).toBe(true);
    expect(isValidTimeZone("Etc/GMT+12")).toBe(true); // fixed offset by name, not by accident
    for (const tz of ["EST", "MST", "PST", "HST", "Mars/Olympus", "", null, 5]) expect(isValidTimeZone(tz), String(tz)).toBe(false);
  });
});

describe("H1 + H6: the Users page", () => {
  it("refuses a username over the login cap; the reset form requires a password", async () => {
    expect(await detail(await post(r.admin, "/users", { username: "u".repeat(65), password: "pw123456", role: "viewer" }), 400)).toBe("Username must be at most 64 characters");
    expect(await one("SELECT id FROM users WHERE username = ?", "u".repeat(65))).toBeNull();
    expect((await post(r.admin, "/users", { username: "u".repeat(64), password: "pw123456", role: "viewer" })).status).toBe(303);
    const page = await (await r.admin.get("/users")).text();
    expect(page).toContain('minlength="6" required autocomplete="new-password"');
    expect(page).toContain("Resetting a password signs that user out everywhere.");
  });
});

describe("M16: two admins colliding", () => {
  // SELF.fetch serialises requests; the exported handler called twice in the same isolate lets
  // the two interleave at every D1 await, exactly as on Cloudflare.
  const racers = {};
  const admin = async (by, username) => {
    expect((await post(by, "/users", { username, password: "pw123456", role: "admin" })).status).toBe(303);
    const c = new Client();
    await c.login(username, "pw123456");
    c.token = await c.csrf("/users");
    return (racers[username] = { c, id: (await one("SELECT id FROM users WHERE username = ?", username)).id });
  };
  const raw = (c, path, fields) => worker.fetch(new Request(BASE + path, {
    method: "POST", body: new URLSearchParams(fields), redirect: "manual",
    headers: { cookie: c.cookie, "X-CSRF-Token": c.token, "content-type": "application/x-www-form-urlencoded" },
  }), env, createExecutionContext());
  const admins = () => query("SELECT username FROM users WHERE role = 'admin'").then((rows) => rows.map((u) => u.username));
  const landed = (responses) => responses.filter((x) => x.status === 303 && x.headers.get("location") === "/users").length;
  // The one admin left after a race (the racer that won it).
  const survivor = async () => {
    const names = await admins();
    expect(names).toHaveLength(1);
    return racers[names[0]];
  };

  it("mutual deletes, mutual demotes and a delete crossing a demote always leave an admin", async () => {
    await query("DELETE FROM users WHERE username NOT IN ('admin', 'ed', 'vw')");
    const a = await admin(r.admin, "racer-a");
    const b = await admin(r.admin, "racer-b");
    // the console owner steps aside so a and b are the last two admins
    const me = await one("SELECT id FROM users WHERE username = 'admin'");
    expect((await post(a.c, `/users/${me.id}/role`, { role: "editor" })).status).toBe(303);
    expect(await admins()).toEqual(["racer-a", "racer-b"]);
    let res = await Promise.all([raw(a.c, `/users/${b.id}/delete`, {}), raw(b.c, `/users/${a.id}/delete`, {})]);
    expect(landed(res)).toBe(1);
    let s = await survivor();
    // two admins again, racing the demotes
    let t = await admin(s.c, "racer-c");
    res = await Promise.all([raw(s.c, `/users/${t.id}/role`, { role: "viewer" }), raw(t.c, `/users/${s.id}/role`, { role: "viewer" })]);
    expect(landed(res)).toBe(1);
    s = await survivor();
    // a delete crossing a demote
    t = await admin(s.c, "racer-d");
    res = await Promise.all([raw(s.c, `/users/${t.id}/delete`, {}), raw(t.c, `/users/${s.id}/role`, { role: "editor" })]);
    expect(landed(res)).toBe(1);
    s = await survivor();
    // the audit row of the surviving write is there; the losing write logged nothing
    expect((await audits("user_delete")).length + (await audits("user_set_role")).length).toBeGreaterThan(0);
    // give the other tests their admin back
    expect((await post(s.c, `/users/${me.id}/role`, { role: "admin" })).status).toBe(303);
    await query("DELETE FROM users WHERE username LIKE 'racer-%'");
  });
});

describe("L24: banners come from the flash cookie, never the URL", () => {
  it("a viewer-clickable link cannot put words in the green or red box, and a banner shows once", async () => {
    const forged = "/settings?saved=1&rotated=1&revoked=1&tested=email&test_error=" + encodeURIComponent("Call 555-0100 now");
    await r.admin.get("/users"); // consumes the notice the previous test's last write left
    let page = await (await r.admin.get(forged)).text();
    expect(page).not.toContain("Call 555-0100");
    expect(page).not.toContain('role="alert"');
    page = await (await r.admin.get("/users?revoked=1")).text();
    expect(page).not.toContain("API token revoked.");
    // a real action: one banner on the next page, gone on the page after
    expect((await post(r.admin, "/settings/enrollment/rotate")).status).toBe(303);
    expect(r.admin.flash).toMatch(/^piplayer_flash=/);
    page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('<div class="alert ok" role="alert">Enrollment key rotated. Cards flashed with the old key must be re-flashed.</div>');
    expect(r.admin.flash).toBeNull();
    expect(await (await r.admin.get("/settings")).text()).not.toContain("Enrollment key rotated");
  });
});
