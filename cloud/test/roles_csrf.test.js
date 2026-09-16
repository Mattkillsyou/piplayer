// Cross-cutting authorization matrix: every spec route x {anonymous, viewer, editor, admin},
// plus the CSRF contract (8) on /login, /logout and every web POST/PUT. Mirrors the
// black-box table in e2e/run_e2e.py so the same expectations run inside workerd.
import { beforeAll, describe, expect, it } from "vitest";
import { Client, SETUP_TOKEN } from "./helpers.js";
import { NOPE, device, playlist, post, postJson, roles } from "./pages_common.js";

const CSRF_DETAIL = "CSRF token missing or invalid";
const FORM_RX = /<form\b[^>]*method=["']post["'][^>]*>([\s\S]*?)<\/form>/gi;
const HIDDEN_RX = /<input[^>]*name="csrf_token"[^>]*value="[^"]+"|<input[^>]*value="[^"]+"[^>]*name="csrf_token"/;
const META_RX = /<meta name="csrf-token" content="([^"]+)">/;

let r;            // {admin, editor, viewer}
let pid, dev;

beforeAll(async () => {
  r = await roles();
  pid = await playlist("matrix");
  dev = await device("matrix-dev", "Matrix Dev", { playlist_id: pid });
});

// Anonymous callers carry a valid CSRF token from their own anonymous session, so what is
// being tested is the auth gate (303 /login for GET, /login?expired=1 for writes), not the CSRF gate.
async function anonSend(method, path, body, kind) {
  const c = new Client();
  const token = await c.csrf("/login");
  if (method === "GET") return c.get(path);
  if (kind === "json") return c.postJson(path, body, { "X-CSRF-Token": token });
  if (kind === "raw") return c.fetch(path, { method: "PUT", body, headers: { "X-CSRF-Token": token, "content-type": "application/octet-stream" } });
  return c.post(path, body, { "X-CSRF-Token": token });
}

function send(c, method, path, body, kind) {
  if (method === "GET") return c.get(path);
  if (kind === "json") return postJson(c, path, body);
  if (kind === "raw") return c.fetch(path, { method: "PUT", body, headers: { "X-CSRF-Token": c.token, "content-type": "application/octet-stream" } });
  return post(c, path, body);
}

