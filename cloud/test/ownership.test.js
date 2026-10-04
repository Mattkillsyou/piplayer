// Projector ownership (migration 0009, devices.owner_id; accounts since 0016): editors and viewers
// see only the projectors they own; the Devices page shows admins every one, while their Dashboard
// and Alerts are their own projectors' like anyone's. Per page visibility, the 404 on another
// account's device for every per-device route, what an admin may do to another account's
// projector (device controls yes; what it plays and its token no: 403), the Owner select with the
// cleanup it does (a projector never keeps another account's playlist, group or schedule rules),
// the Add device owner rule, the Users page count and the empty states that point at the SD
// Flasher. Each projector plays its own account's content: mine-1 the editor's, theirs-1 the
// viewer's, nobody-1 (no owner) the site admin's.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BASE, query } from "./helpers.js";
import { audits, defaultPlaylistOf, detail, device, group, ins, NOPE, one, playlist, post, roles } from "./pages_common.js";

let r;
const w = {};

beforeAll(async () => {
  r = await roles();
  w.pid = await playlist("Mine PL"); // the editor's (pages_common defaults)
  w.gid = await group("Mine group");
  w.theirPid = await playlist("Their PL", r.ids.viewer);
  w.theirGid = await group("Their group", r.ids.viewer);
  w.adminPid = await playlist("Admin PL", r.ids.admin);
  w.adminGid = await group("Admin group", r.ids.admin);
  w.mine = await device("mine-1", "Mine One", { playlist_id: w.pid, group_id: w.gid });
  w.theirs = await device("theirs-1", "Theirs One", { playlist_id: w.theirPid, group_id: w.theirGid, owner_id: r.ids.viewer });
  w.nobody = await device("nobody-1", "Nobody One", { playlist_id: w.adminPid, group_id: w.adminGid, owner_id: null });
  for (const [d, pid] of [[w.mine, w.pid], [w.theirs, w.theirPid], [w.nobody, w.adminPid]]) {
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'r', 1)", d.id, pid);
    await ins("INSERT INTO alerts (device_id, kind, opened_at) VALUES (?, 'offline', '2026-09-16 09:00:00')", d.id);
  }
});

