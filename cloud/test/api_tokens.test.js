// Operator API tokens (feature B): create/revoke on /settings (admin, own tokens only, plaintext
// shown once, only the SHA-256 hash stored), and GET /api/operator/enrollment with a p5k_ bearer:
// payload shape, 401 cases, last_used_at + api_token_used audit at most once per hour.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as auth from "../src/auth.js";
import * as db from "../src/db.js";
import { BASE, Client, query } from "./helpers.js";
import { NOPE, audits, detail, group, playlist, post, roleMatrix, roles } from "./pages_common.js";

let r;
const TOKEN_RX = /p5k_[A-Za-z0-9_-]{32}/;
const tokens = () => query("SELECT id, user_id, name, token_hash, last_used_at FROM api_tokens ORDER BY id");
const fetchEnrollment = (headers = {}) => SELF.fetch(`${BASE}/api/operator/enrollment`, { headers });
const bearer = (t) => ({ authorization: `Bearer ${t}` });

// Create a token through the page and return its plaintext.
async function create(c, name = "laptop") {
  const res = await post(c, "/settings/tokens", { name });
  expect(res.status).toBe(200);
  const html = await res.text();
  const m = /id="new-api-token" value="([^"]+)"/.exec(html);
  expect(m, "token shown once").not.toBeNull();
  return m[1];
}

beforeAll(async () => {
  r = await roles();
});

