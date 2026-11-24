// Recently deleted (migration 0019, src/pages/library.js): a Library delete moves the files to
// media_trash with their playlist places and keeps their R2 objects; Restore puts them back with
// their ids, places and times; Empty and the daily purge remove the rows and the objects, unless a
// live row or a trash row that stays holds the same filename; deleting an account removes its
// trashed objects too (accounts.mediaKeys). Each account sees and restores only its own.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index.js";
import { housekeeping, MAX_DELETE, mergePlaces, PURGE_MAX, TRASH_DAYS } from "../src/pages/library.js";
import { BASE, Client, query } from "./helpers.js";
import { audits, ins, media, one, playlist, post, roles } from "./pages_common.js";

let r;
beforeAll(async () => {
  r = await roles();
});

// A file of the roles() editor (or of `owner`) with its object and its preview in R2.
async function file(name, owner) {
  const id = await media(name, "image", owner === undefined ? {} : { owner });
  const { filename, sha256 } = await one("SELECT filename, sha256 FROM media WHERE id = ?", id);
  await env.MEDIA.put(`media/${filename}`, new Uint8Array([1, 2, 3]));
  await env.MEDIA.put(`thumbs/${filename}.jpg`, new Uint8Array([0xff, 0xd8, 0xff]));
  return { id, filename, sha256, name };
}
// [file object there, preview there]
const inR2 = async (f) => [!!(await env.MEDIA.head(`media/${f.filename}`)), !!(await env.MEDIA.head(`thumbs/${f.filename}.jpg`))];
const fill = async (pid, files, overrides = {}) => {
  for (const [i, f] of files.entries()) {
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position, duration_override_seconds) VALUES (?, ?, ?, ?)", pid, f.id, i, overrides[f.name] ?? null);
  }
};
const order = (pid) => query("SELECT media_id, position, duration_override_seconds AS o FROM playlist_items WHERE playlist_id = ? ORDER BY position, id", pid);
const trashed = (f) => one("SELECT * FROM media_trash WHERE media_id = ?", f.id);
const placesOf = async (f) => JSON.parse((await trashed(f)).places).sort((a, b) => a.playlist_id - b.playlist_id);
const del = (c, files) => post(c, "/library/delete", files.map((f) => ["media_id", String(f.id)]));
const restore = (c, ids) => post(c, "/library/trash/restore", ids.map((id) => ["trash_id", String(id)]));
const trashIds = async (files) => (await query(`SELECT id FROM media_trash WHERE media_id IN (${files.map((f) => f.id).join(",")}) ORDER BY id`)).map((t) => t.id);
// [kind, message] of the notice the next Library page shows.
async function flash(c) {
  const m = /<div class="alert ([a-z]+)" role="alert">([^<]*)<\/div>/.exec(await (await c.get("/library")).text());
  return m ? [m[1], m[2]] : null;
}
// A request straight to the worker with some bindings swapped (an R2 that fails or counts).
const direct = (c, path, pairs, bindings) => worker.fetch(new Request(BASE + path, {
  method: "POST", body: new URLSearchParams([["csrf_token", c.token], ...pairs]),
  headers: { "content-type": "application/x-www-form-urlencoded", cookie: c.cookie },
}), { ...env, ...bindings }, createExecutionContext());
// A new signed-in editor account of its own (made on the Users page).
async function account(username) {
  expect((await post(r.admin, "/users", { username, password: `${username}-pass`, role: "editor" })).status).toBe(303);
  const c = new Client();
  expect((await c.login(username, `${username}-pass`)).status).toBe(303);
  c.token = await c.csrf("/dashboard");
  c.id = (await one("SELECT id FROM users WHERE username = ?", username)).id;
  return c;
}

