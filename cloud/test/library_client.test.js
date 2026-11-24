// The Library page as the server renders it for its scripts (library.js libraryPage / card /
// thumbCell): each card's full name linked to the file's own page, the preview's label with the
// type and running time and its URL, the data Find / Show / Sort read, the media bar's Add to
// playlist and the upload box's "Add to" (the contracts with the routes that take them), the
// hidden noop button that takes Enter on a tick box with scripts off, the requests the viewer's
// Delete and its error check send, and the style rules all of it needs.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { MAX_DELETE } from "../src/pages/library.js";
import { Client, query } from "./helpers.js";
import { defaultPlaylistOf, ins, media, one, playlist, post, roles, XSS } from "./pages_common.js";

let r, dflt, m;

const page = async (c, path = "/library") => (await c.get(path)).text();
const flashOf = async (c) => /<div class="alert [a-z]+" role="alert">([^<]*)<\/div>/.exec(await page(c))?.[1];
// The part of a page from `start` to the first `end` after it.
const between = (html, start, end) => { const i = html.indexOf(start); return i < 0 ? "" : html.slice(i, html.indexOf(end, i)); };
const optionsOf = (select) => [...select.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((o) => [o[1], o[3], !!o[2]]);

beforeAll(async () => {
  r = await roles();
  dflt = await defaultPlaylistOf(r.ids.editor);
  const friday = await playlist("Friday night");
  const link = await playlist("Upload link · lobby-pi");
  m = {
    clip: await media("lobby clip.mp4", "video", { duration: 12.3, size: 5000 }),
    pic: await media("lobby poster.png", "image", { size: 900 }),
    loose: await media("loose.mp4", "video"),
    sent: await media("sent.png"),
    xss: await media(XSS + ".png"),
  };
  await media("theirs.png", "image", { owner: r.ids.viewer }); // the viewer's own library is not empty
  for (const [pid, mid, pos] of [[dflt, m.clip, 0], [dflt, m.pic, 1], [friday, m.pic, 0], [link, m.sent, 0], [dflt, m.xss, 2]]) {
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, ?)", pid, mid, pos);
  }
});

describe("library cards", () => {
  it("carry the name, type, size, running time and where the file is used; the name links to the file's page", async () => {
    const html = await page(r.editor);
    expect(html).toContain(`<li class="media-card" data-name="lobby clip.mp4" data-kind="video" data-size="5000" data-length="12.3" data-use="default">`);
    expect(html).toContain(`<li class="media-card" data-name="lobby poster.png" data-kind="image" data-size="900" data-length="0" data-use="playlist">`);
    expect(html).toContain(`<li class="media-card" data-name="loose.mp4" data-kind="video" data-size="1000" data-length="0" data-use="none">`);
    // only in an upload link's playlist: "in a playlist", not loose
    expect(html).toContain(`<li class="media-card" data-name="sent.png" data-kind="image" data-size="1000" data-length="0" data-use="playlist">`);
    expect(html).toContain(`<li class="media-card" data-name="x&#39;);alert(1);//.png" data-kind="image"`);
    // the whole name, as a link, with no tooltip copy of it
    expect(html).toContain(`<a class="media-name" href="/library/${m.clip}">lobby clip.mp4</a>`);
    expect(html).toContain(`<a class="media-name" href="/library/${m.xss}">x&#39;);alert(1);//.png</a>`);
    expect(html).not.toMatch(/class="media-name"[^>]*title=/);
  });

  it("the preview names the file's page and says the type and running time, in the Library and the playlist editor", async () => {
    let html = await page(r.editor);
    expect(html).toContain(`data-page="/library/${m.clip}" aria-label="Open lobby clip.mp4, video, 12.3 s">`);
    expect(html).toContain(`data-page="/library/${m.pic}" aria-label="Open lobby poster.png, image">`);
    expect(html).toContain(`data-page="/library/${m.loose}" aria-label="Open loose.mp4, video">`); // no running time known
    html = await page(r.editor, `/playlists/${dflt}`);
    expect(html).toContain(`data-page="/library/${m.clip}" aria-label="Open lobby clip.mp4, video, 12.3 s">`);
  });
});

