// The Library page as the server renders it for its scripts (library.js libraryPage / card /
// thumbCell): each card's full name linked to the file's own page, the preview's label with the
// type and running time, the data Find / Show / Sort read, the media bar's Add to playlist and the
// upload box's "Add to" (the contracts with the routes that take them), the hidden noop button
// that takes Enter on a tick box with scripts off, and the style rules all of it needs.
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { defaultPlaylistOf, ins, media, one, playlist, post, roles, XSS } from "./pages_common.js";

let r, dflt, m;

const page = async (c, path = "/library") => (await c.get(path)).text();
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

describe("Find / Show / Sort", () => {
  it("a hidden bar outside the grid's form, for every role; the heading the script counts in", async () => {
    for (const c of [r.editor, r.viewer]) {
      const html = await page(c);
      expect(html).toMatch(/<div class="media-head">\s*<h2 id="media-count">Media \(\d+\)<\/h2>\s*<div class="media-find" id="media-find" hidden>/);
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

  it("Enter on a tick box with scripts off (the noop button) deletes nothing", async () => {
    const res = await post(r.editor, "/library/delete", [["noop", "1"], ["media_id", String(m.loose)], ["media_id", String(m.sent)]]);
    expect([res.status, res.headers.get("location")]).toEqual([303, "/library"]);
    expect(await page(r.editor)).toContain('<div class="alert warn" role="alert">Nothing was deleted.</div>');
    expect(await one("SELECT COUNT(*) AS n FROM media WHERE id IN (?, ?)", m.loose, m.sent)).toEqual({ n: 2 });
  });
});

describe("upload box", () => {
  it("Add to: the Default playlist first by its own name, the account's other playlists, then No playlist", async () => {
    let html = await page(r.editor);
    const form = between(html, '<form id="upload-form"', "</form>");
    expect(form).toMatch(/<label>Add to <select name="playlist" id="upload-to">.*<\/select><\/label>\s*<button type="submit" class="primary">Upload<\/button>/);
    const to = optionsOf(between(form, 'id="upload-to"', "</select>"));
    expect(to[0]).toEqual(["", "Default", false]);
    expect(to.at(-1)).toEqual(["none", "No playlist", false]);
    expect(to.slice(1, -1).map(([, name]) => name)).toEqual(["alpha", "Friday night", "Upload link · lobby-pi"]);
    expect(to.slice(1, -1).every(([v]) => /^\d+$/.test(v))).toBe(true);
    expect(await page(r.viewer)).not.toContain("upload-to");

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
});
