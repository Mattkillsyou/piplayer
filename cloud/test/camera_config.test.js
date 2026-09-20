// Camera zero-config (D): secrets.js AES-GCM round trip, the Settings Wyze section (set /
// replace / clear, never echoed, audit without values), per-device camera source on the
// Devices page, GET /api/camera-config/:device_id (device bearer, resolution rules, daily
// audit), camera_config_version bumped on any change and sent in the manifest, and
// /api/operator/enrollment wyze_configured.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as secrets from "../src/secrets.js";
import * as auth from "../src/auth.js";
import { BASE, query } from "./helpers.js";
import { audits, detail, device, one, post, roleMatrix, roles } from "./pages_common.js";

const bearer = (token) => ({ authorization: `Bearer ${token}` });
const version = async () => Number((await one("SELECT value FROM settings WHERE key = 'camera_config_version'"))?.value ?? 0);
const config = (d, headers = bearer(d.token)) => SELF.fetch(`${BASE}/api/camera-config/${d.device_id}`, { headers });
const sync = (d) => SELF.fetch(`${BASE}/api/sync/${d.device_id}`, { headers: bearer(d.token) }).then((r) => r.json());
const WYZE = { wyze_email: "ops@example.com", wyze_password: "hunter2!", wyze_api_id: "id-123", wyze_api_key: "key-456" };

let r;
let dev;
let other;

beforeAll(async () => {
  r = await roles();
  dev = await device("cam-a", "Lobby Cam");
  other = await device("cam-b", "Other");
});

describe("secrets.js", () => {
  it("round-trips through AES-GCM with a fresh iv, binds the name, rejects tampering and another key", async () => {
    const a = await secrets.encrypt(env, "k", "hello wyze");
    const b = await secrets.encrypt(env, "k", "hello wyze");
    expect(a).toMatch(/^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b); // random iv
    expect(a).not.toContain("hello");
    expect(await secrets.decrypt(env, "k", a)).toBe("hello wyze");
    expect(await secrets.decrypt(env, "k", b)).toBe("hello wyze");
    expect(await secrets.decrypt(env, "other-name", a)).toBeNull();
    expect(await secrets.decrypt(env, "k", a.slice(0, -2) + "AA")).toBeNull();
    expect(await secrets.decrypt(env, "k", "v0:x:y")).toBeNull();
    expect(await secrets.decrypt(env, "k", "garbage")).toBeNull();
    expect(await secrets.decrypt({ SESSION_SECRET: "another-secret" }, "k", a)).toBeNull();
    await expect(secrets.encrypt({}, "k", "x")).rejects.toThrow("SESSION_SECRET is not configured");
  });

  it("set / get / getMany / names; empty deletes; the row never holds the plaintext", async () => {
    await secrets.set(env, "t1", "one");
    await secrets.set(env, "t2", "two");
    expect(await secrets.get(env, "t1")).toBe("one");
    expect(await secrets.get(env, "nope")).toBeNull();
    expect(await secrets.getMany(env, ["t1", "t2", "t3"])).toEqual({ t1: "one", t2: "two", t3: null });
    expect([...await secrets.names(env)].sort()).toEqual(["t1", "t2"]);
    const row = await one("SELECT value FROM secrets WHERE name = 't1'");
    expect(row.value).not.toContain("one");
    await secrets.set(env, "t1", "uno"); // replace
    expect(await secrets.get(env, "t1")).toBe("uno");
    await secrets.set(env, "t1", "");
    await secrets.set(env, "t2", "");
    expect(await secrets.names(env)).toEqual(new Set());
    expect(await secrets.wyzeConfigured(env)).toBe(false);
  });

  it("rotating SESSION_SECRET reads every stored secret as not set (names / wyzeConfigured decrypt)", async () => {
    await secrets.set(env, "wyze_email", "ops@example.com");
    await secrets.set(env, "wyze_password", "hunter2!");
    expect(await secrets.wyzeConfigured(env)).toBe(true);
    const rotated = { ...env, SESSION_SECRET: "rotated" };
    expect(await secrets.names(rotated)).toEqual(new Set());
    expect(await secrets.wyzeConfigured(rotated)).toBe(false);
    expect(await secrets.getMany(rotated, ["wyze_email"])).toEqual({ wyze_email: null });
    await secrets.set(env, "wyze_email", "");
    await secrets.set(env, "wyze_password", "");
  });
});

