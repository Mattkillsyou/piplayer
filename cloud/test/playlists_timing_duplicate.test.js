// How long a playlist runs and Duplicate: manifest.playSeconds (each item's time as the player
// runs it), the editor's head and Duration column, the list's Duration, "Every picture" (POST
// /playlists/:id/pictures), a row's Set landing back on its row, POST /playlists/:id/duplicate,
// and the editor's phone rules in style.css (asserted as text: the stylesheet is served as is).
import { beforeAll, describe, expect, it } from "vitest";
import { playSeconds } from "../src/manifest.js";
import { query } from "./helpers.js";
import { audits, defaultPlaylistOf, detail, ins, media, NOPE, one, playlist, post, roleMatrix, roles, setting } from "./pages_common.js";

let r;

beforeAll(async () => {
  r = await roles();
});

const item = (pid, mid, position, override = null) => ins(
  "INSERT INTO playlist_items (playlist_id, media_id, position, duration_override_seconds) VALUES (?, ?, ?, ?)", pid, mid, position, override);
const page = (c, path) => c.get(path).then((res) => res.text());
// The editor's <tr> for one playlist item.
const rowOf = (html, id) => {
  const start = html.indexOf(`<tr id="item-${id}"`);
  return start < 0 ? "" : html.slice(start, html.indexOf("</tr>", start));
};
const overridesOf = (...ids) => Promise.all(ids.map(async (id) => (await one("SELECT duration_override_seconds AS d FROM playlist_items WHERE id = ?", id)).d));

describe("playSeconds", () => {
  const picture = { media_type: "image", filename: "1_a.png" };
  const video = { media_type: "video", filename: "2_b.mp4", duration_seconds: 12.5 };
  const gif = { media_type: "video", filename: "3_c.GIF", duration_seconds: 3 };

  it("a picture plays its override, else the account's default", () => {
    expect(playSeconds(picture, 10)).toBe(10);
    expect(playSeconds({ ...picture, duration_override_seconds: 7.5 }, 10)).toBe(7.5);
  });

  it("a video plays its own length; an override cuts it short but never stretches it", () => {
    expect(playSeconds(video, 10)).toBe(12.5);
    expect(playSeconds({ ...video, duration_override_seconds: 5 }, 10)).toBe(5);
    expect(playSeconds({ ...video, duration_override_seconds: 30 }, 10)).toBe(12.5);
  });

  it("an animated GIF loops until its override runs out", () => {
    expect(playSeconds(gif, 10)).toBe(3);
    expect(playSeconds({ ...gif, duration_override_seconds: 30 }, 10)).toBe(30);
    expect(playSeconds({ ...gif, duration_seconds: null, duration_override_seconds: 30 }, 10)).toBe(30);
  });

  it("a video nobody measured is unknown, override or not", () => {
    expect(playSeconds({ ...video, duration_seconds: null }, 10)).toBeNull();
    expect(playSeconds({ ...video, duration_seconds: null, duration_override_seconds: 5 }, 10)).toBeNull();
    expect(playSeconds({ ...gif, duration_seconds: null }, 10)).toBeNull();
  });
});