// [method, path, body, kind, {viewer, editor, admin}] — anonymous is always 303 /login.
// Inputs are chosen so the allowed roles get a deterministic non-mutating answer
// (400 malformed / 404 missing row / 200 page).
const A = 303, V = 403;
const E = (code) => ({ viewer: V, editor: code, admin: code });
const AD = (code) => ({ viewer: V, editor: V, admin: code });
const ALL = (code) => ({ viewer: code, editor: code, admin: code });
function table() {
  return [
    ["GET", "/dashboard", null, null, ALL(200)],
    ["GET", "/library", null, null, ALL(200)],
    ["GET", "/playlists", null, null, ALL(200)],
    ["GET", `/playlists/${pid}`, null, null, ALL(200)],
    ["GET", "/devices", null, null, ALL(200)],
    ["GET", `/devices/${dev.id}/schedule`, null, null, ALL(200)],
    ["GET", `/devices/${NOPE}/screenshot`, null, null, ALL(404)],
    ["GET", "/groups", null, null, ALL(200)],
    ["GET", "/audit", null, null, ALL(200)],
    ["GET", "/users", null, null, AD(200)],
    ["GET", "/settings", null, null, AD(200)],
    ["GET", `/library/upload/${NOPE}`, null, null, E(404)],
    ["POST", "/library/upload/init", { name: "x.exe", size: 10, sha256: "0".repeat(64), media_type: "video", duration_seconds: 1, width: 1, height: 1 }, "json", E(400)],
    ["PUT", `/library/upload/${NOPE}/part/1`, "x", "raw", E(404)],
    ["POST", `/library/upload/${NOPE}/complete`, {}, "json", E(404)],
    ["POST", `/library/upload/${NOPE}/abort`, {}, "json", E(404)],
    ["POST", `/library/${NOPE}/delete`, {}, "form", E(404)],
    ["POST", "/playlists", { name: "  " }, "form", E(400)],
    ["POST", `/playlists/${NOPE}/items`, { media_id: "1" }, "form", E(404)],
    ["POST", `/playlists/${NOPE}/items/reorder`, { order: [] }, "json", E(404)],
    ["POST", `/playlists/${NOPE}/items/${NOPE}/duration`, { duration: "5" }, "form", E(404)],
    ["POST", `/playlists/${NOPE}/items/${NOPE}/delete`, {}, "form", E(404)],
    ["POST", `/playlists/${NOPE}/rename`, { name: "x" }, "form", E(404)],
    ["POST", `/playlists/${NOPE}/delete`, {}, "form", E(404)],
    ["POST", "/devices", { device_id: "Bad_ID!", name: "x" }, "form", E(400)],
    ["POST", `/devices/${NOPE}/assign`, { playlist_id: "" }, "form", E(404)],
    ["POST", `/devices/${NOPE}/group`, { group_id: "" }, "form", E(404)],
    ["POST", `/devices/${NOPE}/regen-token`, {}, "form", E(404)],
    ["POST", `/devices/${NOPE}/delete`, {}, "form", E(404)],
    ["POST", `/devices/${NOPE}/command`, { command: "reboot" }, "form", E(404)],
    ["POST", `/devices/${NOPE}/schedule`, { name: "r", playlist_id: String(pid), priority: "1" }, "form", E(404)],
    ["POST", `/devices/${NOPE}/schedule/${NOPE}/delete`, {}, "form", E(404)],
    ["POST", "/groups", { name: " " }, "form", E(400)],
    ["POST", `/groups/${NOPE}/assign`, { playlist_id: "" }, "form", E(404)],
    ["POST", `/groups/${NOPE}/delete`, {}, "form", E(404)],
    ["POST", "/users", { username: "u", password: "short", role: "viewer" }, "form", AD(400)],
    ["POST", `/users/${NOPE}/role`, { role: "viewer" }, "form", AD(404)],
    ["POST", `/users/${NOPE}/password`, { password: "pw123456" }, "form", AD(404)],
    ["POST", `/users/${NOPE}/delete`, {}, "form", AD(404)],
    ["POST", `/users/${NOPE}/tokens`, { name: "m" }, "form", AD(404)],
    ["POST", `/users/${NOPE}/tokens/${NOPE}/revoke`, {}, "form", AD(404)],
    ["POST", "/settings", { timezone: "Not/AZone", screenshot_interval: "60", default_image_duration: "10" }, "form", AD(400)],
    ["POST", "/settings/tokens", { name: " " }, "form", AD(400)],
    ["POST", `/settings/tokens/${NOPE}/revoke`, {}, "form", AD(404)],
    ["GET", `/setup?token=${SETUP_TOKEN}`, null, null, ALL(404)],
    ["POST", "/setup", { token: SETUP_TOKEN, username: "x", password: "pw123456", password2: "pw123456" }, "form", ALL(404)],
  ];
}

