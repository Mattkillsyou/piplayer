// /devices: register (device_id regex), assign, group, regen-token, delete (+ R2 screenshot),
// command, screenshot serving, recent commands, token/install block gated by role, remote
// update buttons + fleet "Update all players" + the player's reported update status.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import * as media from "../src/media.js";
import { Client, query } from "./helpers.js";
import { audits, detail, device, group, ins, NOPE, one, playlist, post, roleMatrix, roles, XSS } from "./pages_common.js";

let r;
const w = {};
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

beforeAll(async () => {
  r = await roles();
  w.pid = await playlist("Default PL");
  w.gid = await group("Lobby group");
  w.dev = await device("lobby-1", "Lobby One", { playlist_id: w.pid });
  w.xss = await device("xss-1", XSS + "dev");
});

describe("role matrix", () => {
  it("page for everyone, writes for editor+, screenshot for any session", async () => {
    await roleMatrix(r, "GET", "/devices");
    const scratch = await device("scratch-1", "Scratch");
    await roleMatrix(r, "POST", "/devices", { fields: { device_id: "matrix-1", name: "Matrix" } });
    await roleMatrix(r, "POST", `/devices/${scratch.id}/assign`, { fields: { playlist_id: String(w.pid) } });
    await roleMatrix(r, "POST", `/devices/${scratch.id}/group`, { fields: { group_id: String(w.gid) } });
    await roleMatrix(r, "POST", `/devices/${scratch.id}/regen-token`);
    await roleMatrix(r, "POST", `/devices/${scratch.id}/command`, { fields: { command: "force-sync" } });
    await roleMatrix(r, "POST", `/devices/${scratch.id}/delete`);
    expect(await one("SELECT id FROM devices WHERE id = ?", scratch.id)).toBeNull();
    expect((await new Client().get(`/devices/${w.dev.id}/screenshot`)).status).toBe(303);
    expect((await r.viewer.get(`/devices/${w.dev.id}/screenshot`)).status).toBe(404);
  });

  it("viewer never sees a token or the install command; editor and admin can act, only admin gets the token", async () => {
    const vw = await (await r.viewer.get("/devices")).text();
    expect(vw).toContain("Lobby One");
    expect(vw).not.toContain(w.dev.token);
    expect(vw).not.toContain("DEVICE_TOKEN=");
    expect(vw).not.toContain("Token / install");
    expect(vw).not.toContain('action="/devices" class="head-actions"');
    expect(vw).not.toContain("After registering");
    expect(vw).not.toContain("Reboot Pi");
    expect(vw).not.toContain("New token");
    expect(vw).not.toContain("Delete device");
    expect(vw).not.toContain("Update player");
    expect(vw).not.toContain("Update all players");
    expect(vw).not.toContain(`action="/devices/${w.dev.id}/rename"`);
    expect(vw).toContain('<span class="help small">Viewer access: read-only.</span>');
    expect(vw).toContain('name="group_id" data-autosubmit disabled');
    expect(vw).toContain('name="playlist_id" data-autosubmit disabled');
    // the token reads the Wyze login through /api/camera-config, so editors never see it (H3)
    const ed = await (await r.editor.get("/devices")).text();
    expect(ed).not.toContain(w.dev.token);
    expect(ed).not.toContain("DEVICE_TOKEN=");
    expect(ed).not.toContain("<summary>Token / install</summary>");
    expect(ed).not.toContain("New token");
    expect(ed).toContain('<p class="help small">After registering, an administrator opens "Token / install" on the new device and runs that command on the Pi.</p>');
    expect(ed).toContain("Delete device");
    const ad = await (await r.admin.get("/devices")).text();
    expect(ad).toContain('<p class="help small">After registering, open "Token / install" on the new device and run that command on the Pi.</p>');
    expect(ad).toContain("<summary>Token / install</summary>");
    expect(ad).toContain(`<code class="token">${w.dev.token}</code>`);
    expect(ad).toContain("cd piplayer/player");
    expect(ad).toContain(`DEVICE_ID=${w.dev.device_id}`);
    expect(ad).toContain(`DEVICE_TOKEN=${w.dev.token}`);
    expect(ad).toContain("CMS_URL=http://piplayer.test");
    expect(ad).toContain("deploy/install-player.sh");
    expect(ad).toContain("CMS_URL is the address your browser is using; edit it if this Pi reaches the CMS another way");
    expect(ad).toContain(">New token</button>");
    for (const c of [r.editor, r.admin]) {
      const page = await (await c.get("/devices")).text();
      expect(page).toContain('<form method="post" action="/devices" class="head-actions">');
      expect(page).toContain('<button type="submit" class="primary">Register</button>');
      expect(page).not.toContain("Viewer access: read-only.");
      expect(page).toContain(`<form method="post" action="/devices/${w.dev.id}/rename" class="inline">`);
      expect(page).toContain('name="name" value="Lobby One" maxlength="120" required');
      expect(page).toContain("Delete device");
      expect(page).toContain('<button type="submit" class="small primary" title="Tell the Pi to re-sync from the CMS now">Resync</button>');
      expect(page).toContain('<button type="submit" class="small danger">Reboot Pi</button>');
      for (const cmd of ["update-player", "update-os", "update-all"]) expect(page).toContain(`<input type="hidden" name="command" value="${cmd}">`);
      expect(page).toContain(">Update player</button>");
      expect(page).toContain(">Update OS</button>");
      expect(page).toContain(">Update all</button>");
      expect(page).toContain('<form method="post" action="/devices/update-all" class="head-actions" data-confirm="Queue a player software update (release main) on every device? Playback restarts on each Pi.">');
      expect(page).toContain(">Update all players</button>");
      expect(page).toContain('name="group_id" data-autosubmit>');
      expect(page).not.toContain("onchange");
      expect(page).not.toContain("onsubmit");
    }
  });

  it("PIPLAYER_PUBLIC_BASE_URL overrides CMS_URL and hides the edit-it note", async () => {
    env.PIPLAYER_PUBLIC_BASE_URL = "https://cms.example.com/";
    try {
      const page = await (await r.admin.get("/devices")).text();
      expect(page).toContain("CMS_URL=https://cms.example.com \\");
      expect(page).not.toContain("CMS_URL=http://piplayer.test");
      expect(page).not.toContain("CMS_URL is the address your browser is using");
      expect(page).toContain(`DEVICE_TOKEN=${w.dev.token}`);
    } finally {
      delete env.PIPLAYER_PUBLIC_BASE_URL;
    }
  });
});