describe("/settings API tokens", () => {
  it("admin only", async () => {
    await roleMatrix(r, "POST", "/settings/tokens", { minRole: "admin", fields: { name: "m" }, ok: 200 });
    await roleMatrix(r, "POST", `/settings/tokens/${NOPE}/revoke`, { minRole: "admin", ok: 404 });
    await query("DELETE FROM api_tokens");
  });

  it("create shows the token once, stores only its hash, audits the name (never the token)", async () => {
    await query("DELETE FROM audit_log WHERE action LIKE 'api_token_%'");
    const token = await create(r.admin, "  office laptop ");
    expect(token).toMatch(TOKEN_RX);
    const [row] = await tokens();
    expect(row.name).toBe("office laptop");
    expect(row.token_hash).toBe(await auth.apiTokenHash(token));
    expect(row.last_used_at).toBeNull();
    const [a] = await audits("api_token_created");
    expect(a).toMatchObject({ username: "admin", target_type: "api_token", target_id: String(row.id), details: '{"name": "office laptop"}' });
    // the plaintext never appears again: not on the page, not in the audit log
    const page = await (await r.admin.get("/settings")).text();
    expect(page).toContain("office laptop");
    expect(page).not.toContain(token);
    expect(page).not.toContain(row.token_hash);
    expect(page).toContain(`action="/settings/tokens/${row.id}/revoke"`);
    expect((await query("SELECT details FROM audit_log")).some((x) => (x.details || "").includes(token))).toBe(false);
  });

  it("validation: 400 for an empty or over-long name, nothing stored", async () => {
    const before = (await tokens()).length;
    expect(await detail(await post(r.admin, "/settings/tokens", { name: "  " }), 400)).toContain("name must be 1-60 chars");
    expect(await detail(await post(r.admin, "/settings/tokens", { name: "x".repeat(61) }), 400)).toContain("name must be 1-60 chars");
    expect((await tokens()).length).toBe(before);
  });

  it("revoke: own token only (404 for another admin's or a missing id), audits, token stops working", async () => {
    const token = await create(r.admin, "to-revoke");
    const id = (await tokens()).find((t) => t.name === "to-revoke").id;
    // a second admin cannot see or revoke it
    await post(r.admin, "/users", { username: "admin2", password: "admin2pass", role: "admin" });
    const other = new Client();
    await other.login("admin2", "admin2pass");
    other.token = await other.csrf("/dashboard");
    expect(await (await other.get("/settings")).text()).not.toContain("to-revoke");
    expect(await detail(await post(other, `/settings/tokens/${id}/revoke`), 404)).toBe("token not found");
    expect(await detail(await post(r.admin, `/settings/tokens/${NOPE}/revoke`), 404)).toBe("token not found");
    expect(await detail(await post(r.admin, "/settings/tokens/abc/revoke"), 400)).toContain("token_id");
    expect((await fetchEnrollment(bearer(token))).status).toBe(200);
    const res = await post(r.admin, `/settings/tokens/${id}/revoke`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings?revoked=1");
    expect((await tokens()).some((t) => t.id === id)).toBe(false);
    const [a] = await audits("api_token_revoked");
    expect(a).toMatchObject({ username: "admin", target_type: "api_token", target_id: String(id), details: '{"name": "to-revoke"}' });
    expect((await fetchEnrollment(bearer(token))).status).toBe(401);
    expect(await (await r.admin.get("/settings?revoked=1")).text()).toContain("API token revoked.");
  });
});

describe("GET /api/operator/enrollment", () => {
  it("401 without a bearer, with a non-p5k token, an unknown p5k token or a device token", async () => {
    await query("DELETE FROM audit_log WHERE action = 'api_token_used'");
    expect(await detail(await fetchEnrollment(), 401)).toBe("Missing bearer token");
    expect(await detail(await fetchEnrollment({ authorization: "Basic abc" }), 401)).toBe("Missing bearer token");
    expect(await detail(await fetchEnrollment(bearer("")), 401)).toBe("Missing bearer token"); // 'Bearer ' alone is trimmed by Headers
    expect(await detail(await fetchEnrollment(bearer("not-a-token")), 401)).toBe("Invalid API token");
    expect(await detail(await fetchEnrollment(bearer(auth.newApiToken())), 401)).toBe("Invalid API token");
    expect(await detail(await fetchEnrollment(bearer("tok-none")), 401)).toBe("Invalid API token");
    expect(await audits("api_token_used")).toEqual([]);
  });

  it("returns the live enrollment key, groups, playlists, timezone and wyze_configured:false", async () => {
    await query("DELETE FROM settings WHERE key = 'timezone'");
    await db.saveSetting(env, "timezone", "Europe/Berlin");
    const gid = await group("Lobby group");
    const pid = await playlist("Lobby loop");
    const token = await create(r.admin, "flasher");
    const res = await fetchEnrollment(bearer(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    const key = (await db.loadSettings(env)).enrollment_key;
    expect(body).toEqual({
      console_url: BASE, enrollment_key: key, timezone: "Europe/Berlin", wyze_configured: false,
      groups: [{ id: gid, name: "Lobby group" }], playlists: [{ id: pid, name: "Lobby loop" }],
    });
    // rotating the key is reflected on the next call (the flasher never caches it)
    await post(r.admin, "/settings/enrollment/rotate");
    expect((await (await fetchEnrollment(bearer(token))).json()).enrollment_key).not.toBe(key);
    await query("DELETE FROM settings WHERE key = 'timezone'");
  });

  it("stamps last_used_at and audits api_token_used at most once per hour per token", async () => {
    await query("DELETE FROM audit_log WHERE action = 'api_token_used'");
    const token = await create(r.admin, "hourly");
    const id = (await tokens()).find((t) => t.name === "hourly").id;
    for (let i = 0; i < 3; i++) expect((await fetchEnrollment({ ...bearer(token), "cf-connecting-ip": "10.9.9.9" })).status).toBe(200);
    const [row] = await query("SELECT last_used_at FROM api_tokens WHERE id = ?", id);
    expect(row.last_used_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(await audits("api_token_used")).toEqual([
      { username: "admin", target_type: "api_token", target_id: String(id), details: '{"name": "hourly"}', ip: "10.9.9.9" },
    ]);
    // an hour later the next call audits again
    await query("UPDATE api_tokens SET last_used_at = datetime('now', '-61 minutes') WHERE id = ?", id);
    expect((await fetchEnrollment(bearer(token))).status).toBe(200);
    expect((await audits("api_token_used")).length).toBe(2);
  });

  it("a token whose user was demoted to viewer gets 401; deleting the user removes the token", async () => {
    const token = await create(r.admin, "demoted");
    await post(r.admin, "/users", { username: "tmpadmin", password: "tmpadminpw", role: "admin" });
    const uid = (await query("SELECT id FROM users WHERE username = 'tmpadmin'"))[0].id;
    const hash = (await tokens()).find((t) => t.name === "demoted").token_hash;
    await query("UPDATE api_tokens SET user_id = ? WHERE token_hash = ?", uid, hash);
    expect((await fetchEnrollment(bearer(token))).status).toBe(200);
    await post(r.admin, `/users/${uid}/role`, { role: "editor" });
    expect((await fetchEnrollment(bearer(token))).status).toBe(200);
    await post(r.admin, `/users/${uid}/role`, { role: "viewer" });
    expect(await detail(await fetchEnrollment(bearer(token)), 401)).toBe("API token's user is not an editor or admin");
    await post(r.admin, `/users/${uid}/delete`);
    expect((await tokens()).some((t) => t.token_hash === hash)).toBe(false);
    expect((await fetchEnrollment(bearer(token))).status).toBe(401);
  });
});
