// The library track's fixes to the Library and a file's own page (src/pages/library.js) and to
// the notice a redirect carries (src/auth.js flashRedirect).
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { media, playlist, post, roles } from "./pages_common.js";

let r;

// [kind, message] of the notice the next page shows (and clears).
const flash = async (c, path = "/library") => /<div class="alert ([a-z]+)" role="alert">([^<]*)<\/div>/.exec(await (await c.get(path)).text())?.slice(1);

beforeAll(async () => {
  r = await roles();
});

describe("a notice too long for its cookie", () => {
  it("is cut to 300 characters, so a long non-ASCII name still gets its notice", async () => {
    const m = await media("short.jpg");
    for (const [name, kept] of [["日".repeat(1020) + ".jpg", "日".repeat(289)], ["😀".repeat(510) + ".jpg", "😀".repeat(289)]]) {
      const res = await post(r.editor, `/library/${m}/rename`, { name });
      expect(res.status).toBe(303);
      const cookie = res.headers.getSetCookie().find((c) => c.startsWith("piplayer_flash="));
      // a browser drops a cookie whose name and value pass 4096 bytes
      expect(new TextEncoder().encode(cookie.split(";")[0]).length).toBeLessThanOrEqual(4096);
      expect(await flash(r.editor, `/library/${m}`)).toEqual(["ok", `Renamed to ${kept}…`]);
      expect((await query("SELECT original_name FROM media WHERE id = ?", m))[0].original_name).toBe(name);
    }
  });
});

describe("a file's own page", () => {
  it("keeps each fact of its line whole (a phone broke the date at its hyphen); the viewer's copy stays plain", async () => {
    const m = await media("Dated.mp4", "video", { duration: 65 });
    await query("UPDATE media SET width = 1920, height = 1080, uploaded_at = '2026-11-17 09:51:00' WHERE id = ?", m);
    const page = await (await r.editor.get(`/library/${m}`)).text();
    const line = /<span class="page-meta">(.*?)<\/span>\n<\/div>/.exec(page)[1];
    expect(line.split(" · ")).toEqual(["Video", "1:05", "1920×1080", "1.0 KB", "uploaded 2026-11-17 09:51 UTC"].map((f) => `<span class="nowrap">${f}</span>`));
    expect(page).toContain('data-meta="Video · 1:05 · 1920×1080 · 1.0 KB · uploaded 2026-11-17 09:51 UTC"');
  });

  it("names the file in an h1 for an editor too, before the rename form", async () => {
    const m = await media("Named <one>.png");
    const page = await (await r.editor.get(`/library/${m}`)).text();
    expect(page).toMatch(new RegExp(`<div class="page-head">\\s*<h1 class="sr-only">Named &lt;one&gt;\\.png</h1>\\s*<form method="post" action="/library/${m}/rename" class="row">`));
    expect(page.match(/<h1[ >]/g)).toHaveLength(1);
  });
});

describe("the Library's count", () => {
  it("is a polite live heading for every role, so a screen reader hears what Find and Show leave", async () => {
    await media("counted.png");
    await media("theirs-counted.png", "image", { owner: r.ids.viewer });
    for (const c of [r.editor, r.viewer]) {
      expect(await (await c.get("/library")).text()).toMatch(/<h2 id="media-count" aria-live="polite">Media \(\d+\)<\/h2>/);
    }
  });
});

describe("a delete says where the files went", () => {
  it("each question and notice names Recently deleted, where a file is kept 30 days", async () => {
    const [a, b, c, d] = [await media("del-a.png"), await media("del-b.png"), await media("del-c.png"), await media("del-d.png")];
    const library = await (await r.editor.get("/library")).text();
    expect(library).toContain(`value="${a}" class="danger small" data-confirm="Delete del-a.png? It is removed from every playlist that uses it and kept in Recently deleted for 30 days.">Delete</button>`);
    expect(library).toContain('data-confirm="Delete the selected files? They are removed from every playlist that uses them and kept in Recently deleted for 30 days.">Delete selected</button>');
    expect(await (await r.editor.get(`/library/${a}`)).text())
      .toContain(`action="/library/${a}/delete" class="inline" data-confirm="Delete del-a.png? It is removed from every playlist that uses it and kept in Recently deleted for 30 days.">`);
    await post(r.editor, `/library/${a}/delete`);
    expect(await flash(r.editor)).toEqual(["ok", "Moved del-a.png to Recently deleted."]);
    await post(r.editor, "/library/delete", [["one", String(b)]]);
    expect(await flash(r.editor)).toEqual(["ok", "Moved del-b.png to Recently deleted."]);
    await post(r.editor, "/library/delete", [["media_id", String(c)], ["media_id", String(d)]]);
    expect(await flash(r.editor)).toEqual(["ok", "Moved 2 files to Recently deleted."]);
    expect(await query("SELECT original_name FROM media_trash WHERE media_id IN (?, ?, ?, ?) ORDER BY media_id", a, b, c, d))
      .toEqual(["del-a.png", "del-b.png", "del-c.png", "del-d.png"].map((original_name) => ({ original_name })));
  });
});