describe("previews", () => {
  it("the picture's URL carries the stored name's sha256 prefix; the playlist editor's tile is the file's, not the item's", async () => {
    await media("pad.png"); // media ids run ahead of playlist item ids
    const clip = await media("tile clip.mp4", "video", { duration: 5, filename: "fedcba9876543210_u1_tile_clip.mp4" });
    const pid = await playlist("tiles");
    const item = await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", pid, clip);
    expect(item).not.toBe(clip);
    const img = `<img src="/library/${clip}/thumb?v=fedcba9876543210" alt="" loading="lazy" decoding="async" data-thumb="${clip}">`;
    try {
      expect(await page(r.editor)).toContain(img);
      expect(await page(r.editor, `/playlists/${pid}`)).toContain(img);
      expect((await r.editor.get(`/library/${clip}/thumb?v=fedcba9876543210`)).status).toBe(404); // the route ignores ?v=: no preview yet
    } finally {
      await query("DELETE FROM playlists WHERE id = ?", pid); // the other tests list the account's playlists
    }
  });

  it("an animated GIF plays as a video on the projector, opens as a picture here, and is its own preview", async () => {
    const f = "00112233445566aa_u1_anim.gif";
    const gif = await media("anim.gif", "video", { duration: 3, filename: f });
    const html = await page(r.editor);
    expect(html).toContain(`<li class="media-card" data-name="anim.gif" data-kind="video"`);
    expect(html).toContain('data-kind="img" data-name="anim.gif"');
    const tile = between(html, `href="/api/media/${f}"`, "</a>");
    expect(tile).toContain('<span class="badge badge-video">VIDEO</span>');
    expect(tile).toContain('<span class="media-length">3.0 s</span>');
    const res = await r.editor.get(`/library/${gif}/thumb`);
    expect([res.status, res.headers.get("location")]).toEqual([302, `/api/media/${f}`]);
  });
});

describe("Find / Show / Sort", () => {
  it("a hidden bar outside the grid's form, for every role; the heading the script counts in", async () => {
    for (const c of [r.editor, r.viewer]) {
      const html = await page(c);
      expect(html).toMatch(/<div class="media-head">\s*<h2 id="media-count" aria-live="polite">Media \(\d+\)<\/h2>\s*<div class="media-find" id="media-find" hidden>/);
      expect(html).toContain('<label>Find <input type="search" id="find-q" autocomplete="off"></label>');
      expect(optionsOf(between(html, '<select id="find-show">', "</select>"))).toEqual([
        ["", "All", false], ["video", "Videos", false], ["image", "Images", false], ["default", "Only in Default", false], ["none", "In no playlist", false]]);
      expect(optionsOf(between(html, '<select id="find-sort">', "</select>")).map(([v, t]) => [v, t])).toEqual([
        ["", "Newest"], ["oldest", "Oldest"], ["name", "Name"], ["size", "Largest"], ["length", "Longest"]]);
      expect(between(html, "<form id=\"library-form\"", "</form>")).not.toContain("media-find");
    }
    expect(await page(r.viewer)).not.toContain("library-form");
  });
});

