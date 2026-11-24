// The playlist editor and list after the release review: Nothing to add's Library link keeps the
// playlist it came from (?to=), and Add takes at most MAX_DELETE files a request. The fixtures
// are the editor's (pages_common).
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { detail, media, playlist, post, roles } from "./pages_common.js";

let r;

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