describe("page content", () => {
  it("escapes names in data-confirm, shows active playlist, group, schedule count, last_error", async () => {
    await query("UPDATE devices SET group_id = ?, last_error = ?, last_seen_at = datetime('now', '-90 seconds'), last_ip = '10.0.0.7', player_version = '1.2.3', current_position = 2, current_filename = 'clip.mp4', player_status = 'playing' WHERE id = ?",
      w.gid, "download failed: <b>a.mp4</b>", w.dev.id);
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'r', 1)", w.dev.id, w.pid);
    const page = await (await r.admin.get("/devices")).text();
    expect(page).not.toContain(XSS);
    expect(page).toContain('data-confirm="Delete device x&#39;);alert(1);//dev? Its schedule');
    expect(page).toContain('data-confirm="Reboot x&#39;);alert(1);//dev?"');
    expect(page).toContain('data-confirm="Update the player software on x&#39;);alert(1);//dev? Playback restarts."');
    expect(page).toContain('<span class="now-label">active now · via schedule: r</span>');   // the rule wins over the default
    expect(page).toContain('<span class="now-playlist">Default PL</span>');
    expect(page).toContain(`<a href="/devices/${w.dev.id}/schedule" class="button">Schedule (1)</a>`);
    expect(page).toContain('<div class="alert error" title="Reported by the player on its last sync">Sync problem: download failed: &lt;b&gt;a.mp4&lt;/b&gt;</div>');
    expect(page).toContain('<span class="label">last seen</span><span class="value">1 min ago<br>');
    expect(page).toContain('<span class="label">ip</span><span class="value">10.0.0.7</span>');
    expect(page).toContain('<span class="label">agent</span><span class="value">v1.2.3</span>');
    expect(page).toContain('<span class="now-file">#3 clip.mp4 · playing</span>');
    expect(page).toContain('<span class="status status-playing"><span class="lamp"></span>playing</span>');
    expect(page).toContain('<div class="device-row">');
    // the never-synced XSS device is offline, so a fault row with the NO SIGNAL thumb
    expect(page).toContain('<div class="device-row is-fault">');
    expect(page).toContain('<span class="status status-offline"><span class="lamp"></span>offline</span>');
    expect(page).toContain('<span class="empty-sub">no screenshot yet</span>');
    expect(page).not.toContain("device-camera"); // no camera snapshot yet: no camera thumb
    expect(page).toContain("<summary>Camera</summary>"); // but the live URL form is always there
    expect(page).toContain('<span class="value">never</span>');
    expect(page).toContain('<span class="value">—</span>');
    expect(page).toContain('<span class="device-id"><code>lobby-1</code> · Lobby group</span>'); // no pi_model yet: nothing appended
    expect(page).toContain(`<option value="${w.gid}" selected>Lobby group</option>`);
    expect(page).toContain(`<option value="${w.pid}" selected>Default PL</option>`);
    expect(page).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    await query("DELETE FROM device_schedules WHERE device_id = ?", w.dev.id);
    const again = await (await r.admin.get("/devices")).text();
    expect(again).toContain('<span class="now-label">active now · via device default</span>');
  });

  it("shows the reported Pi model in the id line, escaped", async () => {
    await query("UPDATE devices SET pi_model = ? WHERE id = ?", "Raspberry Pi 4 Model B Rev 1.5 <b>", w.dev.id);
    const page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain('<span class="device-id"><code>lobby-1</code> · Lobby group · Raspberry Pi 4 Model B Rev 1.5 &lt;b&gt;</span>');
    await query("UPDATE devices SET pi_model = NULL WHERE id = ?", w.dev.id);
  });

  it("a malformed stored schedule row never 500s the page", async () => {
    const dev = await device("bad-rule", "Bad rule", { playlist_id: w.pid });
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_time, end_time) VALUES (?, ?, 'bad', 5, '25:99', 'junk')", dev.id, w.pid);
    const res = await r.admin.get("/devices");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Bad rule");
    expect((await r.admin.get(`/devices/${dev.id}/schedule`)).status).toBe(200);
    expect((await r.admin.get("/dashboard")).status).toBe(200);
  });

  it("group fallback when the device has no default", async () => {
    const gpl = await playlist("Group PL");
    await query("UPDATE device_groups SET playlist_id = ? WHERE id = ?", gpl, w.gid);
    const dev = await device("grouped", "Grouped", { group_id: w.gid });
    const page = await (await r.admin.get("/devices")).text();
    expect(page).toContain('<span class="now-label">active now · via group: Lobby group</span>');
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });

  it("recent commands: last 5 with states, undeliverable badge", async () => {
    const dev = await device("cmd-1", "Cmd");
    for (let i = 0; i < 7; i++) await ins("INSERT INTO device_commands (device_id, command) VALUES (?, 'force-sync')", dev.id);
    const rows = await query("SELECT id FROM device_commands WHERE device_id = ? ORDER BY id", dev.id);
    await query("UPDATE device_commands SET delivered_at = datetime('now'), delivery_count = 2 WHERE id = ?", rows[6].id);
    await query("UPDATE device_commands SET completed_at = datetime('now'), result = 'undeliverable: no result after 5 deliveries', delivery_count = 5, undeliverable = 1 WHERE id = ?", rows[5].id);
    await query("UPDATE device_commands SET completed_at = datetime('now'), result = 'ok <done>' WHERE id = ?", rows[4].id);
    await query("UPDATE device_commands SET completed_at = datetime('now') WHERE id = ?", rows[3].id);
    const page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain("<summary>Recent commands (5)</summary>");
    expect(page).toContain("delivered ×2, no result yet");
    expect(page).toContain('<span class="badge badge-stale">undeliverable: no result after 5 deliveries</span>');
    expect(page).toContain("done · ok &lt;done&gt;");
    expect(page).toContain("<code>force-sync</code> →");
    expect((page.match(/<li>/g) || []).length).toBe(5);
    expect(page).toContain("queued");
  });
});

