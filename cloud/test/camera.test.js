// Camera feed: POST /api/camera (auth, JPEG magic, 2 MiB cap, last_camera_at + camera_error
// cleared), sync stores camera_error, manifest camera_interval_seconds, migration 0002 columns,
// /devices/:id/camera serving, the Devices / dashboard snapshot markup, the live URL form
// (https validation, audit device_set_camera_url, sandboxed lazy iframe, escaping).
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as media from "../src/media.js";
import { BASE, Client, query } from "./helpers.js";
import { audits, detail, device, one, post, roleMatrix, roles, XSS } from "./pages_common.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const bearer = (token) => ({ authorization: `Bearer ${token}` });

let r;
let dev;
let other;

function postCam(d, bytes, headers = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "image/jpeg" }), `${d.device_id}.jpg`);
  return SELF.fetch(`${BASE}/api/camera/${d.device_id}`, { method: "POST", body: fd, headers: { ...bearer(d.token), ...headers } });
}

function sync(d, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return SELF.fetch(`${BASE}/api/sync/${d.device_id}${qs ? "?" + qs : ""}`, { headers: bearer(d.token) });
}

const row = () => one("SELECT last_camera_at, camera_error, camera_live_url FROM devices WHERE id = ?", dev.id);

beforeAll(async () => {
  r = await roles();
  dev = await device("cam-1", "Cam One");
  other = await device("cam-2", "Cam Two");
});

describe("migration 0002", () => {
  it("adds the three camera columns and bumps schema_version", async () => {
    const cols = (await query("PRAGMA table_info(devices)")).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["last_camera_at", "camera_error", "camera_live_url"]));
    // 0003_automation.sql bumps it further; this only checks 0002 ran
    expect(Number((await one("SELECT value FROM meta WHERE key = 'schema_version'")).value)).toBeGreaterThanOrEqual(2);
  });
});

describe("POST /api/camera", () => {
  it("needs the device's own token", async () => {
    let res = await SELF.fetch(`${BASE}/api/camera/${dev.device_id}`, { method: "POST", body: new FormData() });
    expect(res.status).toBe(401);
    res = await SELF.fetch(`${BASE}/api/camera/${dev.device_id}`, { method: "POST", body: new FormData(), headers: bearer(other.token) });
    expect(res.status).toBe(403);
    res = await r.admin.fetch(`/api/camera/${dev.device_id}`, { method: "POST", body: new FormData() });
    expect(res.status).toBe(401);
  });

  it("must be a multipart JPEG under 2 MiB; stores camera/<id>.jpg, stamps last_camera_at, clears camera_error", async () => {
    await query("UPDATE devices SET camera_error = 'ffmpeg timed out' WHERE id = ?", dev.id);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    let res = await postCam(dev, png);
    expect(await detail(res, 400)).toBe("camera snapshot must be a JPEG image");
    expect(await env.MEDIA.head(media.cameraKey(dev.device_id))).toBeNull();
    expect((await postCam(dev, new Uint8Array(0))).status).toBe(400);
    res = await SELF.fetch(`${BASE}/api/camera/${dev.device_id}`, { method: "POST", body: JPEG, headers: { ...bearer(dev.token), "content-type": "image/jpeg" } });
    expect(await detail(res, 400)).toBe("expected a multipart/form-data upload");
    res = await SELF.fetch(`${BASE}/api/camera/${dev.device_id}`, { method: "POST", body: new FormData(), headers: bearer(dev.token) });
    expect(await detail(res, 400)).toBe("no file in upload (field 'file')");
    res = await postCam(dev, JPEG, { "content-length": String(3 * 1024 * 1024) });
    expect(res.status).toBe(413);
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(JPEG);
    res = await postCam(dev, big);
    expect(await detail(res, 413)).toBe("File exceeds 2097152 bytes");
    expect((await row()).last_camera_at).toBeNull();
    expect((await row()).camera_error).toBe("ffmpeg timed out");

    res = await postCam(dev, JPEG);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, size_bytes: JPEG.length });
    const obj = await env.MEDIA.get("camera/cam-1.jpg");
    expect(new Uint8Array(await obj.arrayBuffer())).toEqual(JPEG);
    expect(obj.httpMetadata.contentType).toBe("image/jpeg");
    const after = await row();
    expect(after.last_camera_at).not.toBeNull();
    expect(after.camera_error).toBeNull();
    // the screenshot slot is untouched
    expect(await env.MEDIA.head(media.screenshotKey(dev.device_id))).toBeNull();
  });
});

