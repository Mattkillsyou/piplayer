// The playlist editor and list after the release review: Nothing to add's Library link keeps the
// playlist it came from (?to=). The fixtures are the editor's (pages_common).
import { beforeAll, describe, expect, it } from "vitest";
import { media, playlist, post, roles } from "./pages_common.js";

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