describe("running time on the pages", () => {
  it("editor: the head, each row's real time, row ids, the Add list's times", async () => {
    const pid = await playlist("Timed");
    const i1 = await item(pid, await media("pic.png"), 0);
    const i2 = await item(pid, await media("clip.mp4", "video", { duration: 12.5 }), 1);
    await media("long.mp4", "video", { duration: 65 }); // not in it: offered under Add media
    let html = await page(r.editor, `/playlists/${pid}`);
    expect(html).toContain('<span class="page-meta">2 items · 22.5 s</span>');
    expect(html).toContain('<th scope="col">Name</th><th scope="col">Duration</th><th scope="col">Override</th>');
    expect(html).not.toContain("Natural");
    expect(html).toContain(`<tr id="item-${i1}" data-item-id="${i1}">`);
    expect(rowOf(html, i1)).toContain('<td class="muted nowrap">10.0 s</td>');
    expect(rowOf(html, i2)).toContain('<td class="muted nowrap">12.5 s</td>');
    expect(html).toMatch(/\[VIDEO\] long\.mp4 \(1:05\)\n/);
    // an animated GIF the uploader's browser could not measure
    const i3 = await item(pid, await media("anim.gif", "video"), 2);
    html = await page(r.editor, `/playlists/${pid}`);
    expect(html).toContain('<span class="page-meta">3 items · at least 22.5 s</span>');
    expect(rowOf(html, i3)).toContain('<td class="muted nowrap">—</td>');
    // with an override it loops that long, and the total is known again
    await query("UPDATE playlist_items SET duration_override_seconds = 42.5 WHERE id = ?", i3);
    html = await page(r.editor, `/playlists/${pid}`);
    expect(html).toContain('<span class="page-meta">3 items · 1:05</span>');
    expect(rowOf(html, i3)).toContain('<td class="muted nowrap">42.5 s</td>');
  });

  it("list: a Duration column, a dash for an empty playlist; the account's default moves picture times", async () => {
    const pid = await playlist("Listed");
    await item(pid, await media("l.png"), 0);
    await item(pid, await media("l.mp4", "video", { duration: 50 }), 1);
    await playlist("Nothing yet");
    let html = await page(r.editor, "/playlists");
    expect(html).toContain('<th scope="col">Items</th><th scope="col">Duration</th><th scope="col">Used by</th>');
    expect(html).toMatch(/>Listed<\/a><\/td>\s*<td data-label="Items">2<\/td>\s*<td data-label="Duration" class="nowrap">1:00<\/td>/);
    expect(html).toMatch(/>Nothing yet<\/a><\/td>\s*<td data-label="Items">0<\/td>\s*<td data-label="Duration" class="nowrap">—<\/td>/);
    await setting(r.ids.editor, "default_image_duration", 20);
    try {
      html = await page(r.editor, "/playlists");
      expect(html).toMatch(/>Listed<\/a><\/td>\s*<td data-label="Items">2<\/td>\s*<td data-label="Duration" class="nowrap">1:10<\/td>/);
      expect(await page(r.editor, `/playlists/${pid}`)).toContain('<span class="page-meta">2 items · 1:10</span>');
    } finally {
      await query("DELETE FROM account_settings WHERE user_id = ? AND key = 'default_image_duration'", r.ids.editor);
    }
  });

  it("a viewer sees the times and none of the forms", async () => {
    const pid = await playlist("Viewer's own", r.ids.viewer);
    await item(pid, await media("vv.png", "image", { owner: r.ids.viewer }), 0);
    const html = await page(r.viewer, `/playlists/${pid}`);
    expect(html).toContain('<span class="page-meta">1 item · 10.0 s</span>');
    expect(html).not.toContain("/pictures");
    expect(html).not.toContain("/duplicate");
  });
});

