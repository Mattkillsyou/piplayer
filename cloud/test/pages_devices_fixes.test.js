// Audit fixes on the Devices page (package pages-devices): device tokens admin-only (H3, in
// pages_devices / roles_csrf), one queued row per command with a banner (M15, M18), flash
// notices for token / delete (M18, L24), camera_supported = 0 never gets the Wyze login (L3)
// and shows a way to clear a stored override (L20), RTSP URLs encrypted at rest (L8), a
// 120-char name cap and rename in place (L14, L22), a player result cannot fake the
// undeliverable badge (L16), "player down" instead of MPV-DOWN (L28), no docs link (L41),
// Settings links only for admins (H6) and a delete that survives R2 trouble (L10 sibling).
// The tunnel rotation on New token / Recreate tunnel (M8) is in tunnel.test.js, next to the fake.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as media from "../src/media.js";
import * as secrets from "../src/secrets.js";
import worker from "../src/index.js";
import { BASE, query } from "./helpers.js";
import { audits, detail, device, NOPE, one, post, roleMatrix, roles } from "./pages_common.js";

let r;
const bearer = (d) => ({ authorization: `Bearer ${d.token}` });
const config = (d) => SELF.fetch(`${BASE}/api/camera-config/${d.device_id}`, { headers: bearer(d) }).then((x) => x.json());
const version = async () => Number((await one("SELECT value FROM settings WHERE key = 'camera_config_version'"))?.value ?? 0);
const banner = async (c, kind) => {
  const page = await (await c.get("/devices")).text();
  const m = new RegExp(`<div class="alert ${kind}" role="alert">([^<]*)</div>`).exec(page);
  return m ? m[1] : null;
};

beforeAll(async () => {
  r = await roles();
});

