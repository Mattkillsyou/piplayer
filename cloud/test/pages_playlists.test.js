// /playlists: list + cascade-warning confirm, create, edit page, items add/duration/reorder/
// delete (positions renumbered), rename, delete (cascade audit). Role matrix + contract 10.
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { audits, detail, device, group, ins, media, NOPE, one, playlist, post, postJson, roleMatrix, roles, XSS } from "./pages_common.js";

let r;
const w = {};

const positions = (pid) => query("SELECT id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position, id", pid);

beforeAll(async () => {
  r = await roles();
  w.m1 = await media("one.png", "image");
  w.m2 = await media("two.mp4", "video", { duration: 12.34 });
  w.m3 = await media("three.png", "image");
  w.pid = await playlist("Lobby");
  w.i1 = await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", w.pid, w.m1);
  w.i2 = await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 1)", w.pid, w.m2);
});

describe("role matrix", () => {
  it("pages are for every user, writes for editor+", async () => {
    await roleMatrix(r, "GET", "/playlists");
    await roleMatrix(r, "GET", `/playlists/${w.pid}`);
    const scratch = await playlist("Scratch");
    const item = await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", scratch, w.m3);
    await roleMatrix(r, "POST", "/playlists", { fields: { name: "matrix" } });
    await roleMatrix(r, "POST", `/playlists/${scratch}/items`, { fields: { media_id: String(w.m1) } });
    await roleMatrix(r, "POST", `/playlists/${scratch}/items/${item}/duration`, { fields: { duration: "3" } });
    await roleMatrix(r, "POST", `/playlists/${scratch}/items/${item}/delete`);
    await roleMatrix(r, "POST", `/playlists/${scratch}/rename`, { fields: { name: "Scratch2" } });
    await roleMatrix(r, "POST", `/playlists/${scratch}/delete`);
    const res = await r.viewer.postJson(`/playlists/${w.pid}/items/reorder`, { order: [w.i2, w.i1] }, { "X-CSRF-Token": r.viewer.token });
    expect(res.status).toBe(403);
    expect((await positions(w.pid)).map((x) => x.id)).toEqual([w.i1, w.i2]);
    expect(await one("SELECT id FROM playlists WHERE id = ?", scratch)).toBeNull();
  });

  it("viewer sees View and no forms; editor sees Edit, rename, add, drag handle", async () => {
    let page = await (await r.viewer.get("/playlists")).text();
    expect(page).toContain(">View<");
    expect(page).not.toContain("new playlist");
    expect(page).not.toContain("data-confirm");
    page = await (await r.viewer.get(`/playlists/${w.pid}`)).text();
    expect(page).toContain('data-readonly="1"');
    expect(page).not.toContain("/rename");
    expect(page).not.toContain("Add media");
    page = await (await r.editor.get(`/playlists/${w.pid}`)).text();
    expect(page).toContain(`data-playlist-id="${w.pid}"`);
    expect(page).toContain("drag rows to reorder");
    expect(page).toContain("⣿");
    expect(page).toContain('<script src="/static/sortable.min.js"></script>');
    expect(page).toContain("three.png");           // available to add
    expect(page).toContain("12.3 s");              // natural duration
    expect(page).toContain('placeholder="10.0"');  // default image duration, float repr like Python
    expect(page).toContain("10.0s default for images");
  });
});

describe("list page", () => {
  it("shows counts and the cascade warning in data-confirm, escaped", async () => {
    const pid = await playlist(XSS + "-list");
    const gid = await group("g-list");
    const dev = await device("d-list", "D list", { playlist_id: pid });
    await query("UPDATE device_groups SET playlist_id = ? WHERE id = ?", pid, gid);
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'r', 1)", dev.id, pid);
    const page = await (await r.admin.get("/playlists")).text();
    expect(page).not.toContain(XSS);
    expect(page).toContain(`data-confirm="Delete playlist x&#39;);alert(1);//-list? 1 schedule rule(s) will be deleted; 1 device default(s) will be cleared; 1 group default(s) will be cleared."`);
    expect(page).toContain(`data-confirm="Delete playlist Lobby?"`);
    expect(page).toContain("1 device</span>");
    expect(page).toContain("· 1 group");
    expect(page).toContain("· 1 schedule rule");
    expect(page).not.toContain("onsubmit");
    expect(page).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });
});