describe("delete", () => {
  it("moves the files to Recently deleted with their places and times; the rows go, the objects stay, the playlists close up", async () => {
    const [a, b, c] = [await file("d-a.png"), await file("d-b.png"), await file("d-c.png")];
    const p = await playlist("del P"), q = await playlist("del Q");
    await fill(p, [a, b, c], { "d-b.png": 7.5 });
    await fill(q, [c, b]);
    const row = await one("SELECT * FROM media WHERE id = ?", b.id);
    expect((await post(r.editor, "/library/delete", [["one", String(b.id)]])).status).toBe(303);
    expect(await flash(r.editor)).toEqual(["ok", "Moved d-b.png to Recently deleted."]);
    expect(await one("SELECT id FROM media WHERE id = ?", b.id)).toBeNull();
    const t = await trashed(b);
    expect(t).toMatchObject({
      owner_id: r.ids.editor, media_id: b.id, filename: row.filename, original_name: "d-b.png", media_type: row.media_type,
      size_bytes: row.size_bytes, duration_seconds: row.duration_seconds, width: row.width, height: row.height, codec: row.codec,
      sha256: row.sha256, uploaded_at: row.uploaded_at,
    });
    expect(t.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(await placesOf(b)).toEqual([{ playlist_id: p, position: 1, override: 7.5 }, { playlist_id: q, position: 1, override: null }]);
    expect(await inR2(b)).toEqual([true, true]);
    expect(await order(p)).toEqual([{ media_id: a.id, position: 0, o: null }, { media_id: c.id, position: 1, o: null }]);
    expect(await order(q)).toEqual([{ media_id: c.id, position: 0, o: null }]);
    // a file in no playlist keeps an empty list; another account's id is skipped like a missing one
    const lone = await file("d-lone.png");
    const theirs = await file("d-theirs.png", r.ids.admin);
    expect((await del(r.editor, [lone, theirs])).status).toBe(303);
    expect(JSON.parse((await trashed(lone)).places)).toEqual([]);
    expect(await trashed(theirs)).toBeNull();
    expect(await one("SELECT id FROM media WHERE id = ?", theirs.id)).toEqual({ id: theirs.id });
  });
});

describe("restore", () => {
  it("a delete of two files across two playlists comes back with the same ids, times, places, order and times on screen", async () => {
    const f = {};
    for (const n of ["a", "x", "b", "y", "c", "d"]) f[n] = await file(`r-${n}.png`);
    const p = await playlist("rest P"), q = await playlist("rest Q");
    await fill(p, [f.a, f.x, f.b, f.y, f.c], { "r-x.png": 7.5 });
    await fill(q, [f.y, f.d, f.x], { "r-y.png": 12 });
    const rows = await query("SELECT * FROM media WHERE id IN (?, ?) ORDER BY id", f.x.id, f.y.id);
    const before = [await order(p), await order(q)];
    expect((await del(r.editor, [f.x, f.y])).status).toBe(303);
    expect(await order(p)).toEqual([f.a, f.b, f.c].map((m, i) => ({ media_id: m.id, position: i, o: null })));
    const ids = await trashIds([f.x, f.y]);
    expect(ids.length).toBe(2);
    await query("UPDATE playlists SET updated_at = '2000-01-01 00:00:00' WHERE id IN (?, ?)", p, q);

    const res = await restore(r.editor, ids);
    expect([res.status, res.headers.get("location")]).toEqual([303, "/library"]);
    expect(await flash(r.editor)).toEqual(["ok", "Restored 2 files."]);
    expect(await query("SELECT * FROM media WHERE id IN (?, ?) ORDER BY id", f.x.id, f.y.id)).toEqual(rows);
    expect([await order(p), await order(q)]).toEqual(before);
    expect(await trashIds([f.x, f.y])).toEqual([]);
    expect(await inR2(f.x)).toEqual([true, true]);
    const audited = (await audits("restore_media")).slice(0, 2).map((a) => [Number(a.target_id), JSON.parse(a.details)]).sort((m, n) => m[0] - n[0]);
    expect(audited).toEqual([[f.x.id, { filename: "r-x.png", playlists: [p, q] }], [f.y.id, { filename: "r-y.png", playlists: [p, q] }]]);
    // a playlist that took a file back has changed (what the playlist pages show)
    expect(await query("SELECT id FROM playlists WHERE id IN (?, ?) AND updated_at = '2000-01-01 00:00:00'", p, q)).toEqual([]);
  });

  it("files deleted one at a time come back in their old order when restored together", async () => {
    const f = {};
    for (const n of ["a", "x", "b", "y", "c"]) f[n] = await file(`o-${n}.png`);
    const p = await playlist("one by one");
    await fill(p, [f.a, f.x, f.b, f.y, f.c]);
    const before = await order(p);
    expect((await del(r.editor, [f.x])).status).toBe(303);
    // the first delete a minute earlier: deletes are told apart by their time
    await query("UPDATE media_trash SET deleted_at = datetime(deleted_at, '-1 minute') WHERE media_id = ?", f.x.id);
    expect((await del(r.editor, [f.y])).status).toBe(303);
    expect(await placesOf(f.x)).toEqual([{ playlist_id: p, position: 1, override: null }]);
    expect(await placesOf(f.y)).toEqual([{ playlist_id: p, position: 2, override: null }]); // in the playlist without x
    expect((await restore(r.editor, await trashIds([f.x, f.y]))).status).toBe(303);
    expect(await order(p)).toEqual(before);
  });

  it("a file whose bytes are back in the library (uploaded again) stays in Recently deleted with a warning", async () => {
    const e = await file("u-e.png"), g = await file("u-g.png"), h = await file("u-h.png");
    expect((await del(r.editor, [e, g, h])).status).toBe(303);
    // e again under another name, g again under its own (the same name: the same file name and key)
    await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id) VALUES ('again-e.png', 'again e.png', 'image', 3, ?, ?)", e.sha256, r.ids.editor);
    await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id) VALUES (?, 'u-g.png', 'image', 3, ?, ?)", g.filename, g.sha256, r.ids.editor);
    const [te, tg, th] = [(await trashed(e)).id, (await trashed(g)).id, (await trashed(h)).id];
    expect((await restore(r.editor, [te])).status).toBe(303);
    expect(await flash(r.editor)).toEqual(["warn", "u-e.png is already back in the library."]);
    expect((await restore(r.editor, [te, tg])).status).toBe(303);
    expect(await flash(r.editor)).toEqual(["warn", "Those files are already back in the library."]);
    expect((await restore(r.editor, [te, tg, th])).status).toBe(303);
    expect(await flash(r.editor)).toEqual(["warn", "Restored u-h.png; 2 are already back in the library."]);
    expect(await one("SELECT id FROM media WHERE id = ?", h.id)).toEqual({ id: h.id });
    expect((await query(`SELECT id FROM media_trash WHERE id IN (${te}, ${tg}, ${th}) ORDER BY id`)).map((t) => t.id)).toEqual([te, tg]);
    expect(await one("SELECT COUNT(*) AS n FROM media WHERE id IN (?, ?)", e.id, g.id)).toEqual({ n: 0 });
  });

  it("a playlist deleted meanwhile is skipped: the file goes back into the ones that are left", async () => {
    const a = await file("pg-a.png"), g = await file("pg-g.png");
    const p = await playlist("kept P"), q = await playlist("gone Q");
    await fill(p, [a, g]);
    await fill(q, [g]);
    expect((await del(r.editor, [g])).status).toBe(303);
    expect((await post(r.editor, `/playlists/${q}/delete`)).status).toBe(303);
    expect((await restore(r.editor, await trashIds([g]))).status).toBe(303);
    expect(await flash(r.editor)).toEqual(["ok", "Restored pg-g.png."]);
    expect(await order(p)).toEqual([{ media_id: a.id, position: 0, o: null }, { media_id: g.id, position: 1, o: null }]);
    expect(await query("SELECT playlist_id FROM playlist_items WHERE media_id = ?", g.id)).toEqual([{ playlist_id: p }]);
    expect(JSON.parse((await audits("restore_media"))[0].details)).toEqual({ filename: "pg-g.png", playlists: [p] });
  });

  it("a playlist with gaps in its positions (migration 0006 left some) gets the file back at its index, not its old number", async () => {
    const f = {};
    for (const n of ["a", "x", "b"]) f[n] = await file(`gap-${n}.png`);
    const p = await playlist("gapped");
    for (const [m, position] of [[f.a, 0], [f.x, 10], [f.b, 20]]) await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, ?)", p, m.id, position);
    expect((await del(r.editor, [f.x])).status).toBe(303);
    expect(await placesOf(f.x)).toEqual([{ playlist_id: p, position: 1, override: null }]);
    expect((await restore(r.editor, await trashIds([f.x]))).status).toBe(303);
    expect(await order(p)).toEqual([f.a, f.x, f.b].map((m, i) => ({ media_id: m.id, position: i, o: null })));
  });

  it("a place past the end of a playlist that shrank since goes at its end", async () => {
    const f = {};
    for (const n of ["a", "b", "c", "z"]) f[n] = await file(`end-${n}.png`);
    const p = await playlist("shrunk");
    await fill(p, [f.a, f.b, f.c, f.z]);
    expect((await del(r.editor, [f.z])).status).toBe(303);
    expect((await post(r.editor, `/playlists/${p}/items/${(await one("SELECT id FROM playlist_items WHERE media_id = ?", f.b.id)).id}/delete`)).status).toBe(303);
    expect((await restore(r.editor, await trashIds([f.z]))).status).toBe(303);
    expect(await order(p)).toEqual([f.a, f.c, f.z].map((m, i) => ({ media_id: m.id, position: i, o: null })));
  });

  it("only the caller's own rows, at most MAX_DELETE, for editors: another account's id answers like a missing one", async () => {
    const mine = await file("own-m.png"), theirs = await file("own-t.png", r.ids.admin);
    expect((await del(r.editor, [mine])).status).toBe(303);
    expect((await del(r.admin, [theirs])).status).toBe(303);
    const [tm, tt] = [(await trashed(mine)).id, (await trashed(theirs)).id];
    expect((await restore(r.editor, [tt])).status).toBe(303);
    expect(await flash(r.editor)).toEqual(["warn", "Those files are no longer in Recently deleted."]);
    expect(await one("SELECT id FROM media WHERE id = ?", theirs.id)).toBeNull();
    expect(await one("SELECT owner_id FROM media_trash WHERE id = ?", tt)).toEqual({ owner_id: r.ids.admin });
    expect((await restore(r.viewer, [tm])).status).toBe(403);
    expect((await restore(r.editor, ["abc"])).status).toBe(400);
    expect((await restore(r.editor, Array.from({ length: MAX_DELETE + 1 }, (_, i) => 900000 + i))).status).toBe(400);
    expect((await restore(r.editor, [])).status).toBe(303);
    expect(await flash(r.editor)).toEqual(["warn", "Nothing was ticked."]);
    expect(await one("SELECT id FROM media WHERE id = ?", mine.id)).toBeNull();
    // the same form sent twice (a double click): the second finds nothing to do
    expect((await restore(r.editor, [tm, tm])).status).toBe(303);
    expect(await flash(r.editor)).toEqual(["ok", "Restored own-m.png."]);
    expect((await restore(r.editor, [tm])).status).toBe(303);
    expect(await flash(r.editor)).toEqual(["warn", "Those files are no longer in Recently deleted."]);
    expect(await one("SELECT COUNT(*) AS n FROM media WHERE id = ?", mine.id)).toEqual({ n: 1 });
  });
});