describe("Settings: Wyze account", () => {
  it("admin only; page shows not set and no values; saving stores encrypted, bumps the version, audits without values", async () => {
    await roleMatrix(r, "GET", "/settings", { minRole: "admin" });
    let page = await (await r.admin.get("/settings")).text();
    expect(page).toContain("<h2>Wyze account (camera zero-config)</h2>");
    expect(page).toContain("Status: <strong>not configured</strong>");
    expect(page.match(/badge-muted">not set/g)).toHaveLength(4);
    expect(page).toContain('name="wyze_camera_pattern" value="{device_name}"');
    expect(page).not.toContain("Clear Wyze account");
    expect(await version()).toBe(0);

    await roleMatrix(r, "POST", "/settings/wyze", { minRole: "admin", fields: WYZE });
    expect(await version()).toBe(1);
    expect(await secrets.getMany(env, secrets.WYZE_NAMES)).toEqual(WYZE);
    for (const v of Object.values(WYZE)) expect((await query("SELECT value FROM secrets")).map((x) => x.value).join()).not.toContain(v);
    const [a] = await audits("wyze_settings_update");
    expect(a.username).toBe("admin");
    expect(JSON.parse(a.details)).toEqual({ wyze_email: "set", wyze_password: "set", wyze_api_id: "set", wyze_api_key: "set" });
    expect(a.details).not.toContain("hunter2");

    page = await (await r.admin.get("/settings")).text();
    expect(page).toContain("Status: <strong>configured</strong>");
    expect(page.match(/badge-active">set/g)).toHaveLength(4);
    expect(page).toContain("Clear Wyze account");
    for (const v of Object.values(WYZE)) expect(page).not.toContain(v);
    expect(page).toContain('name="wyze_password" value="" placeholder="leave empty to keep"');
  });

  it("empty fields keep the stored value; a filled one replaces; pattern validated; unchanged save does not bump", async () => {
    const before = await version();
    let res = await post(r.admin, "/settings/wyze", { wyze_password: "new-pass" });
    expect(res.status).toBe(303);
    expect(await secrets.getMany(env, secrets.WYZE_NAMES)).toEqual({ ...WYZE, wyze_password: "new-pass" });
    expect(await version()).toBe(before + 1);

    res = await post(r.admin, "/settings/wyze", {}); // nothing changed
    expect(res.status).toBe(303);
    expect(await version()).toBe(before + 1);

    expect(await detail(await post(r.admin, "/settings/wyze", { wyze_camera_pattern: "x".repeat(101) }), 400)).toBe("wyze_camera_pattern must be 1-100 printable chars");
    expect(await detail(await post(r.admin, "/settings/wyze", { wyze_email: "a\u0000b" }), 400)).toBe("wyze_email must be at most 500 printable chars");
    expect(await version()).toBe(before + 1);

    res = await post(r.admin, "/settings/wyze", { wyze_camera_pattern: "Cam {device_id}" });
    expect(res.status).toBe(303);
    expect((await one("SELECT value FROM settings WHERE key = 'wyze_camera_pattern'")).value).toBe("Cam {device_id}");
    expect(await version()).toBe(before + 2);
    expect(JSON.parse((await audits("wyze_settings_update"))[0].details)).toEqual({ wyze_camera_pattern: "Cam {device_id}" });
  });

  it("GET /api/operator/enrollment reports wyze_configured true once email + password are set", async () => {
    const token = auth.newApiToken();
    const me = await one("SELECT id FROM users WHERE username = 'admin'");
    await query("INSERT INTO api_tokens (user_id, name, token_hash) VALUES (?, 'flasher', ?)", me.id, await auth.apiTokenHash(token));
    const res = await SELF.fetch(`${BASE}/api/operator/enrollment`, { headers: bearer(token) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wyze_configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("new-pass");
  });
});

describe("GET /api/camera-config/:device_id", () => {
  it("device bearer only: no token 401, another device 403, a browser session 401", async () => {
    expect((await config(dev, {})).status).toBe(401);
    expect(await detail(await config(dev, bearer(other.token)), 403)).toBe("Token does not match device id");
    expect((await r.admin.get(`/api/camera-config/${dev.device_id}`)).status).toBe(401);
    expect(await audits("camera_config_fetched")).toEqual([]);
  });

  it("site default = wyze when the account is set, camera name from the pattern; audited once a day", async () => {
    const res = await config(dev);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      source: "wyze", version: await version(),
      wyze: { email: "ops@example.com", password: "new-pass", api_id: "id-123", api_key: "key-456", camera: "Cam cam-a" },
    });
    await config(dev);
    const a = await audits("camera_config_fetched");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ username: null, target_type: "device", target_id: String(dev.id), details: '{"device_id": "cam-a", "source": "wyze"}' });
    await query("UPDATE devices SET camera_config_audited_at = datetime('now', '-25 hours') WHERE id = ?", dev.id);
    await config(dev);
    expect(await audits("camera_config_fetched")).toHaveLength(2);
  });

  it("manifest carries camera_config_version", async () => {
    expect((await sync(dev)).camera_config_version).toBe(await version());
  });
});

describe("Devices page: camera source", () => {
  const row = () => one("SELECT camera_source, camera_rtsp_url, camera_wyze_name FROM devices WHERE id = ?", dev.id);

  it("editor+ sets source / rtsp url / wyze name; validated; bumps the version; audit without the URL", async () => {
    const v0 = await version();
    await roleMatrix(r, "POST", `/devices/${dev.id}/camera-source`, { fields: { camera_source: "wyze", camera_wyze_name: "Front Door" } });
    expect(await row()).toEqual({ camera_source: "wyze", camera_rtsp_url: null, camera_wyze_name: "Front Door" });
    expect(await version()).toBe(v0 + 1);
    expect((await (await config(dev)).json()).wyze.camera).toBe("Front Door");
    const [a] = await audits("device_set_camera_source");
    expect(a.username).toBe("ed");
    expect(JSON.parse(a.details)).toEqual({ camera_source: "wyze", camera_wyze_name: "Front Door" });

    // unchanged save: no bump
    expect((await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "wyze", camera_wyze_name: "Front Door" })).status).toBe(303);
    expect(await version()).toBe(v0 + 1);

    const bad = [
      [{ camera_source: "usb" }, "camera_source must be one of none, wyze, rtsp or empty for the site default"],
      [{ camera_source: "rtsp" }, "camera_rtsp_url required when camera_source is rtsp"],
      [{ camera_source: "rtsp", camera_rtsp_url: "https://x/" }, "camera_rtsp_url must be an rtsp:// or rtsps:// URL"],
      [{ camera_source: "wyze", camera_wyze_name: "x".repeat(101) }, "camera_wyze_name must be at most 100 printable chars"],
    ];
    for (const [fields, msg] of bad) expect(await detail(await post(r.editor, `/devices/${dev.id}/camera-source`, fields), 400), msg).toBe(msg);
    expect((await post(r.editor, "/devices/999999/camera-source", { camera_source: "none" })).status).toBe(404);
    expect(await version()).toBe(v0 + 1);

    const rtsp = "rtsp://user:pw@10.0.0.5:554/stream1";
    expect((await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "rtsp", camera_rtsp_url: rtsp })).status).toBe(303);
    expect(await row()).toEqual({ camera_source: "rtsp", camera_rtsp_url: rtsp, camera_wyze_name: null });
    expect(await (await config(dev)).json()).toEqual({ source: "rtsp", rtsp_url: rtsp, version: v0 + 2 });
    expect(JSON.parse((await audits("device_set_camera_source"))[0].details)).toEqual({ camera_source: "rtsp", camera_rtsp_url: "set" });
    expect((await audits("device_set_camera_source"))[0].details).not.toContain("user:pw");

    // the URL is never rendered back, so an empty field keeps it (and is not a change)
    expect((await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "rtsp", camera_rtsp_url: "" })).status).toBe(303);
    expect(await row()).toEqual({ camera_source: "rtsp", camera_rtsp_url: rtsp, camera_wyze_name: null });
    expect(await version()).toBe(v0 + 2);

    // switching the source away clears it
    expect((await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "none" })).status).toBe(303);
    expect(await row()).toEqual({ camera_source: "none", camera_rtsp_url: null, camera_wyze_name: null });
    expect(await (await config(dev)).json()).toEqual({ source: "none", version: v0 + 3 });
    expect((await sync(dev)).camera_config_version).toBe(v0 + 3);

    // back to the site default
    expect((await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "" })).status).toBe(303);
    expect((await row()).camera_source).toBeNull();
    expect((await (await config(dev)).json()).source).toBe("wyze");
  });

  it("renders the form (disabled for viewers) with the pattern as placeholder and the source in the summary", async () => {
    let page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain(`action="/devices/${dev.id}/camera-source"`);
    expect(page).toContain('<select name="camera_source" disabled>');
    expect(page).toContain('<option value="" selected>site default (wyze)</option>');
    expect(page).toContain('name="camera_wyze_name" value="" placeholder="Cam cam-a" maxlength="100" disabled>');
    expect(page).toContain('<input type="password" name="camera_rtsp_url" value="" autocomplete="off" placeholder="rtsp://user:pass@10.0.0.5:554/stream" maxlength="2048" disabled>');

    // a stored RTSP URL (credentials) never reaches the page, for any role
    await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "rtsp", camera_rtsp_url: "rtsp://user:s3cret@10.0.0.9:554/s" });
    for (const who of [r.viewer, r.editor, r.admin]) {
      page = await (await who.get("/devices")).text();
      expect(page).toContain('name="camera_rtsp_url" value="" autocomplete="off" placeholder="set (leave empty to keep)"');
      expect(page).not.toContain("s3cret");
      expect(page).not.toContain("10.0.0.9");
    }

    await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "wyze", camera_wyze_name: "<Lobby>" });
    page = await (await r.editor.get("/devices")).text();
    expect(page).toContain("<summary>Camera · wyze</summary>");
    expect(page).toContain('<option value="wyze" selected>wyze</option>');
    expect(page).toContain('name="camera_wyze_name" value="&lt;Lobby&gt;" placeholder="Cam cam-a" maxlength="100">');
    expect(page).not.toContain("<Lobby>");
  });

  it("camera_supported = 0 replaces the source picker with one sentence; 1 or NULL keep it; the API still accepts config", async () => {
    const picker = `action="/devices/${dev.id}/camera-source"`;
    const sentence = '<p class="help small">Camera is not supported on this Pi model.</p>';
    for (const [flag, want] of [[null, true], [1, true], [0, false]]) {
      await query("UPDATE devices SET camera_supported = ? WHERE id = ?", flag, dev.id);
      const page = await (await r.editor.get("/devices")).text();
      expect(page.includes(picker), String(flag)).toBe(want);
      expect(page.includes(sentence), String(flag)).toBe(!want);
      expect(page).toContain(`action="/devices/${dev.id}/camera-url"`); // live URL form stays
    }
    expect((await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "none" })).status).toBe(303);
    await query("UPDATE devices SET camera_supported = NULL WHERE id = ?", dev.id);
  });

  it("clearing the Wyze account: site default becomes none, an explicit wyze device falls back to none, version bumps", async () => {
    const v0 = await version();
    await roleMatrix(r, "POST", "/settings/wyze/clear", { minRole: "admin" });
    expect(await secrets.names(env)).toEqual(new Set());
    expect(await version()).toBe(v0 + 1);
    expect(await audits("wyze_settings_cleared")).toHaveLength(1);
    expect(await (await config(dev)).json()).toEqual({ source: "none", version: v0 + 1 }); // explicit wyze, no account
    expect(await (await config(other)).json()).toEqual({ source: "none", version: v0 + 1 });
    const token = auth.newApiToken();
    const me = await one("SELECT id FROM users WHERE username = 'admin'");
    await query("INSERT INTO api_tokens (user_id, name, token_hash) VALUES (?, 'f2', ?)", me.id, await auth.apiTokenHash(token));
    expect((await (await SELF.fetch(`${BASE}/api/operator/enrollment`, { headers: bearer(token) })).json()).wyze_configured).toBe(false);
    expect(await (await r.admin.get("/settings")).text()).toContain("Status: <strong>not configured</strong>");
    expect(await (await r.admin.get("/devices")).text()).toContain('<option value="">site default (none)</option>'); // dev is explicit wyze
  });
});