describe("visibility", () => {
  it("Devices: the editor sees only its own projector, the admin all three with the owner; Dashboards are each account's own", async () => {
    for (const path of ["/devices", "/dashboard"]) {
      const ed = await (await r.editor.get(path)).text();
      expect(ed).toContain("Mine One");
      expect(ed).not.toContain("Theirs One");
      expect(ed).not.toContain("Nobody One");
      expect(ed).not.toContain("no owner");
    }
    const all = await (await r.admin.get("/devices")).text();
    for (const name of ["Mine One", "Theirs One", "Nobody One"]) expect(all).toContain(name);
    const ed = await (await r.editor.get("/dashboard")).text();
    expect(ed).toContain("Monitor wall · 1 device</h2>");
    expect(ed).toContain('<span class="card-value">1</span>'); // devices card and the open alerts card
    // the site admin's wall: the ownerless projector plays its content; the others' never show
    const ad = await (await r.admin.get("/dashboard")).text();
    expect(ad).toContain("Nobody One");
    for (const name of ["Mine One", "Theirs One"]) expect(ad).not.toContain(name);
    expect(ad).toContain("Monitor wall · 1 device</h2>");
    expect(ad).toContain('<span class="badge badge-stale">1 open</span>');
    const devs = await (await r.admin.get("/devices")).text();
    expect(devs).toContain('<span class="device-id"><code>mine-1</code> · Mine group · ed</span>');
    expect(devs).toContain('<span class="device-id"><code>theirs-1</code> · Their group · vw</span>');
    expect(devs).toContain('<span class="device-id"><code>nobody-1</code> · Admin group · no owner</span>');
    const vw = await (await r.viewer.get("/devices")).text();
    expect(vw).toContain("Theirs One");
    expect(vw).not.toContain("Mine One");
  });

  it("Alerts, Playlists and Groups are one's own, counting one's own projectors", async () => {
    let page = await (await r.editor.get("/alerts")).text();
    expect(page).toContain("<strong>1 open</strong>");
    expect(page).toContain("Mine One");
    expect(page).not.toContain("Theirs One");
    page = await (await r.admin.get("/alerts")).text();
    expect(page).toContain("<strong>1 open</strong>"); // the ownerless projector, the site admin's
    expect(page).toContain("Nobody One");
    for (const name of ["Mine One", "Theirs One"]) expect(page).not.toContain(name);
    page = await (await r.editor.get("/playlists")).text();
    expect(page).toContain("Mine PL");
    expect(page).not.toContain("Their PL");
    expect(page).not.toContain("Admin PL");
    expect(page).toContain('title="devices with this as their default playlist">1 device</span>');
    expect(page).toContain("1 schedule rule");
    // the admin's own playlists; the ownerless projector plays the site admin's
    page = await (await r.admin.get("/playlists")).text();
    expect(page).toContain("Admin PL");
    expect(page).not.toContain("Mine PL");
    expect(page).toContain('title="devices with this as their default playlist">1 device</span>');
    page = await (await r.editor.get("/groups")).text();
    expect(page).toContain("Mine group");
    expect(page).not.toContain("Their group");
    expect(page).toContain("<td>1</td>");
    page = await (await r.admin.get("/groups")).text();
    expect(page).toContain("Admin group");
    expect(page).not.toContain("Mine group");
  });

  it("the Schedule page of another account's projector is a 404, as if it did not exist; an admin reads it", async () => {
    expect((await r.editor.get(`/devices/${w.mine.id}/schedule`)).status).toBe(200);
    for (const d of [w.theirs, w.nobody]) expect(await detail(await r.editor.get(`/devices/${d.id}/schedule`), 404)).toBe("Device not found");
    for (const d of [w.mine, w.theirs, w.nobody]) expect((await r.admin.get(`/devices/${d.id}/schedule`)).status).toBe(200);
    // read-only for another account's projector: its rules, but no add form or delete buttons
    const page = await (await r.admin.get(`/devices/${w.mine.id}/schedule`)).text();
    expect(page).toContain("Mine PL");
    expect(page).not.toContain(`action="/devices/${w.mine.id}/schedule"`);
    expect(page).toContain("its own account changes the timezone on its Settings page.");
    // the ownerless one is the site admin's: theirs to edit
    expect(await (await r.admin.get(`/devices/${w.nobody.id}/schedule`)).text()).toContain(`action="/devices/${w.nobody.id}/schedule"`);
  });

  it("Update all players queues only the caller's projectors", async () => {
    await query("DELETE FROM device_commands");
    expect((await post(r.editor, "/devices/update-all", { command: "update-player" })).status).toBe(303);
    expect((await query("SELECT device_id FROM device_commands ORDER BY device_id")).map((c) => c.device_id)).toEqual([w.mine.id]);
    expect(await (await r.editor.get("/devices")).text()).toContain("Update queued for 1 device.");
    await query("DELETE FROM device_commands");
    expect((await post(r.admin, "/devices/update-all", { command: "update-player" })).status).toBe(303);
    expect((await query("SELECT COUNT(*) AS n FROM device_commands"))[0].n).toBe(3);
    await query("DELETE FROM device_commands");
  });
});

