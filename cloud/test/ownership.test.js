// Ownership (migration 0009, devices.owner_id): editors and viewers see only the projectors they
// own, admins every one. Per page visibility, the 404 on another account's device for every
// per-device route, the admin Owner select + audit, the Add device owner rule, the Users page
// count and the empty states that point at the SD Flasher.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { query } from "./helpers.js";
import { audits, detail, device, group, ins, NOPE, one, playlist, post, roles } from "./pages_common.js";

let r;
const w = {};

beforeAll(async () => {
  r = await roles();
  w.pid = await playlist("Shared PL");
  w.gid = await group("Shared group");
  w.mine = await device("mine-1", "Mine One", { playlist_id: w.pid, group_id: w.gid }); // the editor's (pages_common.device)
  w.theirs = await device("theirs-1", "Theirs One", { playlist_id: w.pid, group_id: w.gid, owner_id: r.ids.viewer });
  w.nobody = await device("nobody-1", "Nobody One", { playlist_id: w.pid, group_id: w.gid, owner_id: null });
  for (const d of [w.mine, w.theirs, w.nobody]) {
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'r', 1)", d.id, w.pid);
    await ins("INSERT INTO alerts (device_id, kind, opened_at) VALUES (?, 'offline', '2026-09-16 09:00:00')", d.id);
  }
});

