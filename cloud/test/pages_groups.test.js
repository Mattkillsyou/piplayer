// /groups: list, create (400/409), assign (400/404), delete (404), role matrix, escaping. Every
// account its own groups (migration 0016): the fixtures are the editor's, another account (the
// admin's too) never lists them and gets the 404 of a missing id; names are unique per account.
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { audits, detail, device, group, NOPE, one, playlist, post, roleMatrix, roles, XSS } from "./pages_common.js";

let r;
const w = {};

beforeAll(async () => {
  r = await roles();
  w.pid = await playlist("Fallback");
  w.gid = await group(XSS + "grp");
  await device("g-dev", "G dev", { group_id: w.gid });
});

describe("groups", () => {
  it("role matrix", async () => {
    await roleMatrix(r, "GET", "/groups");
    await roleMatrix(r, "POST", "/groups", { fields: { name: "matrix" } });
    const gid = (await one("SELECT id FROM device_groups WHERE name = 'matrix'")).id;
    await roleMatrix(r, "POST", `/groups/${gid}/assign`, { fields: { playlist_id: String(w.pid) } });
    await roleMatrix(r, "POST", `/groups/${gid}/delete`);
    expect(await one("SELECT id FROM device_groups WHERE id = ?", gid)).toBeNull();
  });

  it("page: device count, selected playlist, escaped confirm, viewer read-only", async () => {
    await query("UPDATE device_groups SET playlist_id = ? WHERE id = ?", w.pid, w.gid);
    // the viewer's own group, playlist and projector (names are per account)
    const vpid = await playlist("Fallback", r.ids.viewer);
    const vgid = await group(XSS + "grp", r.ids.viewer);
    await query("UPDATE device_groups SET playlist_id = ? WHERE id = ?", vpid, vgid);
    await device("g-vdev", "G vdev", { group_id: vgid, owner_id: r.ids.viewer });
    let page = await (await r.viewer.get("/groups")).text();
    expect(page).toContain("<h1>Device groups</h1>");
    expect(page).not.toContain(XSS);
    expect(page).toContain("x&#39;);alert(1);//grp");
    expect(page).toContain("<td>1</td>");
    expect(page).toContain(`<option value="${vpid}" selected>Fallback</option>`);
    expect(page).toContain('data-autosubmit aria-label="Default playlist for x&#39;);alert(1);//grp" disabled');
    expect(page).not.toContain("new group");
    expect(page).not.toContain("data-confirm");
    // only its own: neither the editor's group nor the editor's playlists
    expect(page).toContain(`action="/groups/${vgid}/assign"`);
    expect(page).not.toContain(`action="/groups/${w.gid}/assign"`);
    expect(page).not.toContain(`<option value="${w.pid}"`);
    page = await (await r.editor.get("/groups")).text();
    expect(page).toContain('data-confirm="Delete x&#39;);alert(1);//grp? Devices in the group will lose this default playlist."');
    expect(page).toContain("new group");
    expect(page).not.toContain("onchange");
    expect(page).toContain(`<option value="${w.pid}" selected>Fallback</option>`);
    expect(page).not.toContain(`action="/groups/${vgid}/assign"`);
    expect(page).not.toContain(`<option value="${vpid}"`);
    // an admin's page is the admin's own groups too
    page = await (await r.admin.get("/groups")).text();
    for (const id of [w.gid, vgid]) expect(page).not.toContain(`/groups/${id}/`);
  });

  it("create: 400 blank, 409 duplicate (friendly), audits", async () => {
    expect(await detail(await post(r.editor, "/groups", { name: "  " }), 400)).toBe("Enter a name");
    expect((await post(r.editor, "/groups", { name: " Fresh group " })).status).toBe(303);
    const dup = await detail(await post(r.editor, "/groups", { name: "Fresh group" }), 409);
    expect(dup).toBe("A group with that name already exists");
    const gid = (await one("SELECT id FROM device_groups WHERE name = 'Fresh group'")).id;
    expect((await audits("group_create"))[0]).toMatchObject({ target_type: "group", target_id: String(gid), details: '{"name": "Fresh group"}' });
    // another account may have its own Fresh group
    expect((await post(r.admin, "/groups", { name: "Fresh group" })).status).toBe(303);
    expect((await query("SELECT owner_id FROM device_groups WHERE name = 'Fresh group' ORDER BY id")).map((x) => x.owner_id)).toEqual([r.ids.editor, r.ids.admin]);
  });

  it("assign: 400/404, clear allowed, audits", async () => {
    expect(await detail(await post(r.editor, `/groups/${w.gid}/assign`, { playlist_id: "abc" }), 400)).toBe("playlist_id must be a whole number");
    expect(await detail(await post(r.editor, `/groups/${w.gid}/assign`, { playlist_id: String(NOPE) }), 404)).toBe("Playlist not found");
    expect(await detail(await post(r.editor, `/groups/${NOPE}/assign`, { playlist_id: String(w.pid) }), 404)).toBe("Group not found");
    // another account's playlist or group answers like a missing one
    const adminPl = await playlist("Admin's", r.ids.admin);
    expect(await detail(await post(r.editor, `/groups/${w.gid}/assign`, { playlist_id: String(adminPl) }), 404)).toBe("Playlist not found");
    expect(await detail(await post(r.admin, `/groups/${w.gid}/assign`, { playlist_id: String(adminPl) }), 404)).toBe("Group not found");
    expect((await one("SELECT playlist_id FROM device_groups WHERE id = ?", w.gid)).playlist_id).not.toBe(adminPl);
    expect((await post(r.editor, `/groups/${w.gid}/assign`, { playlist_id: String(w.pid) })).status).toBe(303);
    expect((await one("SELECT playlist_id FROM device_groups WHERE id = ?", w.gid)).playlist_id).toBe(w.pid);
    expect((await post(r.editor, `/groups/${w.gid}/assign`, { playlist_id: "" })).status).toBe(303);
    expect((await one("SELECT playlist_id FROM device_groups WHERE id = ?", w.gid)).playlist_id).toBeNull();
    expect((await audits("group_assign_playlist"))[0].details).toBe('{"playlist_id": null}');
  });

  it("delete: 404 unknown, devices keep existing with group cleared, audits", async () => {
    const gid = await group("Doomed");
    const dev = await device("doomed-dev", "Doomed dev", { group_id: gid });
    expect(await detail(await post(r.editor, `/groups/${NOPE}/delete`), 404)).toBe("Group not found");
    expect(await detail(await post(r.admin, `/groups/${gid}/delete`), 404)).toBe("Group not found"); // not the admin's
    expect(await one("SELECT id FROM device_groups WHERE id = ?", gid)).not.toBeNull();
    expect((await post(r.editor, `/groups/${gid}/delete`)).status).toBe(303);
    expect(await one("SELECT id FROM device_groups WHERE id = ?", gid)).toBeNull();
    expect((await one("SELECT group_id FROM devices WHERE id = ?", dev.id)).group_id).toBeNull();
    expect((await audits("group_delete"))[0].target_id).toBe(String(gid));
  });
});
