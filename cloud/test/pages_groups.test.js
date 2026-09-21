// /groups: list, create (400/409), assign (400/404), delete (404), role matrix, escaping.
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
    let page = await (await r.viewer.get("/groups")).text();
    expect(page).toContain("<h1>Device groups</h1>");
    expect(page).not.toContain(XSS);
    expect(page).toContain("x&#39;);alert(1);//grp");
    expect(page).toContain("<td>1</td>");
    expect(page).toContain(`<option value="${w.pid}" selected>Fallback</option>`);
    expect(page).toContain('data-autosubmit aria-label="Default playlist for x&#39;);alert(1);//grp" disabled');
    expect(page).not.toContain("new group");
    expect(page).not.toContain("data-confirm");
    page = await (await r.editor.get("/groups")).text();
    expect(page).toContain('data-confirm="Delete x&#39;);alert(1);//grp? Devices in the group will lose this default playlist."');
    expect(page).toContain("new group");
    expect(page).not.toContain("onchange");
  });

  it("create: 400 blank, 409 duplicate (friendly), audits", async () => {
    expect(await detail(await post(r.editor, "/groups", { name: "  " }), 400)).toBe("Name required");
    expect((await post(r.editor, "/groups", { name: " Fresh group " })).status).toBe(303);
    const dup = await detail(await post(r.editor, "/groups", { name: "Fresh group" }), 409);
    expect(dup).toBe("A group with that name already exists");
    const gid = (await one("SELECT id FROM device_groups WHERE name = 'Fresh group'")).id;
    expect((await audits("group_create"))[0]).toMatchObject({ target_type: "group", target_id: String(gid), details: '{"name": "Fresh group"}' });
  });

  it("assign: 400/404, clear allowed, audits", async () => {
    expect(await detail(await post(r.editor, `/groups/${w.gid}/assign`, { playlist_id: "abc" }), 400)).toBe("playlist_id must be an integer");
    expect(await detail(await post(r.editor, `/groups/${w.gid}/assign`, { playlist_id: String(NOPE) }), 404)).toBe("Playlist not found");
    expect(await detail(await post(r.editor, `/groups/${NOPE}/assign`, { playlist_id: String(w.pid) }), 404)).toBe("Group not found");
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
    expect((await post(r.editor, `/groups/${gid}/delete`)).status).toBe(303);
    expect(await one("SELECT id FROM device_groups WHERE id = ?", gid)).toBeNull();
    expect((await one("SELECT group_id FROM devices WHERE id = ?", dev.id)).group_id).toBeNull();
    expect((await audits("group_delete"))[0].target_id).toBe(String(gid));
  });
});