describe("register", () => {
  it("validates device_id and name, lowercases, 409 on duplicate, audits", async () => {
    expect(await detail(await post(r.editor, "/devices", { device_id: "Bad_ID!", name: "x" }), 400))
      .toBe("device_id must be lowercase alphanumeric + hyphens, 1-63 chars");
    expect(await detail(await post(r.editor, "/devices", { device_id: "-lead", name: "x" }), 400)).toContain("device_id");
    expect(await detail(await post(r.editor, "/devices", { device_id: "a".repeat(64), name: "x" }), 400)).toContain("device_id");
    expect(await detail(await post(r.editor, "/devices", { device_id: "ok-1", name: "  " }), 400)).toBe("name must be 1-120 chars");
    expect(await detail(await post(r.editor, "/devices", { device_id: "ok-1", name: "n".repeat(121) }), 400)).toBe("name must be 1-120 chars");
    expect(await one("SELECT id FROM devices WHERE device_id = 'ok-1'")).toBeNull();
    let res = await post(r.editor, "/devices", { device_id: "  NEW-Pi ", name: " New Pi " });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/devices");
    const row = await one("SELECT device_id, name, token FROM devices WHERE device_id = 'new-pi'");
    expect(row.name).toBe("New Pi");
    expect(row.token.length).toBeGreaterThanOrEqual(32);
    res = await post(r.editor, "/devices", { device_id: "new-pi", name: "again" });
    expect(await detail(res, 409)).toBe("A device with that device_id already exists");
    expect((await audits("register_device"))[0]).toMatchObject({ username: "ed", target_type: "device", details: '{"device_id": "new-pi", "name": "New Pi"}' });
  });
});