describe("M15 / M18: per-device commands", () => {
  it("a second click while the first is still waiting queues nothing; both answer with a banner", async () => {
    const dev = await device("dup-1", "Dup <one>");
    let res = await post(r.editor, `/devices/${dev.id}/command`, { command: "reboot" });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/devices"]);
    expect(await banner(r.editor, "ok")).toBe("Reboot queued for Dup &lt;one&gt;; the Pi picks it up on its next check-in.");
    expect(await banner(r.editor, "ok")).toBeNull(); // one-shot
    res = await post(r.editor, `/devices/${dev.id}/command`, { command: "reboot" });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/devices"]);
    expect(await banner(r.editor, "warn")).toBe("Reboot is already waiting for Dup &lt;one&gt;; the Pi picks it up on its next check-in.");
    expect((await post(r.editor, `/devices/${dev.id}/command`, { command: "update-os" })).status).toBe(303);
    expect((await post(r.editor, `/devices/${dev.id}/command`, { command: "update-os" })).status).toBe(303);
    expect(await banner(r.editor, "warn")).toBe("OS update is already waiting for Dup &lt;one&gt;; the Pi picks it up on its next check-in.");
    const rows = await query("SELECT command FROM device_commands WHERE device_id = ? ORDER BY id", dev.id);
    expect(rows.map((x) => x.command)).toEqual(["reboot", "update-os"]);
    expect(await audits("device_send_command")).toHaveLength(2); // the refused clicks are not audited
    // once the player reports, the same command can be queued again; the sync hands out one row per command
    await query("UPDATE device_commands SET completed_at = datetime('now'), result = 'ok' WHERE device_id = ? AND command = 'reboot'", dev.id);
    expect((await post(r.editor, `/devices/${dev.id}/command`, { command: "reboot" })).status).toBe(303);
    expect(await banner(r.editor, "ok")).toContain("Reboot queued");
    const m = await (await SELF.fetch(`${BASE}/api/sync/${dev.device_id}`, { headers: bearer(dev) })).json();
    expect(m.commands.map((c) => c.command).sort()).toEqual(["reboot", "update-os"]);
    expect((await post(r.editor, `/devices/${dev.id}/command`, { command: "ir-learn:power_on" })).status).toBe(303);
    expect(await banner(r.editor, "ok")).toBe("Learn Power On queued for Dup &lt;one&gt;; the Pi picks it up on its next check-in.");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });

  it("the dashboard Reboot tile posts to the same handler and lands on /devices with the banner", async () => {
    const dev = await device("dup-2", "Dup two");
    expect((await post(r.admin, `/devices/${dev.id}/command`, { command: "force-sync" })).headers.get("location")).toBe("/devices");
    expect(await banner(r.admin, "ok")).toBe("Resync queued for Dup two; the Pi picks it up on its next check-in.");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});

describe("M18: New token and Delete acknowledge", () => {
  it("New token banners, lands with that device's Token / install open; delete banners the name", async () => {
    const dev = await device("ack-1", "Ack <dev>");
    const res = await post(r.admin, `/devices/${dev.id}/regen-token`);
    expect([res.status, res.headers.get("location")]).toEqual([303, `/devices?open=${dev.id}`]);
    const page = await (await r.admin.get(`/devices?open=${dev.id}`)).text();
    expect(page).toContain('<div class="alert ok" role="alert">New token made for Ack &lt;dev&gt;: open Token / install and run the install command on the Pi again.</div>');
    const i = page.indexOf(`action="/devices/${dev.id}/regen-token"`);
    expect(page.lastIndexOf("<details open>", i)).toBeGreaterThan(page.lastIndexOf("<details>", i));
    // only that device's block opens; a junk ?open= opens none
    expect(page.match(/<details open>/g)).toHaveLength(1);
    expect(await (await r.admin.get("/devices?open=abc")).text()).not.toContain("<details open>");
    const del = await post(r.editor, `/devices/${dev.id}/delete`);
    expect([del.status, del.headers.get("location")]).toEqual([303, "/devices"]);
    expect(await banner(r.editor, "ok")).toBe("Device Ack &lt;dev&gt; deleted.");
  });

  it("delete survives an R2 failure: row gone, audited, redirected, the failure logged", async () => {
    const dev = await device("ack-2", "Ack two");
    await media.putScreenshot(env, dev.device_id, new Uint8Array([1, 2, 3]));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await worker.fetch(new Request(`${BASE}/devices/${dev.id}/delete`, {
      method: "POST", body: new URLSearchParams({ csrf_token: r.editor.token }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: r.editor.cookie },
    }), { ...env, MEDIA: { delete: async () => { throw new Error("R2 is down"); } } }, createExecutionContext());
    expect([res.status, res.headers.get("location")]).toEqual([303, "/devices"]);
    expect(await one("SELECT id FROM devices WHERE id = ?", dev.id)).toBeNull();
    expect((await audits("device_delete"))[0]).toMatchObject({ target_id: String(dev.id) });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("snapshots of deleted device ack-2 not removed: R2 is down"));
    errors.mockRestore();
    await media.deleteScreenshot(env, dev.device_id);
  });
});

describe("L3 / L20: camera_supported = 0", () => {
  it("the API answers none even with a Wyze account and a stored wyze override; the page offers to clear the override", async () => {
    for (const [k, v] of Object.entries({ wyze_email: "ops@example.com", wyze_password: "hunter2!" })) await secrets.set(env, k, v);
    const dev = await device("zero-1", "Zero");
    await query("UPDATE devices SET camera_supported = 0, camera_source = 'wyze', camera_wyze_name = 'Front door', camera_live_url = 'https://cam.example/', tunnel_hostname = 'zero-1-cam.example' WHERE id = ?", dev.id);
    expect(await config(dev)).toEqual({ source: "none", version: await version() });
    expect(JSON.parse((await audits("camera_config_fetched"))[0].details)).toMatchObject({ device_id: "zero-1", source: "none" });
    let page = await (await r.editor.get("/devices")).text();
    const block = (p) => p.slice(p.indexOf(`<code>zero-1</code>`), p.indexOf(`action="/devices/${dev.id}/projector"`));
    let b = block(page);
    expect(b).toContain("<summary>Camera · not supported</summary>");
    expect(b).toContain('<p class="help small">Camera is not supported on this Pi model.</p>');
    expect(b).toContain("A camera setting (wyze) is still stored from before; it does nothing on this Pi.");
    expect(b).toContain(`<form method="post" action="/devices/${dev.id}/camera-source" class="row">`);
    expect(b).toContain(">Clear camera setting</button>");
    expect(b).not.toContain('<select name="camera_source"');
    expect(b).not.toContain(`action="/devices/${dev.id}/camera-url"`);
    expect(b).not.toContain("live URL set");
    expect(b).not.toContain("tunnel-block");
    expect(b).not.toContain(`live-frame-${dev.id}`);
    // viewers see the button disabled
    expect(block(await (await r.viewer.get("/devices")).text())).toContain('<button type="submit" class="small" disabled>Clear camera setting</button>');
    // clearing goes back to the site default, after which nothing is offered
    expect((await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "" })).status).toBe(303);
    expect(await one("SELECT camera_source, camera_wyze_name FROM devices WHERE id = ?", dev.id)).toEqual({ camera_source: null, camera_wyze_name: null });
    b = block(await (await r.editor.get("/devices")).text());
    expect(b).toContain("<summary>Camera · not supported</summary>");
    expect(b).not.toContain("Clear camera setting");
    expect(await config(dev)).toEqual({ source: "none", version: await version() });
    // a supported board with the same account gets wyze
    await query("UPDATE devices SET camera_supported = 1 WHERE id = ?", dev.id);
    expect((await config(dev)).source).toBe("wyze");
    for (const k of ["wyze_email", "wyze_password"]) await secrets.set(env, k, "");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});

describe("L8: RTSP URLs are stored encrypted", () => {
  it("the row never holds the URL; the API decrypts it; a legacy plaintext row is served until re-saved", async () => {
    const dev = await device("rtsp-1", "Rtsp");
    const url = "rtsp://admin:s3cret@10.0.0.5:554/live";
    expect((await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "rtsp", camera_rtsp_url: url })).status).toBe(303);
    const row = () => one("SELECT camera_rtsp_url FROM devices WHERE id = ?", dev.id);
    expect((await row()).camera_rtsp_url).toMatch(/^v1:/);
    expect((await row()).camera_rtsp_url).not.toContain("s3cret");
    expect(await config(dev)).toEqual({ source: "rtsp", rtsp_url: url, version: await version() });
    // an empty field keeps the stored (encrypted) value; a bad URL is still refused before anything is stored
    const stored = (await row()).camera_rtsp_url;
    expect((await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "rtsp", camera_rtsp_url: "" })).status).toBe(303);
    expect((await row()).camera_rtsp_url).toBe(stored);
    expect(await detail(await post(r.editor, `/devices/${dev.id}/camera-source`, { camera_source: "rtsp", camera_rtsp_url: "http://x/" }), 400)).toBe("camera_rtsp_url must be an rtsp:// or rtsps:// URL");
    // legacy plaintext row (before this fix): served as is
    await query("UPDATE devices SET camera_rtsp_url = 'rtsp://old:pw@10.0.0.6/s' WHERE id = ?", dev.id);
    expect((await config(dev)).rtsp_url).toBe("rtsp://old:pw@10.0.0.6/s");
    // a value encrypted for another device (or tampered) is not served: the source falls back to none
    await query("UPDATE devices SET camera_rtsp_url = ? WHERE id = ?", await secrets.encrypt(env, "rtsp:someone-else", url), dev.id);
    expect((await config(dev)).source).toBe("none");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});

