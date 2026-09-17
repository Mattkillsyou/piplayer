// Device-code sign-in for the SD flasher (device_codes.js, migration 0004): POST
// /api/operator/device-code, GET/POST /authorize (editor+, CSRF), POST /api/operator/device-token
// (pending / one-shot token / expired / denied), the per-IP cap, housekeeping and the audit row.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as auth from "../src/auth.js";
import * as dc from "../src/device_codes.js";
import { BASE, Client, query } from "./helpers.js";
import { audits, detail, post, roleMatrix, roles } from "./pages_common.js";

let r;
const CODE_RX = new RegExp(`^[${dc.USER_CODE_ALPHABET}]{6}$`);
const rows = () => query("SELECT * FROM device_codes ORDER BY created_at");
const tokens = () => query("SELECT id, user_id, name, token_hash FROM api_tokens ORDER BY id");
const api = (path, data, headers = {}) => SELF.fetch(`${BASE}/api/operator/${path}`, {
  method: "POST", body: JSON.stringify(data), headers: { "content-type": "application/json", ...headers },
});
const start = async (hostname = "matts-laptop", headers = {}) => {
  const res = await api("device-code", { hostname }, headers);
  expect(res.status).toBe(200);
  return res.json();
};
const poll = (device_code) => api("device-token", { device_code });
const authorize = (c, code, action) => post(c, "/authorize", { code, action });

beforeAll(async () => {
  r = await roles();
});

beforeEach(() => query("DELETE FROM device_codes").then(() => query("DELETE FROM api_tokens")));