describe("assign / group / token / command / delete", () => {
  it("assign: 400 non-int, 404 missing playlist or device, clearing allowed, audits", async () => {
    const dev = await device("asg-1", "Asg", { playlist_id: w.pid });
    for (const bad of ["abc", "1.5", "1e3"]) {
      expect(await detail(await post(r.editor, `/devices/${dev.id}/assign`, { playlist_id: bad }), 400)).toBe("playlist_id must be an integer");
    }
    expect(await detail(await post(r.editor, `/devices/${dev.id}/assign`, { playlist_id: String(NOPE) }), 404)).toBe("Playlist not found");
    expect(await detail(await post(r.editor, `/devices/${NOPE}/assign`, { playlist_id: String(w.pid) }), 404)).toBe("Device not found");
    expect((await one("SELECT playlist_id FROM devices WHERE id = ?", dev.id)).playlist_id).toBe(w.pid);
    expect((await post(r.editor, `/devices/${dev.id}/assign`, { playlist_id: "" })).status).toBe(303);
    expect((await one("SELECT playlist_id FROM devices WHERE id = ?", dev.id)).playlist_id).toBeNull();
    expect((await audits("device_assign_playlist"))[0]).toMatchObject({ target_id: String(dev.id), details: '{"playlist_id": null}' });
  });

  it("group: 400/404, then set", async () => {
    const dev = await device("grp-1", "Grp");
    expect(await detail(await post(r.editor, `/devices/${dev.id}/group`, { group_id: "abc" }), 400)).toBe("group_id must be an integer");
    expect(await detail(await post(r.editor, `/devices/${dev.id}/group`, { group_id: String(NOPE) }), 404)).toBe("Group not found");
    expect(await detail(await post(r.editor, `/devices/${NOPE}/group`, { group_id: String(w.gid) }), 404)).toBe("Device not found");
    expect((await post(r.editor, `/devices/${dev.id}/group`, { group_id: String(w.gid) })).status).toBe(303);
    expect((await one("SELECT group_id FROM devices WHERE id = ?", dev.id)).group_id).toBe(w.gid);
    expect((await audits("device_set_group"))[0].details).toBe(`{"group_id": ${w.gid}}`);
  });

  it("regen-token changes the token; 404 for unknown", async () => {
    const dev = await device("tok-1", "Tok");
    expect((await post(r.editor, `/devices/${NOPE}/regen-token`)).status).toBe(404);
    expect((await post(r.editor, `/devices/${dev.id}/regen-token`)).status).toBe(303);
    const row = await one("SELECT token FROM devices WHERE id = ?", dev.id);
    expect(row.token).not.toBe(dev.token);
    expect((await audits("device_regen_token"))[0].target_id).toBe(String(dev.id));
  });

  it("command: 400 unknown, 404 device, inserts with issued_by and audits", async () => {
    const dev = await device("cmd-2", "Cmd2");
    expect(await detail(await post(r.editor, `/devices/${NOPE}/command`, { command: "reboot" }), 404)).toBe("Device not found");
    expect(await detail(await post(r.editor, `/devices/${dev.id}/command`, { command: "rm-rf" }), 400)).toBe("unknown command");
    expect(await query("SELECT id FROM device_commands WHERE device_id = ?", dev.id)).toEqual([]);
    for (const command of ["reboot", "force-sync", "restart-mpv", "update-player", "update-os", "update-all"]) {
      expect((await post(r.editor, `/devices/${dev.id}/command`, { command })).status).toBe(303);
    }
    const rows = await query("SELECT command, issued_by, completed_at, delivery_count FROM device_commands WHERE device_id = ? ORDER BY id", dev.id);
    expect(rows.map((x) => x.command)).toEqual(["reboot", "force-sync", "restart-mpv", "update-player", "update-os", "update-all"]);
    expect(rows[0].issued_by).toBe((await one("SELECT id FROM users WHERE username = 'ed'")).id);
    expect(rows[0].delivery_count).toBe(0);
    const [a] = await audits("device_send_command");
    expect(JSON.parse(a.details)).toMatchObject({ command: "update-all" });
    expect(typeof JSON.parse(a.details).command_id).toBe("number");
    await query("DELETE FROM device_commands WHERE device_id = ?", dev.id);
  });

  it("delete removes the row, its screenshot in R2, audits; 404 for unknown", async () => {
    const dev = await device("del-1", "Del <me>");
    await media.putScreenshot(env, dev.device_id, JPEG);
    await query("UPDATE devices SET last_screenshot_at = datetime('now') WHERE id = ?", dev.id);
    await ins("INSERT INTO device_commands (device_id, command) VALUES (?, 'reboot')", dev.id);
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name) VALUES (?, ?, 'r')", dev.id, w.pid);
    expect((await r.admin.get(`/devices/${dev.id}/screenshot`)).status).toBe(200);
    expect((await post(r.editor, `/devices/${NOPE}/delete`)).status).toBe(404);
    const res = await post(r.editor, `/devices/${dev.id}/delete`);
    expect(res.status).toBe(303);
    expect(await one("SELECT id FROM devices WHERE id = ?", dev.id)).toBeNull();
    expect(await query("SELECT id FROM device_commands WHERE device_id = ?", dev.id)).toEqual([]);
    expect(await query("SELECT id FROM device_schedules WHERE device_id = ?", dev.id)).toEqual([]);
    expect(await env.MEDIA.head(media.screenshotKey(dev.device_id))).toBeNull();
    expect((await audits("device_delete"))[0]).toMatchObject({ target_id: String(dev.id), details: `{"device_id": "del-1", "name": "Del <me>"}` });
  });
});