describe("create / rename / delete", () => {
  it("create validates, 409s on duplicates, audits, redirects to the editor", async () => {
    expect(await detail(await post(r.editor, "/playlists", { name: "   " }), 400)).toBe("Name required");
    const res = await post(r.editor, "/playlists", { name: "  Fresh " });
    expect(res.status).toBe(303);
    const pid = (await one("SELECT id FROM playlists WHERE name = 'Fresh'")).id;
    expect(res.headers.get("location")).toBe(`/playlists/${pid}`);
    const dup = await detail(await post(r.editor, "/playlists", { name: "Fresh" }), 409);
    expect(dup).toBe("A playlist with that name already exists");
    expect(dup.toLowerCase()).not.toContain("sqlite");
    const [a] = await audits("create_playlist");
    expect(a).toMatchObject({ username: "ed", target_type: "playlist", target_id: String(pid), details: '{"name": "Fresh"}' });
  });

  it("rename: 400 empty, 404 missing, 409 duplicate (name unchanged), audits", async () => {
    const pid = await playlist("Ren");
    expect((await post(r.editor, `/playlists/${pid}/rename`, { name: "" })).status).toBe(400);
    expect(await detail(await post(r.editor, `/playlists/${NOPE}/rename`, { name: "z" }), 404)).toBe("Playlist not found");
    expect(await detail(await post(r.editor, `/playlists/${pid}/rename`, { name: "Lobby" }), 409)).toBe("A playlist with that name already exists");
    expect((await one("SELECT name FROM playlists WHERE id = ?", pid)).name).toBe("Ren");
    const res = await post(r.editor, `/playlists/${pid}/rename`, { name: "Renamed" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/playlists/${pid}`);
    expect((await one("SELECT name FROM playlists WHERE id = ?", pid)).name).toBe("Renamed");
    expect((await audits("playlist_rename"))[0].details).toBe('{"name": "Renamed"}');
    expect((await post(r.editor, "/playlists/abc/rename", { name: "z" })).status).toBe(400);
  });

  it("delete cascades and audits the removed rules / cleared defaults", async () => {
    const pid = await playlist("Gone");
    const gid = await group("g-gone");
    const dev = await device("d-gone", "D gone", { playlist_id: pid });
    await query("UPDATE device_groups SET playlist_id = ? WHERE id = ?", pid, gid);
    const sid = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'night', 1)", dev.id, pid);
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", pid, w.m3);
    expect(await detail(await post(r.editor, `/playlists/${NOPE}/delete`), 404)).toBe("Playlist not found");
    const res = await post(r.editor, `/playlists/${pid}/delete`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/playlists");
    expect(await one("SELECT id FROM playlists WHERE id = ?", pid)).toBeNull();
    expect(await query("SELECT id FROM playlist_items WHERE playlist_id = ?", pid)).toEqual([]);
    expect(await query("SELECT id FROM device_schedules WHERE id = ?", sid)).toEqual([]);
    expect((await one("SELECT playlist_id FROM devices WHERE id = ?", dev.id)).playlist_id).toBeNull();
    expect((await one("SELECT playlist_id FROM device_groups WHERE id = ?", gid)).playlist_id).toBeNull();
    const [del] = await audits("playlist_delete");
    expect(JSON.parse(del.details)).toEqual({ name: "Gone", schedules_deleted: 1, devices_cleared: [dev.id], groups_cleared: [gid] });
    const [rule] = await audits("device_schedule_delete");
    expect(rule.target_id).toBe(String(sid));
    expect(JSON.parse(rule.details)).toEqual({ device_id: dev.id, name: "night", cascade_from_playlist: pid });
  });
});

describe("items", () => {
  it("edit page 404s for unknown / non-integer ids", async () => {
    expect((await r.admin.get(`/playlists/${NOPE}`)).status).toBe(404);
    expect((await r.admin.get("/playlists/abc")).status).toBe(400);
  });

  it("add: validation 400/404/409, position appended, updated_at touched, audit", async () => {
    const pid = await playlist("Items");
    const ma = await media("a.png");
    const mb = await media("b.png");
    expect(await detail(await post(r.editor, `/playlists/${pid}/items`, { media_id: "abc" }), 400)).toBe("media_id must be an integer");
    expect(await detail(await post(r.editor, `/playlists/${pid}/items`, { media_id: "" }), 400)).toBe("media_id required");
    expect(await detail(await post(r.editor, `/playlists/${pid}/items`, { media_id: String(NOPE) }), 404)).toBe("Media not found");
    expect(await detail(await post(r.editor, `/playlists/${NOPE}/items`, { media_id: String(ma) }), 404)).toBe("Playlist not found");
    await query("UPDATE playlists SET updated_at = '2000-01-01 00:00:00' WHERE id = ?", pid);
    for (const m of [ma, mb]) {
      const res = await post(r.editor, `/playlists/${pid}/items`, { media_id: String(m) });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/playlists/${pid}`);
    }
    expect(await detail(await post(r.editor, `/playlists/${pid}/items`, { media_id: String(ma) }), 409)).toBe("Already in playlist");
    expect((await positions(pid)).map((x) => x.position)).toEqual([0, 1]);
    expect((await one("SELECT updated_at FROM playlists WHERE id = ?", pid)).updated_at).not.toBe("2000-01-01 00:00:00");
    expect((await audits("playlist_add_item"))[0]).toMatchObject({ target_id: String(pid), details: `{"media_id": ${mb}}` });
    const page = await (await r.editor.get(`/playlists/${pid}`)).text();
    expect(page).toContain("Playlist order (2)");
    expect(page).not.toContain("<option value=\"" + ma + "\">");
  });

  it("duration override: bad values 400 and unchanged, good values stored, 404 for a foreign item", async () => {
    for (const bad of ["inf", "Infinity", "+inf", "1e999", "nan", "-1", "0", "abc", "86401", "1e400"]) {
      const res = await post(r.editor, `/playlists/${w.pid}/items/${w.i1}/duration`, { duration: bad });
      await detail(res, 400);
      expect((await one("SELECT duration_override_seconds AS d FROM playlist_items WHERE id = ?", w.i1)).d).toBeNull();
    }
    for (const [v, expected] of [["7.5", 7.5], ["86400", 86400], ["0.5", 0.5], ["", null]]) {
      const res = await post(r.editor, `/playlists/${w.pid}/items/${w.i1}/duration`, { duration: v });
      expect(res.status, v).toBe(303);
      expect((await one("SELECT duration_override_seconds AS d FROM playlist_items WHERE id = ?", w.i1)).d).toBe(expected);
    }
    expect(await detail(await post(r.editor, `/playlists/${w.pid}/items/${NOPE}/duration`, { duration: "5" }), 404)).toBe("Playlist item not found");
    const other = await playlist("Other");
    expect((await post(r.editor, `/playlists/${other}/items/${w.i1}/duration`, { duration: "5" })).status).toBe(404);
    expect((await audits("playlist_set_duration"))[0]).toMatchObject({ target_type: "playlist_item", target_id: String(w.i1) });
  });

  it("reorder: JSON shape errors 400, wrong set 400, then reorders and audits", async () => {
    const pid = await playlist("Order");
    const items = [];
    for (const m of [w.m1, w.m2, w.m3]) {
      items.push(await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, ?)", pid, m, items.length));
    }
    for (const raw of ["notjson", "[1, 2]", "null", '"str"', "42", ""]) {
      const res = await r.editor.fetch(`/playlists/${pid}/items/reorder`, {
        method: "POST", body: raw, headers: { "content-type": "application/json", "X-CSRF-Token": r.editor.token },
      });
      expect(await detail(res, 400), raw).toBe("body must be a JSON object");
    }
    expect(await detail(await postJson(r.editor, `/playlists/${pid}/items/reorder`, { order: "x" }), 400)).toBe("body must be {order: [item_id, ...]}");
    expect(await detail(await postJson(r.editor, `/playlists/${pid}/items/reorder`, { order: [1, "a"] }), 400)).toBe("order must be a list of integers");
    // numeric strings are not integers either (parity with the Python CMS)
    expect(await detail(await postJson(r.editor, `/playlists/${pid}/items/reorder`, { order: items.map(String) }), 400)).toBe("order must be a list of integers");
    expect(await detail(await postJson(r.editor, `/playlists/${pid}/items/reorder`, { order: [items[0]] }), 400)).toBe("order must contain exactly the current items of this playlist");
    expect(await detail(await postJson(r.editor, `/playlists/${pid}/items/reorder`, { order: [items[0], items[0], items[1]] }), 400)).toBe("order must contain exactly the current items of this playlist");
    expect(await detail(await postJson(r.editor, `/playlists/${pid}/items/reorder`, { nope: 1 }), 400)).toBe("body must be {order: [item_id, ...]}");
    expect(await detail(await postJson(r.editor, `/playlists/${NOPE}/items/reorder`, { order: [] }), 404)).toBe("Playlist not found");
    const res = await postJson(r.editor, `/playlists/${pid}/items/reorder`, { order: [items[2], items[0], items[1]] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await positions(pid)).toEqual([{ id: items[2], position: 0 }, { id: items[0], position: 1 }, { id: items[1], position: 2 }]);
    expect((await audits("playlist_reorder"))[0].details).toBe(`{"order": [${items[2]}, ${items[0]}, ${items[1]}]}`);
    // no CSRF header -> 403 and nothing changes
    const noCsrf = await r.editor.postJson(`/playlists/${pid}/items/reorder`, { order: [items[0], items[1], items[2]] });
    expect(noCsrf.status).toBe(403);
    expect((await positions(pid))[0].id).toBe(items[2]);
  });

  it("remove renumbers the rest and 404s for missing / foreign items", async () => {
    const pid = await playlist("Remove");
    const items = [];
    for (const m of [w.m1, w.m2, w.m3]) {
      items.push(await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, ?)", pid, m, items.length * 5));
    }
    // a mis-click must not drop an item from every projector: the Remove form asks first (L30)
    expect(await (await r.editor.get(`/playlists/${pid}`)).text()).toContain(`action="/playlists/${pid}/items/${items[0]}/delete" class="inline" data-confirm="Remove one.png from Remove? Projectors playing it skip it from their next sync."`);
    expect(await detail(await post(r.editor, `/playlists/${pid}/items/${NOPE}/delete`), 404)).toBe("Playlist item not found");
    expect((await post(r.editor, `/playlists/${w.pid}/items/${items[0]}/delete`)).status).toBe(404);
    const res = await post(r.editor, `/playlists/${pid}/items/${items[1]}/delete`);
    expect(res.status).toBe(303);
    expect(await positions(pid)).toEqual([{ id: items[0], position: 0 }, { id: items[2], position: 1 }]);
    expect((await audits("playlist_remove_item"))[0]).toMatchObject({ target_type: "playlist_item", target_id: String(items[1]) });
  });
});
