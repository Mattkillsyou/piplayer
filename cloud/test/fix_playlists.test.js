// The playlist editor and list after the release review: Nothing to add's Library link keeps the
// playlist it came from (?to=), Add takes at most MAX_DELETE files a request, Remove selected
// takes the ticked rows out in one go, and the Default's Used by counts the projectors it is the
// fallback of. The fixtures are the editor's (pages_common).
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { audits, defaultPlaylistOf, detail, device, group, ins, media, NOPE, one, playlist, post, roles } from "./pages_common.js";

let r;

const positions = (pid) => query("SELECT id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position, id", pid);
const updatedAt = async (pid) => (await one("SELECT updated_at FROM playlists WHERE id = ?", pid)).updated_at;
const age = (pid) => query("UPDATE playlists SET updated_at = '2000-01-01 00:00:00' WHERE id = ?", pid);
// [kind, message] of the notice the next page shows (and clears).
const flash = async (c, path) => /<div class="alert ([a-z]+)" role="alert">([^<]*)<\/div>/.exec(await (await c.get(path)).text())?.slice(1);
const ticked = (ids) => ids.map((id) => ["item_id", String(id)]);

// A playlist of `n` files, its items on positions 0, 5, 10, ... (a gap a removal must close).
async function filled(name, n) {
  const pid = await playlist(name);
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push(await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, ?)", pid, await media(`${name}-${i}.png`), i * 5));
  }
  return { pid, items };
}

beforeAll(async () => {
  r = await roles();
});

describe("Nothing to add", () => {
  it("links to the Library with this playlist picked, for an empty library and for a playlist holding every file", async () => {
    const pid = await playlist("Fresh");
    const link = `<p class="help small">Nothing to add. <a href="/library?to=${pid}">Library</a>.</p>`;
    expect(await (await r.editor.get(`/playlists/${pid}`)).text()).toContain(link); // no files yet
    const m = await media("only.png");
    expect(await (await r.editor.get(`/playlists/${pid}`)).text()).not.toContain("Nothing to add");
    expect((await post(r.editor, `/playlists/${pid}/items`, { media_id: String(m) })).status).toBe(303);
    expect(await (await r.editor.get(`/playlists/${pid}`)).text()).toContain(link); // it holds every file
  });
});

describe("Add", () => {
  it("takes at most 500 files a request, as the Library's Add to playlist", async () => {
    const pid = await playlist("Capped");
    const m = await media("capped.png");
    const ids = (n) => [["media_id", String(m)], ...Array.from({ length: n - 1 }, (_, i) => ["media_id", String(900000 + i)])];
    expect(await detail(await post(r.editor, `/playlists/${pid}/items`, ids(501)), 400)).toBe("Add at most 500 files at a time");
    expect(await query("SELECT media_id FROM playlist_items WHERE playlist_id = ?", pid)).toEqual([]);
    expect((await post(r.editor, `/playlists/${pid}/items`, ids(500))).status).toBe(303);
    expect(await query("SELECT media_id FROM playlist_items WHERE playlist_id = ?", pid)).toEqual([{ media_id: m }]);
  });
});