describe("visibility", () => {
  it("Devices and Dashboard: the editor sees only its own projector, the admin all three with the owner", async () => {
    for (const path of ["/devices", "/dashboard"]) {
      const ed = await (await r.editor.get(path)).text();
      expect(ed).toContain("Mine One");
      expect(ed).not.toContain("Theirs One");
      expect(ed).not.toContain("Nobody One");
      expect(ed).not.toContain("no owner");
      const ad = await (await r.admin.get(path)).text();
      for (const name of ["Mine One", "Theirs One", "Nobody One"]) expect(ad).toContain(name);
    }
    const ed = await (await r.editor.get("/dashboard")).text();
    expect(ed).toContain("Monitor wall · 1 device</h2>");
    expect(ed).toContain('<span class="card-value">1</span>'); // devices card and the open alerts card
    const ad = await (await r.admin.get("/dashboard")).text();
    expect(ad).toContain("Monitor wall · 3 devices</h2>");
    expect(ad).toContain('<span class="badge badge-stale">3 open</span>');
    const devs = await (await r.admin.get("/devices")).text();
    expect(devs).toContain('<span class="device-id"><code>mine-1</code> · Shared group · ed</span>');
    expect(devs).toContain('<span class="device-id"><code>theirs-1</code> · Shared group · vw</span>');
    expect(devs).toContain('<span class="device-id"><code>nobody-1</code> · Shared group · no owner</span>');
    const vw = await (await r.viewer.get("/devices")).text();
    expect(vw).toContain("Theirs One");
    expect(vw).not.toContain("Mine One");
  });

  it("Alerts, Playlists 'used by' and Groups counts follow the same rule", async () => {
    let page = await (await r.editor.get("/alerts")).text();
    expect(page).toContain("<strong>1 open</strong>");
    expect(page).toContain("Mine One");
    expect(page).not.toContain("Theirs One");
    page = await (await r.admin.get("/alerts")).text();
    expect(page).toContain("<strong>3 open</strong>");
    page = await (await r.editor.get("/playlists")).text();
    expect(page).toContain('title="devices with this as their default playlist">1 device</span>');
    expect(page).toContain("3 schedule rules"); // fleet-wide: deleting the playlist removes every rule
    page = await (await r.admin.get("/playlists")).text();
    expect(page).toContain('title="devices with this as their default playlist">3 devices</span>');
    expect(page).toContain("3 schedule rules");
    page = await (await r.editor.get("/groups")).text();
    expect(page).toContain("<td>1</td>");
    page = await (await r.admin.get("/groups")).text();
    expect(page).toContain("<td>3</td>");
  });

  it("the Schedule page of another account's projector is a 404, as if it did not exist", async () => {
    expect((await r.editor.get(`/devices/${w.mine.id}/schedule`)).status).toBe(200);
    for (const d of [w.theirs, w.nobody]) expect(await detail(await r.editor.get(`/devices/${d.id}/schedule`), 404)).toBe("Device not found");
    for (const d of [w.mine, w.theirs, w.nobody]) expect((await r.admin.get(`/devices/${d.id}/schedule`)).status).toBe(200);
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
      ["command", { command: "force-sync" }], ["camera-url", { camera_live_url: "" }], ["camera-source", { camera_source: "none" }],
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
    // the editor's own projector and the admin on anyone's: normal answers (tunnel: 400, not configured)
    expect((await post(r.editor, `/devices/${w.mine.id}/rename`, { name: "Mine One" })).status).toBe(303);
    expect((await post(r.admin, `/devices/${w.theirs.id}/rename`, { name: "Theirs One" })).status).toBe(303);
    expect((await post(r.admin, `/devices/${w.nobody.id}/assign`, { playlist_id: String(w.pid) })).status).toBe(303);
    expect((await post(r.editor, `/devices/${w.mine.id}/tunnel`)).status).toBe(400);
  });

  it("Add device: an editor's manual addition is theirs, an admin's has no owner", async () => {
    expect((await post(r.editor, "/devices", { device_id: "ed-added", name: "Ed added" })).status).toBe(303);
    expect(await one("SELECT owner_id FROM devices WHERE device_id = 'ed-added'")).toEqual({ owner_id: r.ids.editor });
    expect(await (await r.editor.get("/devices")).text()).toContain("Ed added");
    expect((await post(r.admin, "/devices", { device_id: "admin-added", name: "Admin added" })).status).toBe(303);
    expect(await one("SELECT owner_id FROM devices WHERE device_id = 'admin-added'")).toEqual({ owner_id: null });
    expect(await (await r.editor.get("/devices")).text()).not.toContain("Admin added");
    expect(await (await r.admin.get("/devices")).text()).toContain('<code>admin-added</code> · no owner</span>');
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
    // hand the ownerless projector to the editor, who now sees it
    expect((await post(r.admin, `/devices/${w.nobody.id}/owner`, { owner_id: String(r.ids.editor) })).status).toBe(303);
    expect(await one("SELECT owner_id FROM devices WHERE id = ?", w.nobody.id)).toEqual({ owner_id: r.ids.editor });
    expect(await (await r.editor.get("/devices")).text()).toContain("Nobody One");
    expect((await audits("device_set_owner"))[0]).toMatchObject({ username: "admin", target_type: "device", target_id: String(w.nobody.id), details: `{"owner_id": ${r.ids.editor}, "owner": "ed"}` });
    // and back to nobody
    expect((await post(r.admin, `/devices/${w.nobody.id}/owner`, { owner_id: "" })).status).toBe(303);
    expect(await one("SELECT owner_id FROM devices WHERE id = ?", w.nobody.id)).toEqual({ owner_id: null });
    expect(await (await r.editor.get("/devices")).text()).not.toContain("Nobody One");
    expect((await audits("device_set_owner"))[0].details).toBe('{"owner_id": null, "owner": null}');
    // validation: unknown user / device, junk id
    expect(await detail(await post(r.admin, `/devices/${w.nobody.id}/owner`, { owner_id: String(NOPE) }), 404)).toBe("User not found");
    expect(await detail(await post(r.admin, `/devices/${NOPE}/owner`, { owner_id: "" }), 404)).toBe("Device not found");
    expect(await detail(await post(r.admin, `/devices/${w.nobody.id}/owner`, { owner_id: "abc" }), 400)).toBe("owner_id must be a whole number");
  });
});

describe("users page", () => {
  it("shows how many projectors each account owns; deleting the account leaves them ownerless and the confirm says so", async () => {
    const page = await (await r.admin.get("/users")).text();
    expect(page).toContain('<th scope="col">Projectors</th>');
    expect(page).toContain('<td title="Projectors this account owns (set on the Devices page)">1</td>');
    expect(page).toContain('data-confirm="Delete vw? Their API tokens stop working and any flasher using them will fail. Their projectors keep playing but have no owner until you pick one on the Devices page."');
    expect((await post(r.admin, "/users", { username: "gone", password: "gone-pass", role: "editor" })).status).toBe(303);
    const uid = (await one("SELECT id FROM users WHERE username = 'gone'")).id;
    const d = await device("gone-1", "Gone One", { owner_id: uid });
    expect(await (await r.admin.get("/users")).text()).toContain('<td title="Projectors this account owns (set on the Devices page)">1</td>\n      <td class="muted nowrap">');
    expect(await (await r.admin.get("/devices")).text()).toContain(`<option value="${uid}">gone</option>`);
    expect((await post(r.admin, `/users/${uid}/delete`)).status).toBe(303);
    expect(await one("SELECT owner_id FROM devices WHERE id = ?", d.id)).toEqual({ owner_id: null });
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