describe("where a place goes back (mergePlaces)", () => {
  const item = (id, position) => ({ id, position });
  const place = (media_id, position, deleted_at = "2026-11-01 10:00:00", override = null) => ({ media_id, position, override, deleted_at });

  it("one delete: each place at its index, in playlist order; only the items after it move", () => {
    // [a, X, b, Y, c] lost X and Y in one delete: [a, b, c]
    expect(mergePlaces([item(1, 0), item(2, 1), item(3, 2)], [place(91, 3), place(90, 1, undefined, 7.5)]))
      .toEqual({ moves: [[2, 2], [3, 4]], adds: [[90, 1, 7.5], [91, 3, null]] });
  });

  it("several deletes: the newest goes back first, so the older indexes land where they were", () => {
    // X deleted from [a, X, b, Y, c] (index 1), then Y from [a, b, Y, c] (index 2)
    const merged = mergePlaces([item(1, 0), item(2, 1), item(3, 2)], [place(90, 1, "2026-11-01 10:00:00"), place(91, 2, "2026-11-01 10:05:00")]);
    expect(merged.adds).toEqual([[90, 1, null], [91, 3, null]]);
    expect(merged.moves).toEqual([[2, 2], [3, 4]]);
  });

  it("an index past the end goes at the end; an empty playlist takes it at 0", () => {
    expect(mergePlaces([item(1, 0)], [place(90, 9)])).toEqual({ moves: [], adds: [[90, 1, null]] });
    expect(mergePlaces([], [place(90, 4), place(91, 2)])).toEqual({ moves: [], adds: [[91, 0, null], [90, 1, null]] });
  });
});