describe("sync + manifest", () => {
  it("stores camera_error (trimmed to 200 chars, empty -> NULL) and sends camera_interval_seconds", async () => {
    let res = await sync(dev, { camera_error: " rtsp connect refused " + "x".repeat(300) });
    expect(res.status).toBe(200);
    expect((await res.json()).camera_interval_seconds).toBe(10);
    const err = (await row()).camera_error;
    expect(err.startsWith("rtsp connect refused")).toBe(true);
    expect(err.length).toBe(200);
    res = await sync(dev, { camera_error: "" });
    expect(res.status).toBe(200);
    expect((await row()).camera_error).toBeNull();
    res = await sync(dev, { camera_error: "no camera" });
    expect((await row()).camera_error).toBe("no camera");
    res = await sync(dev); // a player that never sends the field reads as healthy
    expect((await row()).camera_error).toBeNull();

    await query("INSERT INTO settings (key, value) VALUES ('camera_interval', '30')");
    expect((await (await sync(dev)).json()).camera_interval_seconds).toBe(30);
    await query("DELETE FROM settings WHERE key = 'camera_interval'");
  });
});

describe("/devices/:id/camera", () => {
  it("serves image/jpeg no-store nosniff to any session; 303 anonymous; 404 when unset", async () => {
    expect((await new Client().get(`/devices/${dev.id}/camera`)).status).toBe(303);
    expect((await r.viewer.get("/devices/999999/camera")).status).toBe(404);
    expect((await r.viewer.get("/devices/abc/camera")).status).toBe(400);
    expect(await detail(await r.viewer.get(`/devices/${other.id}/camera`), 404)).toBe("no camera snapshot yet");
    const res = await r.viewer.get(`/devices/${dev.id}/camera?t=x`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
  });
});

describe("Devices + dashboard markup", () => {
  it("shows the snapshot with age, STALE after 3 x camera_interval, camera_error in warn style, nothing without a snapshot", async () => {
    await query("UPDATE devices SET last_camera_at = datetime('now', '-8 seconds'), camera_error = NULL WHERE id = ?", dev.id);
    let page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain(`<a href="/devices/${dev.id}/camera?t=`);
    expect(page).toContain(`class="device-thumb" alt="Latest camera snapshot from Cam One">`);
    expect(page).toContain('<div class="device-screen device-camera">');
    expect(page).toContain('<span class="screen-chip tl">cam · 8 s ago</span>');
    expect(page).not.toContain("Camera: ");
    // the other device never sent a snapshot: no camera block at all
    expect(page).not.toContain(`/devices/${other.id}/camera?t=`);

    // stale: 60 s > 3 x 10 s; camera_error shown in the warn style, escaped
    await query("UPDATE devices SET last_camera_at = datetime('now', '-60 seconds'), camera_error = ? WHERE id = ?", `ffmpeg: <${XSS}>`, dev.id);
    page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain('<div class="device-screen device-camera is-stale">');
    expect(page).toContain('<span class="screen-chip tr is-stale badge-stale" title="No new camera snapshot for more than 3 camera intervals">stale</span>');
    expect(page).toContain(`<div class="alert warn small" title="Reported by the player on its last sync">Camera: ffmpeg: &lt;x&#39;);alert(1);//&gt;</div>`);
    expect(page).not.toContain(`<${XSS}>`);
    const dash = await (await r.viewer.get("/dashboard")).text();
    expect(dash).toContain(`<img src="/devices/${dev.id}/camera?t=`);
    expect(dash).toContain('class="device-thumb device-thumb-stale" alt="Latest camera snapshot from Cam One">');
    expect(dash).toContain("Camera: ffmpeg: &lt;x&#39;);alert(1);//&gt;");
    expect(dash).not.toContain(`/devices/${other.id}/camera?t=`);

    // a bigger camera_interval un-stales it
    await query("INSERT INTO settings (key, value) VALUES ('camera_interval', '30')");
    page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain('<div class="device-screen device-camera">');
    await query("DELETE FROM settings WHERE key = 'camera_interval'");
    // camera_error alone (no snapshot ever) still surfaces
    await query("UPDATE devices SET camera_error = 'no camera configured' WHERE id = ?", other.id);
    page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain("Camera: no camera configured");
    await query("UPDATE devices SET camera_error = NULL WHERE id = ?", other.id);
  });
});

describe("camera live URL", () => {
  it("editor+ only; https URLs only; audited; empty clears", async () => {
    await roleMatrix(r, "POST", `/devices/${dev.id}/camera-url`, { fields: { camera_live_url: "https://cam.example.com/lobby" } });
    expect((await row()).camera_live_url).toBe("https://cam.example.com/lobby");
    const [a] = await audits("device_set_camera_url");
    expect(a.username).toBe("ed");
    expect(a.target_id).toBe(String(dev.id));
    expect(JSON.parse(a.details)).toEqual({ camera_live_url: "https://cam.example.com/lobby" });

    for (const bad of ["http://cam.example.com/", "javascript:alert(1)", "cam.example.com", "https://", "https://user:pw@cam.example.com/", "ftp://x/", `https://cam.example.com/${"a".repeat(2100)}`]) {
      expect(await detail(await post(r.admin, `/devices/${dev.id}/camera-url`, { camera_live_url: bad }), 400), bad)
        .toBe("camera_live_url must be an absolute https:// URL");
    }
    expect((await row()).camera_live_url).toBe("https://cam.example.com/lobby");
    expect((await post(r.admin, "/devices/999999/camera-url", { camera_live_url: "https://x.example/" })).status).toBe(404);

    const res = await post(r.admin, `/devices/${dev.id}/camera-url`, { camera_live_url: "   " });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/devices");
    expect((await row()).camera_live_url).toBeNull();
  });

  it("renders the form for editors (disabled for viewers), the Live link and a lazy sandboxed iframe, escaped", async () => {
    let page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain("<summary>Camera</summary>");
    expect(page).toContain(`action="/devices/${dev.id}/camera-url"`);
    expect(page).toContain('name="camera_live_url" value="" placeholder="https://cam-lobby.example.com/" pattern="https://.*" maxlength="2048" disabled>');
    expect(page).not.toContain("data-live-frame");

    const url = `https://cam.example.com/lobby?x=1&name=${encodeURIComponent(XSS)}`;
    await post(r.editor, `/devices/${dev.id}/camera-url`, { camera_live_url: url });
    const stored = (await row()).camera_live_url;
    expect(stored.startsWith("https://cam.example.com/lobby?x=1&name=")).toBe(true);
    page = await (await r.editor.get("/devices")).text();
    const escaped = stored.replaceAll("&", "&amp;");
    expect(page).toContain("<summary>Camera · live URL set</summary>");
    expect(page).toContain(`name="camera_live_url" value="${escaped}" placeholder=`);
    expect(page).not.toContain('maxlength="2048" disabled>');
    expect(page).toContain(`<a href="${escaped}" target="_blank" rel="noopener noreferrer" class="button small">Live</a>`);
    expect(page).toContain(`<button type="button" class="small" data-live-frame="live-frame-${dev.id}">Show live</button>`);
    expect(page).toContain(`<iframe id="live-frame-${dev.id}" class="live-frame" data-src="${escaped}" title="Live camera: Cam One" sandbox="allow-same-origin allow-scripts" referrerpolicy="no-referrer" hidden></iframe>`);
    expect(page).not.toContain(` src="${escaped}"`); // lazy: only data-src until "Show live" is clicked
    expect(page).not.toContain(XSS);

    // a URL that somehow bypassed validation in the row (direct SQL) never becomes an iframe
    await query("UPDATE devices SET camera_live_url = 'javascript:alert(1)' WHERE id = ?", dev.id);
    page = await (await r.editor.get("/devices")).text();
    expect(page).not.toContain("<iframe");
    expect(page).not.toContain("javascript:alert(1)");
    await query("UPDATE devices SET camera_live_url = NULL WHERE id = ?", dev.id);
  });
});

describe("delete", () => {
  it("removes the camera object too", async () => {
    const d = await device("cam-del", "Cam Del");
    await media.putCamera(env, d.device_id, JPEG);
    expect(await env.MEDIA.head(media.cameraKey(d.device_id))).not.toBeNull();
    expect((await post(r.admin, `/devices/${d.id}/delete`)).status).toBe(303);
    expect(await env.MEDIA.head(media.cameraKey(d.device_id))).toBeNull();
  });
});