describe("Every picture (POST /playlists/:id/pictures)", () => {
  it("sets this playlist's pictures only; an empty box puts them back on the default", async () => {
    const pid = await playlist("Pictures");
    const other = await playlist("Other pictures");
    const pa = await media("pa.png");
    const a = await item(pid, pa, 0);
    const b = await item(pid, await media("pb.jpg"), 1, 3);
    const v = await item(pid, await media("pv.mp4", "video", { duration: 30 }), 2, 20);
    const elsewhere = await item(other, pa, 0, 4);
    const html = await page(r.editor, `/playlists/${pid}`);
    expect(html).toContain(`<form method="post" action="/playlists/${pid}/pictures" class="inline duration-form">`);
    expect(html).toContain('<label>Every picture\n      <input type="number" name="duration" min="0.5" max="86400" step="0.5" placeholder="10.0">');
    await query("UPDATE playlists SET updated_at = '2000-01-01 00:00:00' WHERE id = ?", pid);
    let res = await post(r.editor, `/playlists/${pid}/pictures`, { duration: "7.5" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/playlists/${pid}`);
    expect(await overridesOf(a, b, v, elsewhere)).toEqual([7.5, 7.5, 20, 4]);
    expect(await page(r.editor, `/playlists/${pid}`)).toContain('<div class="alert ok" role="alert">2 pictures set to 7.5 s.</div>');
    expect((await one("SELECT updated_at FROM playlists WHERE id = ?", pid)).updated_at).not.toBe("2000-01-01 00:00:00");
    expect((await audits("playlist_set_picture_duration"))[0]).toMatchObject({ target_type: "playlist", target_id: String(pid), details: '{"duration": 7.5, "items": 2}' });
    res = await post(r.editor, `/playlists/${pid}/pictures`, { duration: "" });
    expect(res.status).toBe(303);
    expect(await overridesOf(a, b, v, elsewhere)).toEqual([null, null, 20, 4]);
    expect(await page(r.editor, `/playlists/${pid}`)).toContain('<div class="alert ok" role="alert">2 pictures back to the default.</div>');
  });

  it("a bad number is a 400 and changes nothing; another account's playlist a 404; a viewer a 403", async () => {
    const pid = await playlist("Pictures 2");
    const a = await item(pid, await media("p2.png"), 0, 6);
    for (const bad of ["abc", "0", "0.4", "86401", "inf", "nan", "-1", "1e999"]) {
      expect(await detail(await post(r.editor, `/playlists/${pid}/pictures`, { duration: bad }), 400), bad).toBe("Duration must be a number of seconds between 0.5 and 86400");
    }
    expect(await detail(await post(r.admin, `/playlists/${pid}/pictures`, { duration: "5" }), 404)).toBe("Playlist not found");
    expect(await detail(await post(r.editor, `/playlists/${NOPE}/pictures`, { duration: "5" }), 404)).toBe("Playlist not found");
    expect(await overridesOf(a)).toEqual([6]);
    await roleMatrix(r, "POST", `/playlists/${pid}/pictures`, { fields: { duration: "5" } });
    expect(await overridesOf(a)).toEqual([5]);
  });

  it("a playlist without pictures has no form; a stale one gets a warning", async () => {
    const pid = await playlist("Videos only");
    const v = await item(pid, await media("only.mp4", "video", { duration: 9 }), 0, 4);
    expect(await page(r.editor, `/playlists/${pid}`)).not.toContain("/pictures");
    expect((await post(r.editor, `/playlists/${pid}/pictures`, { duration: "5" })).status).toBe(303);
    expect(await page(r.editor, `/playlists/${pid}`)).toContain('<div class="alert warn" role="alert">There are no pictures in this playlist.</div>');
    expect(await overridesOf(v)).toEqual([4]);
  });
});

describe("a row's Set", () => {
  it("comes back to that row", async () => {
    const pid = await playlist("Anchor");
    const it2 = await item(pid, await media("an.png"), 0);
    const res = await post(r.editor, `/playlists/${pid}/items/${it2}/duration`, { duration: "4" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/playlists/${pid}#item-${it2}`);
    expect(await overridesOf(it2)).toEqual([4]);
  });
});

describe("Duplicate (POST /playlists/:id/duplicate)", () => {
  const itemsOf = (pid) => query("SELECT media_id, position, duration_override_seconds AS d FROM playlist_items WHERE playlist_id = ? ORDER BY position, id", pid);

  it("copies the files, positions and times as NAME copy, then NAME copy 2", async () => {
    const pid = await playlist("Friday night");
    const [m1, m2, m3] = [await media("d1.png"), await media("d2.mp4", "video", { duration: 8 }), await media("d3.png")];
    // positions as the source holds them, a gap included
    await item(pid, m3, 0, 7.5);
    await item(pid, m1, 2);
    await item(pid, m2, 5, 4);
    expect(await page(r.editor, `/playlists/${pid}`)).toContain(`<button type="submit">Rename</button>
    <button type="submit" formaction="/playlists/${pid}/duplicate" formnovalidate>Duplicate</button>`);
    const res = await post(r.editor, `/playlists/${pid}/duplicate`, { name: "the name box is not read" });
    expect(res.status).toBe(303);
    const copy = await one("SELECT id, owner_id FROM playlists WHERE name = 'Friday night copy'");
    expect(copy.owner_id).toBe(r.ids.editor);
    expect(res.headers.get("location")).toBe(`/playlists/${copy.id}`);
    expect(await itemsOf(copy.id)).toEqual([{ media_id: m3, position: 0, d: 7.5 }, { media_id: m1, position: 2, d: null }, { media_id: m2, position: 5, d: 4 }]);
    expect(await itemsOf(pid)).toEqual(await itemsOf(copy.id));
    expect(await page(r.editor, `/playlists/${copy.id}`)).toContain('<div class="alert ok" role="alert">Duplicated as Friday night copy.</div>');
    expect((await audits("playlist_duplicate"))[0]).toMatchObject({ username: "ed", target_type: "playlist", target_id: String(copy.id), details: `{"from": ${pid}, "name": "Friday night copy"}` });
    expect((await post(r.editor, `/playlists/${pid}/duplicate`)).status).toBe(303);
    expect((await post(r.editor, `/playlists/${copy.id}/duplicate`)).status).toBe(303);
    expect((await query("SELECT name FROM playlists WHERE owner_id = ? AND name LIKE 'Friday night%' ORDER BY id", r.ids.editor)).map((x) => x.name))
      .toEqual(["Friday night", "Friday night copy", "Friday night copy 2", "Friday night copy copy"]);
  });

  it("a copy of the Default playlist is an ordinary playlist: no badge, and it can be deleted", async () => {
    const def = await defaultPlaylistOf(r.ids.editor);
    const res = await post(r.editor, `/playlists/${def}/duplicate`);
    expect(res.status).toBe(303);
    const copy = Number(res.headers.get("location").split("/").pop());
    expect(await defaultPlaylistOf(r.ids.editor)).toBe(def);
    const list = await page(r.editor, "/playlists");
    expect(list).toContain(`<a href="/playlists/${copy}">Default copy</a></td>`);
    expect(list).toContain(`action="/playlists/${copy}/delete"`);
    expect((await post(r.editor, `/playlists/${copy}/delete`)).status).toBe(303);
  });

  it("another account's playlist is a missing one; a viewer may not", async () => {
    const pid = await playlist("Mine alone");
    expect(await detail(await post(r.admin, `/playlists/${pid}/duplicate`), 404)).toBe("Playlist not found");
    expect(await detail(await post(r.editor, `/playlists/${NOPE}/duplicate`), 404)).toBe("Playlist not found");
    expect((await post(r.editor, "/playlists/abc/duplicate")).status).toBe(400);
    await roleMatrix(r, "POST", `/playlists/${pid}/duplicate`);
    expect((await query("SELECT owner_id FROM playlists WHERE name LIKE 'Mine alone copy%'")).map((x) => x.owner_id)).toEqual([r.ids.editor]);
  });
});

describe("style.css: the playlist editor", () => {
  it("the name box in its own case, the length on each tile, rows that fit a phone", async () => {
    const css = await (await r.viewer.get("/static/style.css")).text();
    expect(css).toContain(".playlist-head input[type=text] { font-size: 17px; }");
    expect(css).not.toContain(".sortable-table .media-length { display: none; }");
    expect(css).toContain(".sortable-table td.name { overflow-wrap: anywhere; }");
    expect(css).toMatch(/@media \(max-width: 900px\) \{\n {2}\.sortable-table td\.thumb-cell, \.sortable-table \.media-thumb \{ width: 88px; \}\n\}/);
    expect(css).toMatch(/@media \(max-width: 800px\) \{\n {2}\.sortable-table thead \{ position: absolute;[^}]*\}\n {2}\.sortable-table tbody tr \{ display: grid;/);
  });
});