describe("the Library opened from a playlist (?to=)", () => {
  it("its grid form carries the page back, so an Add or a Delete comes back with the playlist still picked", async () => {
    const pid = await playlist("Kept night");
    const theirs = await playlist("Not the editor's", r.ids.admin);
    const [a, b, c] = [await media("keep-a.png"), await media("keep-b.png"), await media("keep-c.png")];
    const form = async (path) => { const html = await (await r.editor.get(path)).text(); return html.slice(html.indexOf('<form id="library-form"'), html.indexOf("</form>", html.indexOf('<form id="library-form"'))); };
    expect(await form(`/library?to=${pid}`)).toContain(`<input type="hidden" name="back" value="/library?to=${pid}">`);
    for (const path of ["/library", `/library?to=${theirs}`, "/library?to=abc"]) expect(await form(path), path).not.toContain('name="back"');

    const back = ["back", `/library?to=${pid}`];
    let res = await post(r.editor, "/library/add-to-playlist", [back, ["playlist_id", String(pid)], ["media_id", String(a)]]);
    expect([res.status, res.headers.get("location")]).toEqual([303, `/library?to=${pid}`]);
    const page = await (await r.editor.get(`/library?to=${pid}`)).text();
    expect(page).toContain('<div class="alert ok" role="alert">Added 1 file to Kept night.</div>');
    expect(page).toContain(`<option value="${pid}" selected>Kept night</option>`);
    for (const [fields, notice] of [
      [[back, ["playlist_id", String(pid)], ["media_id", String(a)]], ["warn", "That file is already in Kept night."]],
      [[back, ["media_id", String(a)]], ["warn", "Pick a playlist."]],
      [[back, ["playlist_id", String(pid)]], ["warn", "Nothing was ticked."]],
    ]) {
      res = await post(r.editor, "/library/add-to-playlist", fields);
      expect([res.status, res.headers.get("location")]).toEqual([303, `/library?to=${pid}`]);
      expect(await flash(r.editor, `/library?to=${pid}`)).toEqual(notice);
    }
    for (const [fields, notice] of [
      [[back, ["one", String(b)]], ["ok", "Moved keep-b.png to Recently deleted."]],
      [[back, ["media_id", String(c)]], ["ok", "Moved keep-c.png to Recently deleted."]],
      [[back, ["media_id", String(c)]], ["warn", "Nothing was deleted: those files are no longer in the library."]],
      [[back], ["warn", "Nothing was ticked."]],
    ]) {
      res = await post(r.editor, "/library/delete", fields);
      expect([res.status, res.headers.get("location")]).toEqual([303, `/library?to=${pid}`]);
      expect(await flash(r.editor, `/library?to=${pid}`)).toEqual(notice);
    }
  });

  it("a back that is not one of the Library's own pages goes to the Library", async () => {
    const pid = await playlist("Anywhere");
    const m = await media("anywhere.png");
    for (const bad of ["https://example.com/", "//example.com", "/library?to=1&x=2", "/library/1/delete", "/libraryx", "/library?to=", "/library/", " /library/1", "/library/1\n"]) {
      const res = await post(r.editor, "/library/add-to-playlist", [["back", bad], ["playlist_id", String(pid)], ["media_id", String(m)]]);
      expect([res.status, res.headers.get("location")], JSON.stringify(bad)).toEqual([303, "/library"]);
      await r.editor.get("/library"); // uses up the notice
    }
    const res = await post(r.editor, "/library/delete", [["back", "https://example.com/"]]);
    expect([res.status, res.headers.get("location")]).toEqual([303, "/library"]);
  });
});

describe("the small picture of a picture no larger than a preview", () => {
  it("keeps its redirect a week; a larger picture, or one of unknown size, is asked for again", async () => {
    const thumb = async (name, width, height) => {
      const m = await media(name);
      await query("UPDATE media SET width = ?, height = ? WHERE id = ?", width, height, m);
      const res = await r.editor.get(`/library/${m}/thumb`);
      expect(res.status, name).toBe(302);
      return res.headers.get("cache-control");
    };
    expect(await thumb("small.png", 600, 400)).toBe("private, max-age=604800");
    expect(await thumb("square.gif", 640, 640)).toBe("private, max-age=604800");
    expect(await thumb("wide.jpg", 641, 100)).toBe("no-store");
    expect(await thumb("unknown.png", null, null)).toBe("no-store");
    expect(await thumb("zero.png", 0, 0)).toBe("no-store");
  });
});
