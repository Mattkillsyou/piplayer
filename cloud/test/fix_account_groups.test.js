// Rename group (account track): the name cell on /groups is a rename form, POST /groups/:id/rename
// changes the name in place like a playlist's (the projectors keep their group), with the same
// answers as create: 400 blank, 409 a name the account already uses, 404 a missing group or
// another account's.
import { beforeAll, describe, expect, it } from "vitest";
import { audits, detail, device, group, NOPE, one, post, roleMatrix, roles, XSS } from "./pages_common.js";

let r;
const w = {};
const nameOf = (id) => one("SELECT name FROM device_groups WHERE id = ?", id);

beforeAll(async () => {
  r = await roles();
  w.gid = await group("Lobby projectrs");
  w.stage = await group("Stage");
  w.dev = await device("lobby-1", "Lobby 1", { group_id: w.gid });
});

describe("Rename group", () => {
  it("the name cell is a rename form for an editor and plain text for a viewer", async () => {
    const page = await (await r.editor.get("/groups")).text();
    expect(page).toMatch(new RegExp(`<td class="name"><form method="post" action="/groups/${w.gid}/rename" class="inline duration-form">\\s*`
      + `<input type="hidden" name="csrf_token" value="[^"]+">\\s*`
      + `<input type="text" name="name" value="Lobby projectrs" required aria-label="Name of Lobby projectrs">\\s*`
      + `<button type="submit" class="small">Rename</button>\\s*</form></td>`));
    await group(XSS, r.ids.viewer);
    const v = await (await r.viewer.get("/groups")).text();
    expect(v).toContain('<td class="name">x&#39;);alert(1);//</td>');
    expect(v).not.toContain("/rename");
  });

  it("renames in place: the projector keeps its group and the Devices page shows the new name; audited", async () => {
    const res = await post(r.editor, `/groups/${w.gid}/rename`, { name: "  Lobby projectors " });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/groups");
    expect(await nameOf(w.gid)).toEqual({ name: "Lobby projectors" });
    expect(await one("SELECT group_id FROM devices WHERE id = ?", w.dev.id)).toEqual({ group_id: w.gid });
    expect(await (await r.editor.get("/devices")).text()).toContain(" · Lobby projectors");
    expect((await audits("group_rename"))[0]).toMatchObject({ username: "ed", target_type: "group", target_id: String(w.gid), details: '{"name": "Lobby projectors"}' });
  });

  it("400 blank, 409 a name the account already uses, 404 a missing group or another account's; nothing changes", async () => {
    expect(await detail(await post(r.editor, `/groups/${w.gid}/rename`, { name: "  " }), 400)).toBe("Enter a name");
    expect(await detail(await post(r.editor, `/groups/${w.gid}/rename`, { name: "Stage" }), 409)).toBe("A group with that name already exists");
    expect(await detail(await post(r.editor, `/groups/${NOPE}/rename`, { name: "x" }), 404)).toBe("Group not found");
    expect(await detail(await post(r.admin, `/groups/${w.gid}/rename`, { name: "Taken over" }), 404)).toBe("Group not found");
    expect(await nameOf(w.gid)).toEqual({ name: "Lobby projectors" });
    // another account may give its own group the same name
    const theirs = await group("Admin's", r.ids.admin);
    expect((await post(r.admin, `/groups/${theirs}/rename`, { name: "Lobby projectors" })).status).toBe(303);
    expect(await nameOf(theirs)).toEqual({ name: "Lobby projectors" });
  });

  it("anonymous goes to sign in, a viewer gets 403, an editor renames", async () => {
    await roleMatrix(r, "POST", `/groups/${w.stage}/rename`, { fields: { name: "Stage left" } });
    expect(await nameOf(w.stage)).toEqual({ name: "Stage left" });
  });
});