describe("screenshot", () => {
  it("serves image/jpeg with no-store + nosniff to any session; 404s otherwise", async () => {
    const dev = await device("shot-1", "Shot");
    expect((await r.viewer.get(`/devices/${NOPE}/screenshot`)).status).toBe(404);
    expect((await r.viewer.get("/devices/abc/screenshot")).status).toBe(400);
    let res = await r.viewer.get(`/devices/${dev.id}/screenshot`);
    expect(await detail(res, 404)).toBe("no screenshot yet");
    await media.putScreenshot(env, dev.device_id, JPEG);
    await query("UPDATE devices SET last_screenshot_at = datetime('now', '-10 minutes') WHERE id = ?", dev.id);
    res = await r.viewer.get(`/devices/${dev.id}/screenshot?t=x`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
    // stale badge: 10 min > 3 x 60 s
    const page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain(`/devices/${dev.id}/screenshot?t=`);
    expect(page).toContain(`<a href="/devices/${dev.id}/screenshot?t=`);
    expect(page).toContain('<span class="screen-chip tl">10 min ago</span>');
    expect(page).toContain('<div class="device-screen is-stale">');
    expect(page).toContain('<span class="screen-chip tr is-stale badge-stale" title="No new screenshot for more than 3 capture intervals">stale</span>');
    await query("UPDATE devices SET last_screenshot_at = datetime('now') WHERE id = ?", dev.id);
    const fresh = await (await r.viewer.get("/devices")).text();
    expect(fresh).toContain('<span class="screen-chip tr">live</span>');
  });
});

describe("query budget", () => {
  it("decorateDevices resolves a fleet with 3 statements, agreeing with the per-device resolver", async () => {
    const { decorateDevices } = await import("../src/pages/devices.js");
    const manifest = await import("../src/manifest.js");
    const { loadSettings } = await import("../src/db.js");
    const gpl = await playlist("Budget group PL");
    const spl = await playlist("Budget sched PL");
    const gid = await group("Budget group");
    await query("UPDATE device_groups SET playlist_id = ? WHERE id = ?", gpl, gid);
    const devs = [];
    for (let i = 0; i < 12; i++) {
      devs.push(await device(`budget-${i}`, `Budget ${i}`, i % 3 === 0 ? { playlist_id: w.pid } : i % 3 === 1 ? { group_id: gid } : {}));
    }
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'always', 1)", devs[2].id, spl);
    let statements = 0;
    const counting = { ...env, DB: new Proxy(env.DB, { get: (t, k) => (k === "prepare" ? (...a) => (statements++, t.prepare(...a)) : t[k]) }) };
    const settings = await loadSettings(env);
    const rows = await query(
      `SELECT d.id, d.playlist_id, d.group_id, g.name AS group_name FROM devices d
         LEFT JOIN device_groups g ON g.id = d.group_id WHERE d.device_id LIKE 'budget-%' ORDER BY d.id`);
    await decorateDevices(counting, rows, settings);
    expect(statements).toBe(3);
    const wall = (await import("../src/util.js")).wallClock(settings.timezone, new Date());
    for (const row of rows) {
      const [pid] = await manifest.resolve_active_playlist_id(env, row, wall);
      expect(row.active_playlist_id).toBe(pid);
    }
    expect(rows[0].active_source).toBe("device default");
    expect(rows[1].active_source).toBe("group: Budget group");
    expect(rows[2].active_source).toBe("schedule: always");
    expect(rows[2].active_playlist_name).toBe("Budget sched PL");
    expect(rows[5].active_playlist_id).toBeNull();
    for (const d of devs) await query("DELETE FROM devices WHERE id = ?", d.id);
  });
});