describe("authorization matrix", () => {
  it("anonymous -> 303 /login on every route (setup is 404 once users exist)", async () => {
    for (const [method, path, body, kind, exp] of table()) {
      const res = await anonSend(method, path, body, kind);
      const want = path.startsWith("/setup") ? 404 : A;
      expect(res.status, `anon ${method} ${path}`).toBe(want);
      if (want === A) expect(res.headers.get("location"), `anon ${method} ${path}`).toBe(method === "GET" ? "/login" : "/login?expired=1");
    }
    const root = await new Client().get("/");
    expect([root.status, root.headers.get("location")]).toEqual([303, "/login"]);
  });

  for (const role of ["viewer", "editor", "admin"]) {
    it(`${role} gets the expected code on every route`, async () => {
      for (const [method, path, body, kind, exp] of table()) {
        const res = await send(r[role], method, path, body, kind);
        expect(res.status, `${role} ${method} ${path}`).toBe(exp[role]);
        expect(res.status, `${role} ${method} ${path} is a stub`).not.toBe(501);
        if (exp[role] === 403) expect((await res.json()).detail).toMatch(/^requires (editor|admin) role$/);
      }
      const root = await r[role].get("/");
      expect([root.status, root.headers.get("location")]).toEqual([303, "/dashboard"]);
    });
  }

  it("viewers never see device tokens or the install command; editors and admins do", async () => {
    const v = await (await r.viewer.get("/devices")).text();
    expect(v).toContain("Matrix Dev");
    expect(v).not.toContain(dev.token);
    expect(v).not.toContain("DEVICE_TOKEN=");
    for (const c of [r.editor, r.admin]) {
      const t = await (await c.get("/devices")).text();
      expect(t).toContain(dev.token);
      expect(t).toContain("cd piplayer/player");
      expect(t).toContain(`DEVICE_ID=${dev.device_id}`);
      expect(t).toContain("deploy/install-player.sh");
      expect(t).toMatch(/CMS_URL=https?:\/\//);
    }
  });

  it("nav shows Users/Settings only to admins", async () => {
    for (const [c, has] of [[r.viewer, false], [r.editor, false], [r.admin, true]]) {
      const t = await (await c.get("/dashboard")).text();
      expect(t.includes('href="/users"')).toBe(has);
      expect(t.includes('href="/settings"')).toBe(has);
    }
  });
});

describe("csrf (contract 8)", () => {
  const creds = { username: "admin", password: "test1234" };

  it("login: missing, wrong and foreign tokens are 403 JSON; form field and header both work", async () => {
    const c = new Client();
    let res = await c.post("/login", creds);
    expect([res.status, res.headers.get("location")]).toEqual([303, "/login?expired=1"]); // no session at all: fresh form
    await c.get("/login?expired=1"); // the GET the browser lands on starts the session
    res = await c.post("/login", creds);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: CSRF_DETAIL });
    await c.csrf("/login");
    res = await c.post("/login", { ...creds, csrf_token: "not-the-token" });
    expect(res.status).toBe(403);
    const foreign = await new Client().csrf("/login");
    res = await c.post("/login", { ...creds, csrf_token: foreign });
    expect(res.status).toBe(403);
    expect(await c.csrf("/login")).toBe(await c.csrf("/login"));
    res = await c.post("/login", creds, { "X-CSRF-Token": await c.csrf("/login") });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/dashboard"]);
    const d = new Client();
    res = await d.post("/login", { ...creds, csrf_token: await d.csrf("/login") });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/dashboard"]);
  });

  it("logout requires the token and the session survives a refused logout", async () => {
    const c = new Client();
    await c.login("admin", "test1234");
    const res = await c.post("/logout", {});
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toBe(CSRF_DETAIL);
    expect((await c.get("/dashboard")).status).toBe(200);
    const out = await c.post("/logout", { csrf_token: await c.csrf("/dashboard") });
    expect([out.status, out.headers.get("location")]).toEqual([303, "/login"]);
    expect((await c.get("/dashboard")).status).toBe(303);
  });

  it("authenticated form / JSON / raw / multipart requests without the token are 403 and write nothing", async () => {
    const a = r.admin;
    let res = await a.post("/playlists", { name: "csrf-nope" });
    expect(res.status).toBe(403);
    res = await a.post("/playlists", { name: "csrf-nope", csrf_token: await new Client().csrf("/login") });
    expect(res.status).toBe(403);
    res = await a.postJson(`/playlists/${pid}/items/reorder`, { order: [] });
    expect(res.status).toBe(403);
    res = await a.fetch("/library/upload/x/part/1", { method: "PUT", body: "x" });
    expect(res.status).toBe(403);
    const fd = new FormData();
    fd.set("device_id", "csrf-multipart");
    fd.set("name", "x");
    res = await a.fetch("/devices", { method: "POST", body: fd });
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toBe(CSRF_DETAIL);
    expect(await (await a.get("/playlists")).text()).not.toContain("csrf-nope");
    expect(await (await a.get("/devices")).text()).not.toContain("csrf-multipart");
  });

  it("/api/* is exempt (bearer auth instead)", async () => {
    const res = await new Client().fetch(`/api/commands/${NOPE}/result`, {
      method: "POST", body: JSON.stringify({ result: "x" }), headers: { "content-type": "application/json", authorization: `Bearer ${dev.token}` },
    });
    expect(res.status).toBe(404);
  });

  it("every rendered POST form carries the hidden csrf_token input and every page the meta tag", async () => {
    const pages = ["/dashboard", "/library", "/playlists", `/playlists/${pid}`, "/devices", `/devices/${dev.id}/schedule`,
      "/groups", "/users", "/audit", "/settings"];
    for (const p of pages) {
      const res = await r.admin.get(p);
      expect(res.status, p).toBe(200);
      const html = await res.text();
      const meta = META_RX.exec(html);
      expect(meta, `${p} meta`).not.toBeNull();
      const forms = [...html.matchAll(FORM_RX)].map((m) => m[1]);
      expect(forms.length, `${p} has at least one POST form`).toBeGreaterThan(0);
      for (const body of forms) expect(body, `${p} form lacks csrf_token`).toMatch(HIDDEN_RX);
      expect(html).not.toContain("onsubmit=");
      expect(html).not.toContain("onchange=");
    }
    const login = await (await new Client().get("/login")).text();
    expect(login).toMatch(HIDDEN_RX);
    expect(META_RX.exec(login)[1]).toBe(HIDDEN_RX.exec(login)[0].match(/value="([^"]+)"/)[1]);
  });
});