describe("Remove selected", () => {
  it("gives each row a tick box that joins the form under the table, for editors only", async () => {
    const { pid, items } = await filled("Ticks", 2);
    const page = await (await r.editor.get(`/playlists/${pid}`)).text();
    expect(page).toContain(`<input type="checkbox" name="item_id" value="${items[0]}" form="remove-items" aria-label="Select Ticks-0.png">Select</label>`);
    // its own form (a form cannot hold the rows' forms), the noop first: Enter on a tick box presses that one
    expect(page).toMatch(new RegExp(`</table>\\s*</div>\\s*<form method="post" action="/playlists/${pid}/items/delete" id="remove-items" class="action-buttons" autocomplete="off">\\s*<input type="hidden" name="csrf_token" value="[^"]+">\\s*<button type="submit" name="noop" value="1" hidden></button>\\s*<button type="submit" class="danger small" data-confirm="Remove the selected files from Ticks\\? Projectors playing it skip them from their next sync.">Remove selected</button>`));
    // the row's own Remove stays as it was
    expect(page).toContain(`action="/playlists/${pid}/items/${items[0]}/delete" class="inline" data-confirm="Remove Ticks-0.png from Ticks? Projectors playing it skip it from their next sync."`);
    const vpid = await playlist("Viewer's", r.ids.viewer);
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", vpid, await media("v.png", "image", { owner: r.ids.viewer }));
    const vpage = await (await r.viewer.get(`/playlists/${vpid}`)).text();
    for (const editorOnly of ['name="item_id"', "remove-items", "Remove selected"]) expect(vpage).not.toContain(editorOnly);
    expect((await post(r.viewer, `/playlists/${vpid}/items/delete`, ticked([1]))).status).toBe(403);
  });

  it("removes the ticked items in one go, closes the gaps in order, touches the playlist and audits", async () => {
    const { pid, items } = await filled("Trim", 5);
    await age(pid);
    const res = await post(r.editor, `/playlists/${pid}/items/delete`, ticked([items[3], items[0], items[3]]));
    expect([res.status, res.headers.get("location")]).toEqual([303, `/playlists/${pid}`]);
    expect(await flash(r.editor, `/playlists/${pid}`)).toEqual(["ok", "Removed 2 files from Trim."]);
    expect(await positions(pid)).toEqual([items[1], items[2], items[4]].map((id, position) => ({ id, position })));
    expect(await updatedAt(pid)).not.toBe("2000-01-01 00:00:00");
    expect(JSON.parse((await audits("playlist_remove_items"))[0].details)).toEqual({ item_ids: [items[3], items[0]], removed: 2 });
    // the files stay in the library
    expect(await one("SELECT COUNT(*) AS n FROM media WHERE original_name LIKE 'Trim-%'")).toEqual({ n: 5 });
    await post(r.editor, `/playlists/${pid}/items/delete`, ticked([items[4]]));
    expect(await flash(r.editor, `/playlists/${pid}`)).toEqual(["ok", "Removed 1 file from Trim."]);
  });

  it("Enter on a tick box (noop) and nothing ticked remove nothing", async () => {
    const { pid, items } = await filled("Kept", 2);
    await age(pid);
    const res = await post(r.editor, `/playlists/${pid}/items/delete`, [["noop", "1"], ...ticked(items)]);
    expect(res.status).toBe(204);
    let back = await post(r.editor, `/playlists/${pid}/items/delete`, {});
    expect([back.status, back.headers.get("location")]).toEqual([303, `/playlists/${pid}`]);
    expect(await flash(r.editor, `/playlists/${pid}`)).toEqual(["warn", "Nothing was ticked."]);
    expect((await positions(pid)).map((x) => x.id)).toEqual(items);
    expect(await updatedAt(pid)).toBe("2000-01-01 00:00:00");
  });

  it("skips what is not an item of this playlist, answers another account's playlist like a missing one, and caps a request", async () => {
    const { pid, items } = await filled("Mine", 2);
    const other = await filled("Other", 1); // the same account's other playlist
    const theirs = await playlist("Theirs", r.ids.admin);
    const theirItem = await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", theirs, await media("theirs.png", "image", { owner: r.ids.admin }));
    await age(pid);
    const res = await post(r.editor, `/playlists/${pid}/items/delete`, ticked([other.items[0], theirItem, NOPE]));
    expect([res.status, res.headers.get("location")]).toEqual([303, `/playlists/${pid}`]);
    expect(await flash(r.editor, `/playlists/${pid}`)).toEqual(["warn", "Nothing was removed: those files are no longer in this playlist."]);
    expect(await updatedAt(pid)).toBe("2000-01-01 00:00:00");
    for (const path of [`/playlists/${theirs}/items/delete`, `/playlists/${NOPE}/items/delete`]) {
      expect(await detail(await post(r.editor, path, ticked([theirItem])), 404)).toBe("Playlist not found");
    }
    expect((await positions(other.pid)).map((x) => x.id)).toEqual(other.items);
    expect((await positions(theirs)).map((x) => x.id)).toEqual([theirItem]);
    expect(await detail(await post(r.editor, `/playlists/${pid}/items/delete`, ticked(Array.from({ length: 501 }, (_, i) => items[0] + i))), 400)).toBe("Remove at most 500 files at a time");
    expect(await detail(await post(r.editor, `/playlists/${pid}/items/delete`, ticked(["abc"])), 400)).toBe("item_id: value is not a valid integer");
    expect((await positions(pid)).map((x) => x.id)).toEqual(items);
  });
});

describe("Used by", () => {
  // The text of the Used by cell in playlist `pid`'s row of /playlists.
  const usedBy = async (c, pid) => {
    const row = (await (await c.get("/playlists")).text()).split("<tr>").find((tr) => tr.includes(`<a href="/playlists/${pid}">`));
    return /<td data-label="Used by" class="muted">([^]*?)<\/td>/.exec(row)[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  };

  it("counts on the Default the projectors it is the fallback of, by the manifest's rules", async () => {
    const dflt = await defaultPlaylistOf(r.ids.editor);
    const lobby = await playlist("Used lobby");
    const bare = await group("Used bare group"); // no playlist
    const lobbyGroup = await group("Used lobby group");
    await query("UPDATE device_groups SET playlist_id = ? WHERE id = ?", lobby, lobbyGroup);
    expect(await usedBy(r.editor, dflt)).toBe("0 devices");
    const nothing = await device("used-nothing"); // falls back
    await device("used-own", "own", { playlist_id: lobby });
    await device("used-group", "group", { group_id: lobbyGroup });
    await device("used-bare", "bare", { group_id: bare }); // a group without a playlist: falls back
    const ruled = await device("used-rules"); // schedule rules only: falls back between them
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'r', 1)", ruled.id, lobby);
    await device("used-theirs", "theirs", { owner_id: r.ids.viewer });
    await device("used-ownerless", "ownerless", { owner_id: null }); // the site admin's
    expect(await usedBy(r.editor, dflt)).toBe("3 devices (fallback)");
    expect(await usedBy(r.editor, lobby)).toBe("1 device · 1 group · 1 schedule rule");
    await device("used-default", "default", { playlist_id: dflt });
    expect(await usedBy(r.editor, dflt)).toBe("1 device · 3 devices (fallback)");
    // another account's playlist (never written by the pages) reads as none, as on the projector
    const adminPl = await playlist("Used admin's", r.ids.admin);
    await query("UPDATE devices SET playlist_id = ? WHERE id = ?", adminPl, nothing.id);
    await query("UPDATE device_groups SET playlist_id = ? WHERE id = ?", adminPl, lobbyGroup);
    expect(await usedBy(r.editor, dflt)).toBe("1 device · 4 devices (fallback)");
    // each account counts its own projectors only
    expect(await usedBy(r.viewer, await defaultPlaylistOf(r.ids.viewer))).toBe("1 device (fallback)");
    expect(await usedBy(r.admin, await defaultPlaylistOf(r.ids.admin))).toBe("1 device (fallback)");
  });
});