describe("media bar", () => {
  it("the hidden noop button is the form's first submit button; Add to playlist lists the account's own playlists", async () => {
    await playlist("alpha");
    const theirs = await playlist("Theirs", r.ids.admin);
    let html = await page(r.editor);
    expect(html).toMatch(/<form id="library-form" method="post" action="\/library\/delete" autocomplete="off" data-max="500">\s*<input type="hidden" name="csrf_token" value="[^"]+">\s*<button type="submit" name="noop" value="1" hidden><\/button>/);
    const form = between(html, '<form id="library-form"', "</form>");
    expect(/<button type="submit"[^>]*>/.exec(form)[0]).toBe('<button type="submit" name="noop" value="1" hidden>');
    expect(form).toContain('<button type="submit" class="small" formaction="/library/add-to-playlist" data-add-selected>Add to playlist</button>');
    expect(form).toContain('<span class="sr-only" role="status" data-picked></span>');
    const addTo = between(form, '<select name="playlist_id" id="add-to" aria-label="Playlist">', "</select>");
    const own = optionsOf(addTo);
    expect(own[0]).toEqual(["", "Pick a playlist", false]);
    expect(own.slice(1).map(([, name]) => name)).toEqual(["alpha", "Default", "Friday night", "Upload link · lobby-pi"]); // by name, any case
    expect(addTo).not.toContain(`value="${theirs}"`);

    // ?to= (the playlist editor's Add from Library) picks one of the account's own playlists
    html = await page(r.editor, `/library?to=${dflt}`);
    expect(optionsOf(between(html, 'id="add-to"', "</select>")).filter(([, , on]) => on)).toEqual([[String(dflt), "Default", true]]);
    for (const to of [theirs, "abc", ""]) {
      const res = await r.editor.get(`/library?to=${to}`);
      expect(res.status).toBe(200);
      expect(between(await res.text(), 'id="add-to"', "</select>")).not.toContain(" selected");
    }
  });

  it("Enter on a tick box with scripts off (the noop button) deletes nothing and leaves the page as it is", async () => {
    const res = await post(r.editor, "/library/delete", [["noop", "1"], ["media_id", String(m.loose)], ["media_id", String(m.sent)]]);
    expect([res.status, res.headers.get("location"), await res.text()]).toEqual([204, null, ""]);
    expect(await page(r.editor)).not.toContain('role="alert"');
    expect(await one("SELECT COUNT(*) AS n FROM media WHERE id IN (?, ?)", m.loose, m.sent)).toEqual({ n: 2 });
  });
});

describe("deleting", () => {
  it("Delete selected takes exactly as many files as Select all ticks, no more; nothing ticked says so", async () => {
    const ids = (n) => Array.from({ length: n }, (_, i) => ["media_id", String(900000 + i)]); // no such files
    let res = await post(r.editor, "/library/delete", ids(MAX_DELETE));
    expect([res.status, res.headers.get("location")]).toEqual([303, "/library"]);
    expect(await flashOf(r.editor)).toBe("Nothing was deleted: those files are no longer in the library.");
    expect((await post(r.editor, "/library/delete", ids(MAX_DELETE + 1))).status).toBe(400);
    res = await post(r.editor, "/library/delete", {});
    expect([res.status, await flashOf(r.editor)]).toEqual([303, "Nothing was ticked."]);
  });

  it("the viewer's Delete posts the file alone with the token header; a HEAD of the file tells it is there, gone or signed out", async () => {
    const f = "0a1b2c3d4e5f6a7b_u1_gone.png";
    const id = await media("gone.png", "image", { filename: f });
    await env.MEDIA.put(`media/${f}`, new Uint8Array([1, 2, 3]));
    const head = (c) => c.fetch(`/api/media/${f}`, { method: "HEAD" });
    expect((await head(r.editor)).status).toBe(200);
    expect((await head(new Client())).status).toBe(401);
    const res = await post(r.editor, "/library/delete", { one: String(id) });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/library"]);
    expect(await one("SELECT id FROM media WHERE id = ?", id)).toBeNull();
    expect((await head(r.editor)).status).toBe(404);
  });
});