describe("L14 / L22: name cap and rename", () => {
  it("editor+ renames (1-120 chars), bumps camera_config_version only on a change, audits device_rename, banners", async () => {
    const dev = await device("ren-1", "Old name");
    await roleMatrix(r, "POST", `/devices/${dev.id}/rename`, { fields: { name: " New <name> " } });
    expect((await one("SELECT name FROM devices WHERE id = ?", dev.id)).name).toBe("New <name>");
    expect(await banner(r.editor, "ok")).toBe("Renamed to New &lt;name&gt;.");
    expect((await audits("device_rename"))[0]).toMatchObject({ username: "ed", target_id: String(dev.id), details: '{"name": "New <name>"}' });
    const v = await version();
    expect((await post(r.editor, `/devices/${dev.id}/rename`, { name: "New <name>" })).status).toBe(303);
    expect(await version()).toBe(v); // same name: no refetch for the players
    expect((await post(r.editor, `/devices/${dev.id}/rename`, { name: "Changed" })).status).toBe(303);
    expect(await version()).toBe(v + 1); // the Wyze camera name may derive from {device_name}
    expect(await detail(await post(r.editor, `/devices/${dev.id}/rename`, { name: "  " }), 400)).toBe("name must be 1-120 chars");
    expect(await detail(await post(r.editor, `/devices/${dev.id}/rename`, { name: "n".repeat(121) }), 400)).toBe("name must be 1-120 chars");
    expect((await post(r.editor, `/devices/${dev.id}/rename`, { name: "n".repeat(120) })).status).toBe(303);
    expect(await detail(await post(r.editor, `/devices/${NOPE}/rename`, { name: "x" }), 404)).toBe("Device not found");
    expect(await detail(await post(r.editor, "/devices/abc/rename", { name: "x" }), 400)).toContain("device_id");
    const page = await (await r.editor.get("/devices")).text();
    expect(page).toContain(`<form method="post" action="/devices/${dev.id}/rename" class="inline">`);
    expect(page).toContain(`<input type="text" name="name" value="${"n".repeat(120)}" maxlength="120" required aria-label="Device name">`);
    expect(page).toContain('<input type="text" name="name" placeholder="Lobby Projector" maxlength="120" required>'); // Register shares the cap
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});

describe("L16: the undeliverable badge is the console's, never the player's", () => {
  it("a player result beginning with 'undeliverable' renders as an ordinary result", async () => {
    const dev = await device("badge-1", "Badge");
    expect((await post(r.editor, `/devices/${dev.id}/command`, { command: "reboot" })).status).toBe(303);
    const cid = (await one("SELECT id FROM device_commands WHERE device_id = ?", dev.id)).id;
    await SELF.fetch(`${BASE}/api/sync/${dev.device_id}`, { headers: bearer(dev) });
    const res = await SELF.fetch(`${BASE}/api/commands/${cid}/result`, {
      method: "POST", body: JSON.stringify({ result: "undeliverable: haha" }), headers: { "content-type": "application/json", ...bearer(dev) },
    });
    expect(res.status).toBe(200);
    expect(await one("SELECT undeliverable, result FROM device_commands WHERE id = ?", cid)).toEqual({ undeliverable: 0, result: "undeliverable: haha" });
    const page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain("done · undeliverable: haha");
    expect(page).not.toContain('<span class="badge badge-stale">undeliverable: haha</span>');
    // the console's own close (migration 0007 flag) is the badge
    await query("UPDATE device_commands SET undeliverable = 1 WHERE id = ?", cid);
    expect(await (await r.viewer.get("/devices")).text()).toContain('<span class="badge badge-stale">undeliverable: haha</span>');
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});

describe("L28 / L41 / H6: wording and links", () => {
  it("mpv-down reads 'player down' on both pages (class unchanged); no docs path; Settings is a link only for admins", async () => {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const dev = await device("down-1", "Down", { last_seen_at: now, player_status: "mpv-down", current_filename: "clip.mp4" });
    for (const path of ["/devices", "/dashboard"]) {
      const page = await (await r.viewer.get(path)).text();
      expect(page).toContain('<span class="status status-mpv-down"><span class="lamp"></span>player down</span>');
      expect(page).not.toContain(">mpv-down</span>");
    }
    const ed = await (await r.editor.get("/devices")).text();
    expect(ed).toContain('<span class="now-file">#1 clip.mp4 · player down</span>');
    expect(ed).not.toContain("docs/camera.md");
    expect(ed).toContain("Snapshots come from the Pi on their own.</p>");
    expect(ed).not.toContain('href="/settings"');
    expect(ed).toContain("with the account from Settings");
    expect(ed).toContain("(Settings).</p>");
    expect(ed).toContain("Automatic tunnels are not configured (Settings): paste a live URL above.");
    const ad = await (await r.admin.get("/devices")).text();
    expect(ad).toContain('with the account from <a href="/settings">Settings</a>');
    expect(ad).toContain('(<a href="/settings">Settings</a>).</p>');
    expect(ad).toContain('Automatic tunnels are not configured (<a href="/settings">Settings</a>): paste a live URL above.');
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});