describe("empty", () => {
  it("removes the caller's rows and their objects, except a filename a live row holds; the other account's stay; audited", async () => {
    const c = await account("emptier");
    const plain = await file("e-plain.png", c.id), back = await file("e-back.png", c.id), twice = await file("e-twice.png", c.id);
    const other = await file("e-other.png", r.ids.admin);
    expect((await del(c, [plain, back, twice])).status).toBe(303);
    expect((await del(r.admin, [other])).status).toBe(303);
    // back: uploaded again under its own name (the same key); twice: uploaded again and deleted again
    await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id) VALUES (?, 'e-back.png', 'image', 3, ?, ?)", back.filename, back.sha256, c.id);
    const again = await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id) VALUES (?, 'e-twice.png', 'image', 3, ?, ?)", twice.filename, twice.sha256, c.id);
    expect((await post(c, `/library/${again}/delete`)).status).toBe(303);
    expect((await one("SELECT COUNT(*) AS n FROM media_trash WHERE owner_id = ?", c.id)).n).toBe(4);
    const page = await (await c.get("/library")).text();
    expect(page).toContain('formaction="/library/trash/empty" data-confirm="Delete 4 files for good?">Empty</button>');

    expect((await post(c, "/library/trash/empty")).status).toBe(303);
    expect(await flash(c)).toEqual(["ok", "Deleted 4 files for good."]);
    expect(await query("SELECT id FROM media_trash WHERE owner_id = ?", c.id)).toEqual([]);
    expect(await inR2(plain)).toEqual([false, false]);
    expect(await inR2(twice)).toEqual([false, false]); // both its rows went, nothing holds it
    expect(await inR2(back)).toEqual([true, true]); // the live row's bytes
    expect(await inR2(other)).toEqual([true, true]);
    expect(await one("SELECT owner_id FROM media_trash WHERE media_id = ?", other.id)).toEqual({ owner_id: r.ids.admin });
    const [a] = await audits("empty_trash");
    expect([a.username, a.details]).toEqual(["emptier", '{"files": 4}']);
    expect((await post(c, "/library/trash/empty")).status).toBe(303);
    expect(await flash(c)).toEqual(["warn", "Recently deleted is empty."]);
    expect((await post(r.viewer, "/library/trash/empty")).status).toBe(403);
  });

  it("an R2 error is logged: the rows are gone either way", async () => {
    const c = await account("r2down");
    const f = await file("down.png", c.id);
    expect((await del(c, [f])).status).toBe(303);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await direct(c, "/library/trash/empty", [], { MEDIA: { delete: async () => { throw new Error("R2 is down"); } } });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/library"]);
    expect(await trashed(f)).toBeNull();
    expect(JSON.parse((await audits("empty_trash"))[0].details)).toEqual({ files: 1 });
    expect(errors).toHaveBeenCalledWith(`R2 delete failed for 2 object(s) from media/${f.filename}:`, expect.stringContaining("R2 is down"));
    errors.mockRestore();
  });

  it("takes PURGE_MAX rows a press, oldest first, 1000 R2 keys a call; the page lists the newest MAX_DELETE", async () => {
    const c = await account("bulk");
    await query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
      INSERT INTO media_trash (owner_id, media_id, filename, original_name, media_type, size_bytes, sha256, uploaded_at, places, deleted_at)
      SELECT ?1, 800000 + i, 'bulk-' || i || '.png', 'bulk-' || i || '.png', 'image', 1, printf('%064d', i), datetime('now'), '[]',
             datetime('now', '-' || (5000 - i) || ' seconds') FROM n`, c.id, PURGE_MAX + 1);
    const page = await (await c.get("/library")).text();
    expect(page).toContain(`<summary>Recently deleted (${PURGE_MAX + 1})</summary>`);
    expect(page.match(/name="trash_id"/g).length).toBe(MAX_DELETE);
    expect(page).toContain(`data-confirm="Delete ${PURGE_MAX} files for good?"`);
    expect(page).toContain(`>bulk-${PURGE_MAX + 1}.png</label>`); // the newest first
    const calls = [];
    const res = await direct(c, "/library/trash/empty", [], { MEDIA: { delete: async (keys) => { calls.push(keys); } } });
    expect(res.status).toBe(303);
    expect(calls.map((k) => k.length)).toEqual([1000, 1000]);
    const keys = new Set(calls.flat());
    expect([keys.size, keys.has("media/bulk-1.png"), keys.has(`thumbs/bulk-${PURGE_MAX}.png.jpg`), keys.has(`media/bulk-${PURGE_MAX + 1}.png`)]).toEqual([2000, true, true, false]);
    expect(await query("SELECT filename FROM media_trash WHERE owner_id = ?", c.id)).toEqual([{ filename: `bulk-${PURGE_MAX + 1}.png` }]);
  });
});

describe("daily purge", () => {
  it("the daily cron removes what was deleted more than TRASH_DAYS ago with its objects, unless a newer row holds the name", async () => {
    const c = await account("purged");
    const old = await file("p-old.png", c.id), fresh = await file("p-fresh.png", c.id), name = await file("p-name.png", c.id);
    expect((await del(c, [old, fresh, name])).status).toBe(303);
    // p-name.png uploaded again under its own name, and deleted again a day ago
    const again = await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id) VALUES (?, 'p-name.png', 'image', 3, ?, ?)", name.filename, name.sha256, c.id);
    expect((await post(c, `/library/${again}/delete`)).status).toBe(303);
    const age = (id, days) => query(`UPDATE media_trash SET deleted_at = datetime('now', '-${days} days') WHERE media_id = ?`, id);
    await age(old.id, TRASH_DAYS + 1);
    await age(name.id, TRASH_DAYS + 1);
    await age(fresh.id, TRASH_DAYS - 1);
    await age(again, 1);
    await worker.scheduled(createScheduledController({ cron: "0 3 * * *" }), env, createExecutionContext());
    expect((await query("SELECT media_id FROM media_trash WHERE owner_id = ? ORDER BY media_id", c.id)).map((t) => t.media_id)).toEqual([fresh.id, again]);
    expect(await inR2(old)).toEqual([false, false]);
    expect(await inR2(fresh)).toEqual([true, true]);
    expect(await inR2(name)).toEqual([true, true]); // the newer row still needs it
    expect(await housekeeping(env)).toBe(0);
    await age(again, TRASH_DAYS + 2);
    expect(await housekeeping(env)).toBe(1);
    expect(await inR2(name)).toEqual([false, false]);
  });
});

describe("deleting an account", () => {
  it("removes the objects of its Recently deleted as well as its library's", async () => {
    const c = await account("leaver");
    const live = await file("l-live.png", c.id), gone = await file("l-gone.png", c.id);
    expect((await del(c, [gone])).status).toBe(303);
    expect((await post(r.admin, `/users/${c.id}/delete`)).status).toBe(303);
    expect(await inR2(live)).toEqual([false, false]);
    expect(await inR2(gone)).toEqual([false, false]);
    expect(await query("SELECT id FROM media_trash WHERE owner_id = ?", c.id)).toEqual([]);
    expect((await audits("user_delete"))[0].details).toBe('{"media_deleted": 2}');
  });
});

describe("library page", () => {
  it("Recently deleted sits below the grid for editors: name, time, tick boxes, Restore selected, Empty; nothing for viewers or when empty", async () => {
    const c = await account("pager");
    expect(await (await c.get("/library")).text()).not.toContain('<details class="trash">');
    const keep = await file("k-keep.png", c.id), x = await file("k-<b>x</b>.png", c.id);
    expect((await del(c, [x])).status).toBe(303);
    const t = await trashed(x);
    let html = await (await c.get("/library")).text();
    expect(html).toContain('<details class="trash">\n  <summary>Recently deleted (1)</summary>');
    expect(html).toMatch(/<form method="post" action="\/library\/trash\/restore" autocomplete="off">\s*<input type="hidden" name="csrf_token" value="[^"]+">/);
    expect(html).toMatch(new RegExp(`<li><label class="inline-check"><input type="checkbox" name="trash_id" value="${t.id}">k-&lt;b&gt;x&lt;/b&gt;.png</label><span class="media-meta">\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC</span></li>`));
    expect(html).toContain('<button type="submit" class="small">Restore selected</button>\n      <button type="submit" class="danger small" formaction="/library/trash/empty" data-confirm="Delete 1 file for good?">Empty</button>');
    expect(html.indexOf('<details class="trash">')).toBeGreaterThan(html.indexOf("</form>", html.indexOf('id="library-form"')));
    expect(html).toContain(`value="${keep.id}"`);
    // everything deleted: the empty grid, then Recently deleted
    expect((await del(c, [keep])).status).toBe(303);
    html = await (await c.get("/library")).text();
    expect(html.indexOf('<span class="empty-title">NO MEDIA</span>')).toBeLessThan(html.indexOf("<summary>Recently deleted (2)</summary>"));
    // a viewer restores nothing, so sees nothing of it (even with rows of its own)
    await ins(`INSERT INTO media_trash (owner_id, media_id, filename, original_name, media_type, size_bytes, sha256, uploaded_at, places)
      VALUES (?, 700001, 'vw-x.png', 'vw-x.png', 'image', 1, ?, datetime('now'), '[]')`, r.ids.viewer, "7".repeat(64));
    expect(await (await r.viewer.get("/library")).text()).not.toContain("Recently deleted");
  });
});

describe("costs on the Workers Free plan", () => {
  // Every D1 batch of a request, with the rows it read and wrote (meta.rows_read / rows_written).
  function metered() {
    const log = [];
    const DB = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (stmts) => {
        const res = await env.DB.batch(stmts);
        log.push({ read: res.reduce((n, x) => n + x.meta.rows_read, 0), written: res.reduce((n, x) => n + x.meta.rows_written, 0) });
        return res;
      },
    };
    return { DB, log };
  }

  it("300 files out of a 500-item playlist: one batch to delete (plus the audit rows), one to restore, no per-place shifting", async () => {
    const c = await account("costly");
    await query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
      INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id)
      SELECT 'cost-' || i || '.png', 'cost-' || i || '.png', 'image', 1, printf('%064d', 1000 + i), ? FROM n`, c.id);
    const ids = (await query("SELECT id FROM media WHERE owner_id = ? ORDER BY id", c.id)).map((m) => m.id);
    const big = await playlist("big", c.id), small = await playlist("small", c.id);
    await query("INSERT INTO playlist_items (playlist_id, media_id, position) SELECT ?, value, key FROM json_each(?)", big, JSON.stringify(ids.slice(0, 500)));
    await query("INSERT INTO playlist_items (playlist_id, media_id, position, duration_override_seconds) SELECT ?, value, key, 7.5 FROM json_each(?)", small, JSON.stringify(ids.slice(450, 550)));
    const both = () => query("SELECT playlist_id, media_id, position, duration_override_seconds FROM playlist_items WHERE playlist_id IN (?, ?) ORDER BY playlist_id, position", big, small);
    const before = await both();
    const victims = ids.filter((_, i) => i % 2 === 0); // 250 of big's, 50 of small's
    const d = metered();
    expect((await direct(c, "/library/delete", victims.map((v) => ["media_id", String(v)]), { DB: d.DB })).status).toBe(303);
    expect(d.log.length).toBe(2); // the move, then the 300 audit rows
    expect(d.log[0].read).toBeLessThan(20000);
    expect(d.log[0].written).toBeLessThan(4000);
    const rest = metered();
    const trash = (await query("SELECT id FROM media_trash WHERE owner_id = ?", c.id)).map((t) => ["trash_id", String(t.id)]);
    expect((await direct(c, "/library/trash/restore", trash, { DB: rest.DB })).status).toBe(303);
    expect(rest.log.length).toBe(1);
    expect(rest.log[0].read).toBeLessThan(20000);
    expect(rest.log[0].written).toBeLessThan(6000); // shifting each place by UPDATE ... + 1 wrote ~75,000
    expect(await both()).toEqual(before);
  });
});
