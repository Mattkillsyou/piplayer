// /devices: register (device_id regex), assign, group, regen-token, delete (+ R2 screenshot),
// command, screenshot serving, recent commands, token/install block gated by role.
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

  it("viewer never sees a token or the install command; editor and admin do", async () => {
    const vw = await (await r.viewer.get("/devices")).text();
    expect(vw).toContain("Lobby One");
    expect(vw).not.toContain(w.dev.token);
    expect(vw).not.toContain("DEVICE_TOKEN=");
    expect(vw).not.toContain("Token / install");
    expect(vw).not.toContain("Register a new device");
    expect(vw).not.toContain("Reboot Pi");
    expect(vw).toContain('name="group_id" data-autosubmit disabled');
    expect(vw).toContain('name="playlist_id" data-autosubmit disabled');
    for (const c of [r.editor, r.admin]) {
      const page = await (await c.get("/devices")).text();
      expect(page).toContain(`<code class="token">${w.dev.token}</code>`);
      expect(page).toContain("cd piplayer/player");
      expect(page).toContain(`DEVICE_ID=${w.dev.device_id}`);
      expect(page).toContain(`DEVICE_TOKEN=${w.dev.token}`);
      expect(page).toContain("CMS_URL=http://piplayer.test");
      expect(page).toContain("deploy/install-player.sh");
      expect(page).toContain("CMS_URL is the address your browser is using; edit it if this Pi reaches the CMS another way");
      expect(page).toContain('name="group_id" data-autosubmit>');
      expect(page).not.toContain("onchange");
      expect(page).not.toContain("onsubmit");
    }
  });

  it("PIPLAYER_PUBLIC_BASE_URL overrides CMS_URL and hides the edit-it note", async () => {
    env.PIPLAYER_PUBLIC_BASE_URL = "https://cms.example.com/";
    try {
      const page = await (await r.editor.get("/devices")).text();
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
    expect(page).toContain('data-confirm="Delete device x&#39;);alert(1);//dev?"');
    expect(page).toContain('data-confirm="Reboot x&#39;);alert(1);//dev?"');
    expect(page).toContain("<strong>Default PL</strong>");
    expect(page).toContain("schedule: r");             // the rule wins over the default
    expect(page).toContain(`Schedule (1)</a>`);
    expect(page).toContain("Sync problem: download failed: &lt;b&gt;a.mp4&lt;/b&gt;");
    expect(page).toContain("1 min ago");
    expect(page).toContain("10.0.0.7");
    expect(page).toContain("v1.2.3");
    expect(page).toContain("#3</span>");
    expect(page).toContain("clip.mp4");
    expect(page).toContain(`<option value="${w.gid}" selected>Lobby group</option>`);
    expect(page).toContain(`<option value="${w.pid}" selected>Default PL</option>`);
    expect(page).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    await query("DELETE FROM device_schedules WHERE device_id = ?", w.dev.id);
    const again = await (await r.admin.get("/devices")).text();
    expect(again).toContain("device default");
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
    expect(page).toContain("group: Lobby group");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });

  it("recent commands: last 5 with states, undeliverable badge", async () => {
    const dev = await device("cmd-1", "Cmd");
    for (let i = 0; i < 7; i++) await ins("INSERT INTO device_commands (device_id, command) VALUES (?, 'force-sync')", dev.id);
    const rows = await query("SELECT id FROM device_commands WHERE device_id = ? ORDER BY id", dev.id);
    await query("UPDATE device_commands SET delivered_at = datetime('now'), delivery_count = 2 WHERE id = ?", rows[6].id);
    await query("UPDATE device_commands SET completed_at = datetime('now'), result = 'undeliverable: no result after 5 deliveries', delivery_count = 5 WHERE id = ?", rows[5].id);
    await query("UPDATE device_commands SET completed_at = datetime('now'), result = 'ok <done>' WHERE id = ?", rows[4].id);
    await query("UPDATE device_commands SET completed_at = datetime('now') WHERE id = ?", rows[3].id);
    const page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain("Recent commands");
    expect(page).toContain("delivered ×2, no result yet");
    expect(page).toContain('<span class="badge badge-stale">undeliverable: no result after 5 deliveries</span>');
    expect(page).toContain("done: ok &lt;done&gt;");
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
    expect(await detail(await post(r.editor, "/devices", { device_id: "ok-1", name: "  " }), 400)).toBe("name required");
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
    for (const command of ["reboot", "force-sync", "restart-mpv"]) {
      expect((await post(r.editor, `/devices/${dev.id}/command`, { command })).status).toBe(303);
    }
    const rows = await query("SELECT command, issued_by, completed_at, delivery_count FROM device_commands WHERE device_id = ? ORDER BY id", dev.id);
    expect(rows.map((x) => x.command)).toEqual(["reboot", "force-sync", "restart-mpv"]);
    expect(rows[0].issued_by).toBe((await one("SELECT id FROM users WHERE username = 'ed'")).id);
    expect(rows[0].delivery_count).toBe(0);
    const [a] = await audits("device_send_command");
    expect(JSON.parse(a.details)).toMatchObject({ command: "restart-mpv" });
    expect(typeof JSON.parse(a.details).command_id).toBe("number");
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
    expect(page).toContain("10 min ago");
    expect(page).toContain('title="No new screenshot for more than 3 capture intervals">stale</span>');
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