describe("writes", () => {
  it("every per-device route answers the unknown-id 404 for a projector the editor may not see; the admin may act", async () => {
    const sid = (await query("SELECT id FROM device_schedules WHERE device_id = ?", w.theirs.id))[0].id;
    const routes = (d) => [
      ["rename", { name: "x" }], ["assign", { playlist_id: "" }], ["group", { group_id: "" }], ["regen-token", {}],
      ["command", { command: "force-sync" }], ["command/cancel", {}], ["camera-url", { camera_live_url: "" }], ["camera-source", { camera_source: "none" }],
      ["projector", { projector_control: "none", projector_power_mode: "manual" }],
      ["schedule", { name: "r", playlist_id: String(w.pid) }], [`schedule/${sid}/delete`, {}], ["delete", {}],
    ].map(([tail, fields]) => [`/devices/${d.id}/${tail}`, fields]);
    for (const [path, fields] of routes(w.theirs)) {
      const res = await post(r.editor, path, fields);
      expect(res.status, path).toBe(404);
      expect((await res.json()).detail, path).toBe("Device not found");
    }
    for (const kind of ["screenshot", "camera"]) expect(await detail(await r.editor.get(`/devices/${w.theirs.id}/${kind}`), 404)).toBe("Device not found");
    // the tunnel button answers 400 before looking at any device while tunnels are off (tunnel.test.js);
    // with the Cloudflare secrets set it 404s like the rest, before any API call
    Object.assign(env, { CF_API_TOKEN: "cf-test-token", CF_ACCOUNT_ID: "acct1", CF_ZONE_ID: "zone1" });
    try {
      expect(await detail(await post(r.editor, `/devices/${w.theirs.id}/tunnel`), 404)).toBe("Device not found");
    } finally {
      for (const k of ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_ZONE_ID"]) delete env[k];
    }
    // the same route on an unknown id says the same thing, so nothing leaks
    expect(await detail(await post(r.editor, `/devices/${NOPE}/rename`, { name: "x" }), 404)).toBe("Device not found");
    expect(await one("SELECT name, token FROM devices WHERE id = ?", w.theirs.id)).toEqual({ name: "Theirs One", token: w.theirs.token });
    expect(await one("SELECT id FROM device_schedules WHERE id = ?", sid)).toEqual({ id: sid });
    // the editor's own projector and the admin's device controls on anyone's: normal answers (tunnel: 400, not configured)
    expect((await post(r.editor, `/devices/${w.mine.id}/rename`, { name: "Mine One" })).status).toBe(303);
    expect((await post(r.admin, `/devices/${w.theirs.id}/rename`, { name: "Theirs One" })).status).toBe(303);
    expect((await post(r.admin, `/devices/${w.theirs.id}/command`, { command: "force-sync" })).status).toBe(303);
    expect((await post(r.editor, `/devices/${w.mine.id}/tunnel`)).status).toBe(400);
    // the ownerless projector plays the site admin's content: the admin assigns it their own playlist
    expect((await post(r.admin, `/devices/${w.nobody.id}/assign`, { playlist_id: String(w.adminPid) })).status).toBe(303);
    // ... but never another account's (the 404 of a missing playlist)
    expect(await detail(await post(r.admin, `/devices/${w.nobody.id}/assign`, { playlist_id: String(w.pid) }), 404)).toBe("Playlist not found");
    expect(await detail(await post(r.admin, `/devices/${w.nobody.id}/group`, { group_id: String(w.gid) }), 404)).toBe("Group not found");
    expect(await detail(await post(r.admin, `/devices/${w.nobody.id}/schedule`, { name: "x", playlist_id: String(w.pid) }), 404)).toBe("Playlist not found");
  });

  it("what another account's projector plays, its schedule and its token are not the admin's: 403, nothing changed", async () => {
    const sid = (await query("SELECT id FROM device_schedules WHERE device_id = ?", w.theirs.id))[0].id;
    const before = await one("SELECT playlist_id, group_id, token FROM devices WHERE id = ?", w.theirs.id);
    for (const [tail, fields] of [
      ["assign", { playlist_id: String(w.adminPid) }], ["assign", { playlist_id: "" }], ["group", { group_id: "" }],
      ["schedule", { name: "x", playlist_id: String(w.adminPid) }], [`schedule/${sid}/delete`, {}], ["regen-token", {}],
    ]) {
      expect(await detail(await post(r.admin, `/devices/${w.theirs.id}/${tail}`, fields), 403), tail)
        .toBe("This projector belongs to another account: only that account can change what it plays or see its token. Hand it over with the Owner select first if it should be yours.");
    }
    expect(await one("SELECT playlist_id, group_id, token FROM devices WHERE id = ?", w.theirs.id)).toEqual(before);
    expect(await one("SELECT id FROM device_schedules WHERE id = ?", sid)).toEqual({ id: sid });
    // the page shows it read-only: no selects, no token block, the owner's choices named
    const page = await (await r.admin.get("/devices")).text();
    expect(page).not.toContain(`action="/devices/${w.theirs.id}/assign"`);
    expect(page).not.toContain(`action="/devices/${w.theirs.id}/group"`);
    expect(page).not.toContain(w.theirs.token);
    expect(page).toContain("Plays what vw picks: group Their group, default playlist Their PL.");
  });

  it("Add device: the projector belongs to whoever adds it, an admin included", async () => {
    expect((await post(r.editor, "/devices", { device_id: "ed-added", name: "Ed added" })).status).toBe(303);
    expect(await one("SELECT owner_id FROM devices WHERE device_id = 'ed-added'")).toEqual({ owner_id: r.ids.editor });
    expect(await (await r.editor.get("/devices")).text()).toContain("Ed added");
    expect((await post(r.admin, "/devices", { device_id: "admin-added", name: "Admin added" })).status).toBe(303);
    expect(await one("SELECT owner_id FROM devices WHERE device_id = 'admin-added'")).toEqual({ owner_id: r.ids.admin });
    expect(await (await r.editor.get("/devices")).text()).not.toContain("Admin added");
    expect(await (await r.admin.get("/devices")).text()).toContain("<code>admin-added</code> · admin</span>");
    // a taken id is refused the same way whoever holds it (device ids are one site-wide name)
    expect(await detail(await post(r.editor, "/devices", { device_id: "admin-added", name: "x" }), 409)).toBe("A device with that ID already exists");
    await query("DELETE FROM devices WHERE device_id IN ('ed-added', 'admin-added')");
  });
});

describe("owner select", () => {
  it("admins get the select per device (every user + no owner); editors do not; the route is admin-only and audited", async () => {
    const ad = await (await r.admin.get("/devices")).text();
    expect(ad).toContain(`<form method="post" action="/devices/${w.nobody.id}/owner">`);
    expect(ad).toContain('<option value="">no owner</option>');
    expect(ad).toContain(`<option value="${r.ids.editor}">ed</option>`);
    expect(ad).toContain(`<option value="${r.ids.viewer}" selected>vw</option>`);
    expect(ad).toContain(`<option value="${r.ids.admin}">admin</option>`);
    const ed = await (await r.editor.get("/devices")).text();
    expect(ed).not.toContain("/owner\"");
    expect(ed).not.toContain('name="owner_id"');
    expect(await detail(await post(r.editor, `/devices/${w.mine.id}/owner`, { owner_id: "" }), 403)).toBe("requires admin role");
    // validation: unknown user / device, junk id
    expect(await detail(await post(r.admin, `/devices/${w.nobody.id}/owner`, { owner_id: String(NOPE) }), 404)).toBe("User not found");
    expect(await detail(await post(r.admin, `/devices/${NOPE}/owner`, { owner_id: "" }), 404)).toBe("Device not found");
    expect(await detail(await post(r.admin, `/devices/${w.nobody.id}/owner`, { owner_id: "abc" }), 400)).toBe("owner_id must be a whole number");
  });

  it("handing a projector to another account clears what was not that account's: playlist, group, schedule rules", async () => {
    // nobody-1 plays the site admin's playlist, group and a rule for the admin's playlist
    await query("UPDATE devices SET playlist_id = ?, group_id = ? WHERE id = ?", w.adminPid, w.adminGid, w.nobody.id);
    const ruleId = (await query("SELECT id FROM device_schedules WHERE device_id = ?", w.nobody.id))[0].id;
    expect((await post(r.admin, `/devices/${w.nobody.id}/owner`, { owner_id: String(r.ids.editor) })).status).toBe(303);
    expect(await one("SELECT owner_id, playlist_id, group_id FROM devices WHERE id = ?", w.nobody.id)).toEqual({ owner_id: r.ids.editor, playlist_id: null, group_id: null });
    expect(await query("SELECT id FROM device_schedules WHERE device_id = ?", w.nobody.id)).toEqual([]);
    expect((await audits("device_set_owner"))[0]).toMatchObject({ username: "admin", target_type: "device", target_id: String(w.nobody.id),
      details: `{"owner_id": ${r.ids.editor}, "owner": "ed", "playlist_cleared": true, "group_cleared": true, "schedules_deleted": 1}` });
    const [rule] = await audits("device_schedule_delete");
    expect(rule).toMatchObject({ target_id: String(ruleId) });
    expect(JSON.parse(rule.details)).toMatchObject({ device_id: w.nobody.id, cascade_from_owner_change: true });
    // the editor now sees it, playing the editor's own Default playlist (not the admin's)
    const page = await (await r.editor.get("/devices")).text();
    expect(page).toContain("Nobody One");
    const settings = await query("SELECT value FROM account_settings WHERE user_id = ? AND key = 'default_playlist_id'", r.ids.editor);
    expect(page).toContain(`nothing in it yet · <a href="/library">upload files in the Library</a>`);
    expect(Number(settings[0].value)).toBe(await defaultPlaylistOf(r.ids.editor));
    // the editor's own content stays when it goes back to the editor; the editor sets some, then it goes to nobody
    expect((await post(r.editor, `/devices/${w.nobody.id}/assign`, { playlist_id: String(w.pid) })).status).toBe(303);
    expect((await post(r.admin, `/devices/${w.nobody.id}/owner`, { owner_id: "" })).status).toBe(303);
    // ownerless again: the site admin's content account, so the editor's playlist goes
    expect(await one("SELECT owner_id, playlist_id FROM devices WHERE id = ?", w.nobody.id)).toEqual({ owner_id: null, playlist_id: null });
    expect(await (await r.editor.get("/devices")).text()).not.toContain("Nobody One");
    expect(JSON.parse((await audits("device_set_owner"))[0].details)).toEqual({ owner_id: null, owner: null, playlist_cleared: true });
    // a move that keeps the content account (the site admin's own projector made ownerless) clears nothing
    expect((await post(r.admin, `/devices/${w.nobody.id}/assign`, { playlist_id: String(w.adminPid) })).status).toBe(303);
    expect((await post(r.admin, `/devices/${w.nobody.id}/owner`, { owner_id: String(r.ids.admin) })).status).toBe(303);
    expect(await one("SELECT owner_id, playlist_id FROM devices WHERE id = ?", w.nobody.id)).toEqual({ owner_id: r.ids.admin, playlist_id: w.adminPid });
    expect((await post(r.admin, `/devices/${w.nobody.id}/owner`, { owner_id: "" })).status).toBe(303);
    expect(await one("SELECT owner_id, playlist_id FROM devices WHERE id = ?", w.nobody.id)).toEqual({ owner_id: null, playlist_id: w.adminPid });
  });
});

describe("users page", () => {
  it("shows how many projectors each account owns; deleting the account takes its library with it, leaves its projectors ownerless and signed out, and the confirm says so", async () => {
    const page = await (await r.admin.get("/users")).text();
    expect(page).toContain('<th scope="col">Projectors</th>');
    expect(page).toContain('<td title="Projectors this account owns (set on the Devices page)">1</td>');
    expect(page).toContain('data-confirm="Delete vw? Their library, playlists, groups and settings are deleted with the account, and their API tokens stop working. Their projectors stay on the Devices page with no owner, signed out until each gets a new token there."');
    expect((await post(r.admin, "/users", { username: "gone", password: "gone-pass", role: "editor" })).status).toBe(303);
    const uid = (await one("SELECT id FROM users WHERE username = 'gone'")).id;
    const pl = await playlist("Gone PL", uid);
    const d = await device("gone-1", "Gone One", { owner_id: uid, playlist_id: pl });
    await env.MEDIA.put("media/gone-file.mp4", new Uint8Array(10));
    await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id) VALUES ('gone-file.mp4', 'g.mp4', 'video', 10, ?, ?)", "f".repeat(64), uid);
    expect(await (await r.admin.get("/users")).text()).toContain('<td title="Projectors this account owns (set on the Devices page)">1</td>\n      <td class="muted nowrap">');
    expect(await (await r.admin.get("/devices")).text()).toContain(`<option value="${uid}">gone</option>`);
    // until the delete the card syncs with its account's content
    const bearer = (path) => SELF.fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${d.token}` } });
    expect((await bearer("/api/sync/gone-1")).status).toBe(200);
    expect((await post(r.admin, `/users/${uid}/delete`)).status).toBe(303);
    expect(await one("SELECT owner_id, playlist_id FROM devices WHERE id = ?", d.id)).toEqual({ owner_id: null, playlist_id: null });
    // an ownerless projector would play the site admin's content and read the site admin's Wyze
    // login: the deleted account's card is signed out in the same transaction (a new token waits
    // on the Devices page), so its old token gets neither
    for (const path of ["/api/sync/gone-1", "/api/camera-config/gone-1", "/api/media/gone-file.mp4"]) {
      expect((await bearer(path)).status, path).toBe(401);
    }
    expect((await one("SELECT token FROM devices WHERE id = ?", d.id)).token).toMatch(/^[0-9a-f]{64}$/);
    expect(await query("SELECT id FROM playlists WHERE owner_id = ? OR id = ?", uid, pl)).toEqual([]);
    expect(await query("SELECT id FROM media WHERE filename = 'gone-file.mp4'")).toEqual([]);
    expect(await env.MEDIA.head("media/gone-file.mp4")).toBeNull();
    expect(await query("SELECT key FROM account_settings WHERE user_id = ?", uid)).toEqual([]);
    expect((await audits("user_delete"))[0].details).toBe('{"media_deleted": 1, "projectors_signed_out": 1}');
    await query("DELETE FROM devices WHERE id = ?", d.id);
  });
});

describe("empty states", () => {
  it("an account with no projectors is pointed at the SD Flasher on Devices and Dashboard", async () => {
    await query("UPDATE devices SET owner_id = NULL WHERE owner_id = ?", r.ids.editor);
    for (const path of ["/devices", "/dashboard"]) {
      const page = await (await r.editor.get(path)).text();
      expect(page).toContain('<span class="empty-title">NO PROJECTORS</span>');
      expect(page).toContain('No projectors yet. Flash a card with the <a href="/flasher">SD Flasher</a> and it appears here.');
      expect(page).not.toContain("NO DEVICES");
      expect(page).not.toContain("Update all players");
    }
    // an admin with an empty fleet keeps the Add device wording
    await query("DELETE FROM devices");
    expect(await (await r.admin.get("/devices")).text()).toContain("No devices yet. Add one above.");
    expect(await (await r.admin.get("/dashboard")).text()).toContain("No devices yet. Add one to start the wall.");
  });
});