describe("upload box", () => {
  it("Add to: the Default playlist first by its own name, the account's other playlists, then No playlist", async () => {
    let html = await page(r.editor);
    const form = between(html, '<form id="upload-form"', "</form>");
    expect(form).toMatch(/<label>Add to <select name="playlist" id="upload-to">.*<\/select><\/label>\s*<button type="submit" class="primary">Upload<\/button>/);
    // an animated GIF is listed where its badge puts it
    expect(html).toContain("Videos: mp4 · mov · m4v · mkv · webm · animated gif (1080p H.264 recommended). Images: jpg · png · gif · webp · bmp.");
    const to = optionsOf(between(form, 'id="upload-to"', "</select>"));
    expect(to[0]).toEqual(["", "Default", false]);
    expect(to.at(-1)).toEqual(["none", "No playlist", false]);
    expect(to.slice(1, -1).map(([, name]) => name)).toEqual(["alpha", "Friday night", "Upload link · lobby-pi"]);
    expect(to.slice(1, -1).every(([v]) => /^\d+$/.test(v))).toBe(true);
    expect(await page(r.viewer)).not.toContain("upload-to");
    // ?to= (Add from Library) picks the same playlist here; the Default or junk leaves the Default
    const alpha = to.find(([, name]) => name === "alpha")[0];
    const picked = async (q) => optionsOf(between(await page(r.editor, `/library?to=${q}`), 'id="upload-to"', "</select>")).filter(([, , on]) => on);
    expect(await picked(alpha)).toEqual([[alpha, "alpha", true]]);
    for (const q of [dflt, "abc"]) expect(await picked(q)).toEqual([]);

    // no Default playlist on file: uploads went to none, so None is what is picked
    await query("DELETE FROM account_settings WHERE user_id = ? AND key = 'default_playlist_id'", r.ids.editor);
    try {
      html = await page(r.editor);
      const opts = optionsOf(between(html, 'id="upload-to"', "</select>"));
      expect(opts.map(([v]) => v)).not.toContain("");
      expect(opts.at(-1)).toEqual(["none", "No playlist", true]);
      expect(between(html, '<select id="find-show">', "</select>")).not.toContain('value="default"');
    } finally {
      await ins("INSERT INTO account_settings (user_id, key, value) VALUES (?, 'default_playlist_id', ?)", r.ids.editor, String(dflt));
    }
  });
});

describe("style.css", () => {
  it("full names, the [hidden] rule, the Find bar", async () => {
    const css = await (await r.viewer.get("/static/style.css")).text();
    expect(/\.media-name \{[^}]*\}/.exec(css)[0]).not.toMatch(/clamp|overflow: hidden/);
    expect(css).toContain("[hidden] { display: none !important; }");
    expect(css).toMatch(/\.media-find \{ display: flex;/);
  });

  it("a switched-off small button looks off; the bar stays on screen; the tile's focus is drawn outside it; phone spacing", async () => {
    const css = await (await r.viewer.get("/static/style.css")).text();
    // as specific as button.small.danger, and after it
    const off = css.indexOf("button[disabled], .button[disabled], button[disabled]:hover, button.small[disabled] {");
    expect(off).toBeGreaterThan(css.indexOf("button.small.danger, .button.small.danger {"));
    expect(css).toContain("@media (max-width: 720px), (pointer: coarse) {"); // 44px small buttons on a phone held sideways
    expect(css).toMatch(/\.media-bar \{ position: sticky; top: 0; z-index: 2;[^}]*background: var\(--p5k-ground\); \}/);
    expect(css).toMatch(/html:has\(\.media-bar\) \{ scroll-padding-top: \d+px; \}/);
    // on a phone only the bar's first row (the count, Delete selected) stays: the whole bar was up to four rows
    expect(css).toContain(".media-bar { display: contents; }");
    expect(css).toMatch(/\.media-bar > \.action-buttons:first-child \{ position: sticky; top: 0; z-index: 2;/);
    expect(css).not.toContain(".media-thumb:focus-visible {");
    expect(css).toContain(".upload-panel:has(.upload-queue:empty):has(#upload-status:empty) { display: none; }");
    expect(css).toContain(".media-actions { flex-wrap: wrap; gap: 12px 4px;");
    expect(css).toContain(".viewer-foot [data-delete] { margin-left: 18px; }");
  });
});