describe("POST /api/operator/device-code", () => {
  it("answers the device-flow shape and stores only the hash", async () => {
    const d = await start("Matts-Laptop");
    expect(d.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(d.user_code).toMatch(CODE_RX);
    expect(d).toMatchObject({ verification_url: `${BASE}/authorize`, expires_in: 600, interval: 3 });
    const [row] = await query("SELECT * FROM device_codes WHERE user_code = ?", d.user_code);
    expect(row).toMatchObject({ hostname: "Matts-Laptop", user_id: null, token_plain_until_claimed: null, approved_at: null, denied: 0 });
    expect(row.device_code_hash).toBe(await auth.apiTokenHash(d.device_code));
    expect(JSON.stringify(row)).not.toContain(d.device_code);
  });

  it("tolerates a missing body and cleans the hostname", async () => {
    const res = await SELF.fetch(`${BASE}/api/operator/device-code`, { method: "POST" });
    expect(res.status).toBe(200);
    const { user_code } = await res.json();
    expect((await query("SELECT hostname FROM device_codes WHERE user_code = ?", user_code))[0].hostname).toBe("unknown PC");
    const d = await start(" evil\x00name\n" + "x".repeat(80));
    const [row] = await query("SELECT hostname FROM device_codes WHERE user_code = ?", d.user_code);
    expect(row.hostname).toBe(("evilname" + "x".repeat(80)).slice(0, dc.MAX_HOSTNAME));
    expect((dc.TOKEN_NAME_PREFIX + row.hostname).length).toBeLessThanOrEqual(60);
  });

  it("caps codes per IP per hour", async () => {
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    for (let i = 0; i < dc.MAX_CODES_PER_IP_HOUR; i++) await start("pc", ip);
    expect(await detail(await api("device-code", {}, ip), 429)).toMatch(/too many/);
    expect((await api("device-code", {}, { "cf-connecting-ip": "203.0.113.10" })).status).toBe(200);
  });
});

describe("/authorize", () => {
  it("editor or admin only, GET and POST", async () => {
    await roleMatrix(r, "GET", "/authorize", { minRole: "editor" });
    await roleMatrix(r, "POST", "/authorize", { minRole: "editor", fields: { code: "ZZZZZZ", action: "deny" }, ok: 400 });
  });

  it("happy path: prefilled code, approve, one-shot token that works, audited", async () => {
    await query("DELETE FROM audit_log WHERE action = 'api_token_created'");
    const d = await start("matts-laptop");
    expect((await poll(d.device_code)).status).toBe(428);
    expect(await (await poll(d.device_code)).json()).toEqual({ status: "pending" });

    const shown = dc.displayUserCode(d.user_code).toLowerCase();
    const page = await (await r.editor.get(`/authorize?code=${shown}`)).text();
    expect(page).toContain("Sign in the SD Flasher on matts-laptop?");
    expect(page).toContain(`name="code" value="${d.user_code}"`);

    const res = await authorize(r.editor, shown, "approve");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Approved.");
    const [t] = await tokens();
    expect(t.name).toBe("SD Flasher on matts-laptop");
    expect(t.user_id).toBe((await query("SELECT id FROM users WHERE username = 'ed'"))[0].id);
    const [a] = await audits("api_token_created");
    expect(a).toMatchObject({ username: "ed", target_type: "api_token", target_id: String(t.id),
      details: '{"name": "SD Flasher on matts-laptop", "source": "device-code"}' });
    const [row] = await rows();
    expect(row.approved_at).not.toBeNull();
    expect(html).not.toContain(row.token_plain_until_claimed);

    const got = await poll(d.device_code);
    expect(got.status).toBe(200);
    const body = await got.json();
    expect(body).toEqual({ token: row.token_plain_until_claimed, username: "ed" });
    expect(t.token_hash).toBe(await auth.apiTokenHash(body.token));
    expect((await rows()).length).toBe(0);
    // one shot
    expect((await poll(d.device_code)).status).toBe(410);
    // the token is a normal operator token
    const enr = await SELF.fetch(`${BASE}/api/operator/enrollment`, { headers: { authorization: `Bearer ${body.token}` } });
    expect(enr.status).toBe(200);
    // an approved code cannot be approved again (it is gone)
    expect((await authorize(r.editor, d.user_code, "approve")).status).toBe(400);
  });

  it("anonymous with a code: /login keeps the code in next= and lands back on /authorize", async () => {
    const d = await start();
    const anon = new Client();
    const res = await anon.get(`/authorize?code=${d.user_code}`);
    const next = `/authorize?code=${d.user_code}`;
    expect([res.status, res.headers.get("location")]).toEqual([303, `/login?next=${encodeURIComponent(next)}`]);
    const form = await (await anon.get(res.headers.get("location"))).text();
    expect(form).toContain(`name="next" value="${next}"`);
    const csrf_token = await anon.csrf(res.headers.get("location"));
    const login = await anon.post("/login", { username: "ed", password: "editor-pass", csrf_token, next });
    expect([login.status, login.headers.get("location")]).toEqual([303, next]);
    expect(await (await anon.get(next)).text()).toContain("Sign in the SD Flasher on matts-laptop?");
    // an off-site or scheme-relative next is dropped
    for (const bad of ["https://evil.example/x", "//evil.example/x", "/\\evil.example"]) {
      const c = new Client();
      const t = await c.csrf(`/login?next=${encodeURIComponent(bad)}`);
      expect(await (await c.get(`/login?next=${encodeURIComponent(bad)}`)).text()).not.toContain('name="next"');
      const l = await c.post("/login", { username: "ed", password: "editor-pass", csrf_token: t, next: bad });
      expect(l.headers.get("location")).toBe("/dashboard");
    }
  });

  it("wrong code: the form comes back with an error, nothing minted", async () => {
    const before = (await tokens()).length;
    const page = await (await r.admin.get("/authorize?code=ZZZZ-ZZ")).text();
    expect(page).toContain("not valid or has expired");
    expect(page).toContain('value="ZZZZ-ZZ"');
    const res = await authorize(r.admin, "ZZZZZZ", "approve");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not valid or has expired");
    expect((await tokens()).length).toBe(before);
    // no ?code= shows the empty form; a plain Continue submit lands on the GET
    expect(await (await r.editor.get("/authorize")).text()).toContain("Enter the code");
    const d = await start();
    const cont = await authorize(r.editor, d.user_code, "");
    expect(cont.status).toBe(303);
    expect(cont.headers.get("location")).toBe(`/authorize?code=${d.user_code}`);
  });

  it("deny: the flasher gets 410 denied, no token, audited", async () => {
    await query("DELETE FROM audit_log WHERE action = 'device_code_denied'");
    const d = await start("other-pc");
    const res = await authorize(r.admin, d.user_code, "deny");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Denied.");
    expect((await audits("device_code_denied"))[0]).toMatchObject({ username: "admin", details: '{"hostname": "other-pc"}' });
    const got = await poll(d.device_code);
    expect(got.status).toBe(410);
    expect(await got.json()).toEqual({ status: "denied" });
    expect((await query("SELECT 1 FROM device_codes WHERE user_code = ?", d.user_code)).length).toBe(0);
    expect((await tokens()).length).toBe(0);
    expect((await authorize(r.admin, d.user_code, "approve")).status).toBe(400);
  });

  it("expired: 410 for the flasher and invalid on the page; an unclaimed token is deleted", async () => {
    const d = await start("slow-pc");
    await query("UPDATE device_codes SET created_at = datetime('now', '-11 minutes') WHERE user_code = ?", d.user_code);
    expect((await r.editor.get(`/authorize?code=${d.user_code}`)).status).toBe(200);
    expect(await (await r.editor.get(`/authorize?code=${d.user_code}`)).text()).toContain("not valid or has expired");
    expect((await authorize(r.editor, d.user_code, "approve")).status).toBe(400);
    const got = await poll(d.device_code);
    expect(got.status).toBe(410);
    expect(await got.json()).toEqual({ status: "expired" });
    expect((await rows()).length).toBe(0);

    // approved, then left unclaimed past the expiry: the poll drops the row and the token
    const e = await start("slow-pc");
    expect((await authorize(r.editor, e.user_code, "approve")).status).toBe(200);
    expect((await tokens()).length).toBe(1);
    await query("UPDATE device_codes SET created_at = datetime('now', '-11 minutes') WHERE user_code = ?", e.user_code);
    expect((await poll(e.device_code)).status).toBe(410);
    expect((await tokens()).length).toBe(0);
    expect((await rows()).length).toBe(0);
  });

  it("unknown device_code and bad bodies", async () => {
    expect((await poll("nope")).status).toBe(410);
    expect(await detail(await api("device-token", {}), 400)).toBe("device_code is required");
    expect((await SELF.fetch(`${BASE}/api/operator/device-token`, { method: "POST", body: "x" })).status).toBe(400);
  });

  it("CSRF is enforced on the approve form", async () => {
    const d = await start();
    const res = await r.editor.post("/authorize", { code: d.user_code, action: "approve" });
    expect(res.status).toBe(403);
    expect((await tokens()).length).toBe(0);
  });
});

describe("housekeeping", () => {
  it("prunes rows older than an hour together with unclaimed tokens", async () => {
    const d = await start("old-pc");
    expect((await authorize(r.admin, d.user_code, "approve")).status).toBe(200);
    const fresh = await start("fresh-pc");
    await query("UPDATE device_codes SET created_at = datetime('now', '-61 minutes') WHERE user_code = ?", d.user_code);
    await dc.housekeeping(env);
    expect((await rows()).map((x) => x.user_code)).toEqual([fresh.user_code]);
    expect((await tokens()).length).toBe(0);
  });

  it("user codes are unbiased picks from the alphabet; normalize accepts the display form", () => {
    for (let i = 0; i < 50; i++) expect(dc.newUserCode()).toMatch(CODE_RX);
    expect(dc.normalizeUserCode(" bcdf-g2 ")).toBe("BCDFG2");
    expect(dc.displayUserCode("BCDFG2")).toBe("BCDF-G2");
    expect(dc.cleanHostname(undefined)).toBe("unknown PC");
  });
});