describe("remote updates", () => {
  it("shows the player's last update report: ok as a muted line, a failure as an error box", async () => {
    const dev = await device("upd-1", "Upd <one>");
    let page = await (await r.viewer.get("/devices")).text();
    expect(page).not.toContain("update-status");
    await query("UPDATE devices SET last_update_at = datetime('now', '-3 hours'), last_update_ok = 1, last_update_message = 'already at abc123', last_update_ref = 'v1.4.0' WHERE id = ?", dev.id);
    page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain('<p class="update-status muted small" title="Reported by the player after its last update">Update ok <code>v1.4.0</code> · 3 h ago · ');
    expect(page).toContain(" UTC: already at abc123</p>");
    expect(page).not.toContain("Update failed");
    await query("UPDATE devices SET last_update_at = datetime('now', '-90 seconds'), last_update_ok = 0, last_update_message = 'install-player.sh exited 1: <pip>', last_update_ref = NULL WHERE id = ?", dev.id);
    page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain('<div class="alert error update-status" title="Reported by the player after its last update">Update failed · 1 min ago · ');
    expect(page).toContain(" UTC: install-player.sh exited 1: &lt;pip&gt;</div>");
    expect(page).not.toContain("<code></code>");
    // a failed update is a fault even when the player is online and playing
    await query("UPDATE devices SET last_seen_at = datetime('now'), player_status = 'playing' WHERE id = ?", dev.id);
    page = await (await r.viewer.get("/devices")).text();
    const faults = (p) => (p.match(/<div class="device-row is-fault">/g) || []).length;
    const failed = faults(page);
    expect(page).toContain('<span class="status status-playing"><span class="lamp"></span>playing</span>');
    await query("UPDATE devices SET last_update_ok = 1 WHERE id = ?", dev.id);
    page = await (await r.viewer.get("/devices")).text();
    expect(faults(page)).toBe(failed - 1);
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });

  it("Update all players queues one command per device, skips devices already waiting, audits, banners", async () => {
    await query("DELETE FROM device_commands");
    const before = (await query("SELECT COUNT(*) AS n FROM devices"))[0].n;
    expect(before).toBeGreaterThan(1);
    expect(await detail(await post(r.editor, "/devices/update-all", { command: "reboot" }), 400)).toBe("unknown command");
    expect(await query("SELECT id FROM device_commands")).toEqual([]);
    await roleMatrix(r, "POST", "/devices/update-all", { fields: { command: "update-player" } });
    let rows = await query("SELECT device_id, command, issued_by, completed_at FROM device_commands ORDER BY device_id");
    expect(rows.length).toBe(before);
    expect(new Set(rows.map((x) => x.command))).toEqual(new Set(["update-player"]));
    expect(rows[0].issued_by).toBe((await one("SELECT id FROM users WHERE username = 'ed'")).id);
    const [a] = await audits("device_update_all");
    expect(a).toMatchObject({ username: "ed", target_type: "device", target_id: null, details: `{"command": "update-player", "queued": ${before}}` });
    // a second click while every device still waits queues nothing; once one device reports, only it gets a new one
    // (the banner is a one-shot flash cookie the test client carries to the next page)
    let res = await post(r.editor, "/devices/update-all", { command: "update-player" });
    expect(res.headers.get("location")).toBe("/devices");
    expect(await (await r.editor.get("/devices")).text())
      .toContain('<div class="alert warn" role="alert">Nothing new to queue: every device already has this update waiting. It runs when each Pi next checks in.</div>');
    expect(await (await r.editor.get("/devices")).text()).not.toContain("Nothing new to queue");
    expect((await query("SELECT COUNT(*) AS n FROM device_commands"))[0].n).toBe(before);
    await query("UPDATE device_commands SET completed_at = datetime('now'), result = 'ok' WHERE device_id = ?", w.dev.id);
    res = await post(r.editor, "/devices/update-all", { command: "update-player" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/devices");
    expect(await (await r.editor.get("/devices")).text()).toContain('<div class="alert ok" role="alert">Update queued for 1 device.</div>');
    rows = await query("SELECT id FROM device_commands WHERE device_id = ? AND completed_at IS NULL", w.dev.id);
    expect(rows.length).toBe(1);
    // the other fleet commands are allowed too; the banner counts what was queued
    res = await post(r.editor, "/devices/update-all", { command: "update-os" });
    expect(res.headers.get("location")).toBe("/devices");
    const page = await (await r.editor.get("/devices")).text();
    expect(page).toContain(`<div class="alert ok" role="alert">Update queued for ${before} devices.</div>`);
    expect((await post(r.editor, "/devices/update-all", { command: "update-all" })).status).toBe(303);
    await query("DELETE FROM device_commands");
  });
});

// E: the Projector block: control / mode / RM4 host form, On / Off and Learn buttons, learned
// badges, the state lamp + error the player reported, and the commands they queue.
describe("projector", () => {
  it("renders the block per control, badges learned codes, shows state, error and what auto mode wants", async () => {
    const dev = await device("proj-1", "Proj <one>");
    let page = await (await r.editor.get("/devices")).text();
    const block = (p) => {
      const i = p.indexOf(`action="/devices/${dev.id}/projector"`);
      return p.slice(p.lastIndexOf('<details class="projector-block">', i), p.indexOf("</details>", i));
    };
    let b = block(page);
    expect(b).toContain("<summary>Projector</summary>");
    expect(b).toContain('<span class="status status-idle projector-state" title="Reported by the player on its last sync"><span class="lamp"></span>projector unknown</span>');
    expect(b).toContain('<option value="none" selected>none</option>');
    expect(b).toContain('<option value="manual" selected>manual</option>');
    expect(b).not.toContain("projector-on");
    expect(b).not.toContain("ir-learn:");
    expect(b).not.toContain("wants ");
    // broadlink + auto: On/Off, three Learn buttons, badges, the want hint; no default playlist -> off
    await query(`UPDATE devices SET projector_control = 'broadlink', projector_power_mode = 'auto', broadlink_host = 'rm4.lan',
                   projector_ir_codes = '{"power_on":"JgBIAAABKZMTEhMSExITEhM3EzcTNxM3Ew=="}', projector_power_state = 'on', projector_error = 'send failed: <timeout>' WHERE id = ?`, dev.id);
    page = await (await r.editor.get("/devices")).text();
    b = block(page);
    expect(b).toContain("<summary>Projector · broadlink · auto · error</summary>");
    expect(b).toContain('<span class="status status-playing projector-state" title="Reported by the player on its last sync"><span class="lamp"></span>projector on</span>');
    expect(b).toContain(">wants off</span>");
    expect(b).toContain("Projector: send failed: &lt;timeout&gt;</div>");
    expect(b).toContain('<option value="broadlink" selected>broadlink</option>');
    expect(b).toContain('<option value="auto" selected>auto</option>');
    expect(b).toContain('name="broadlink_host" value="rm4.lan"');
    expect(b).toContain('<input type="hidden" name="command" value="projector-on">');
    expect(b).toContain('<input type="hidden" name="command" value="projector-off">');
    for (const n of ["power_on", "power_off", "input_hdmi1"]) expect(b).toContain(`<input type="hidden" name="command" value="ir-learn:${n}">`);
    expect(b).toContain('<span class="badge badge-active" title="Learned">Power On</span>');
    expect(b).toContain('<span class="badge badge-muted" title="Not learned yet">Power Off</span>');
    expect(b).toContain('<span class="badge badge-muted" title="Not learned yet">Input HDMI1</span>');
    expect(b).toContain("learn mode for 30 s");
    // a default playlist makes auto mode want it on; cec has no IR codes or Learn buttons; off state
    await query("UPDATE devices SET projector_control = 'cec', playlist_id = ?, projector_power_state = 'off', projector_error = NULL WHERE id = ?", w.pid, dev.id);
    page = await (await r.editor.get("/devices")).text();
    b = block(page);
    expect(b).toContain("<summary>Projector · cec · auto</summary>");
    expect(b).toContain(">wants on</span>");
    expect(b).toContain("projector off</span>");
    expect(b).toContain('value="projector-on"');
    expect(b).not.toContain("ir-learn:");
    expect(b).not.toContain("badge-muted");
    // viewers see the state and the disabled form, no buttons
    page = await (await r.viewer.get("/devices")).text();
    b = block(page);
    expect(b).toContain("projector off</span>");
    expect(b).toContain('<select name="projector_control" disabled>');
    expect(b).not.toContain('value="projector-on"');
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });

  it("projector form: validates control / mode / host, saves, audits; editor+; 404 unknown device", async () => {
    const dev = await device("proj-2", "Proj two");
    const p = `/devices/${dev.id}/projector`;
    await roleMatrix(r, "POST", p, { fields: { projector_control: "cec", projector_power_mode: "auto" } });
    expect(await one("SELECT projector_control, projector_power_mode, broadlink_host FROM devices WHERE id = ?", dev.id))
      .toEqual({ projector_control: "cec", projector_power_mode: "auto", broadlink_host: null });
    expect(await detail(await post(r.editor, p, { projector_control: "zigbee" }), 400)).toBe("projector_control must be one of none, broadlink, cec");
    expect(await detail(await post(r.editor, p, { projector_control: "cec", projector_power_mode: "sometimes" }), 400)).toBe("projector_power_mode must be one of manual, auto");
    expect(await detail(await post(r.editor, p, { projector_control: "broadlink", broadlink_host: "http://rm4" }), 400)).toBe("broadlink_host must be a hostname or IP address");
    expect(await detail(await post(r.editor, `/devices/${NOPE}/projector`, { projector_control: "cec" }), 404)).toBe("Device not found");
    const res = await post(r.editor, p, { projector_control: "broadlink", projector_power_mode: "manual", broadlink_host: " 192.168.1.40 " });
    expect(res.status).toBe(303);
    expect(await one("SELECT projector_control, projector_power_mode, broadlink_host FROM devices WHERE id = ?", dev.id))
      .toEqual({ projector_control: "broadlink", projector_power_mode: "manual", broadlink_host: "192.168.1.40" });
    const [a] = await audits("device_set_projector");
    expect(a).toMatchObject({ username: "ed", target_type: "device", target_id: String(dev.id) });
    expect(JSON.parse(a.details)).toEqual({ projector_control: "broadlink", projector_power_mode: "manual", broadlink_host: "192.168.1.40" });
    // empty fields fall back to none / manual and clear the host
    expect((await post(r.editor, p, {})).status).toBe(303);
    expect(await one("SELECT projector_control, projector_power_mode, broadlink_host FROM devices WHERE id = ?", dev.id))
      .toEqual({ projector_control: "none", projector_power_mode: "manual", broadlink_host: null });
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });

  it("command: projector-on / projector-off / ir-learn:<known name> are queued, other ir-learn names are 400", async () => {
    const dev = await device("proj-3", "Proj three");
    for (const command of ["projector-on", "projector-off", "ir-learn:power_on", "ir-learn:power_off", "ir-learn:input_hdmi1"]) {
      expect((await post(r.editor, `/devices/${dev.id}/command`, { command })).status, command).toBe(303);
    }
    for (const command of ["ir-learn:volume_up", "ir-learn:", "ir-learn", "projector-toggle"]) {
      expect(await detail(await post(r.editor, `/devices/${dev.id}/command`, { command }), 400)).toBe("unknown command");
    }
    const rows = await query("SELECT command FROM device_commands WHERE device_id = ? ORDER BY id", dev.id);
    expect(rows.map((x) => x.command)).toEqual(["projector-on", "projector-off", "ir-learn:power_on", "ir-learn:power_off", "ir-learn:input_hdmi1"]);
    await query("DELETE FROM device_commands WHERE device_id = ?", dev.id);
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});
