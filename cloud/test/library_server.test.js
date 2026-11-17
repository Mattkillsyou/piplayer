// The Library's files on the server side (src/pages/library.js, src/uploads.js): the ticked
// files added to a playlist in one step (POST /library/add-to-playlist, appendToPlaylist, the
// playlist editor's Add taking several files and its Add from Library link), where a Library
// upload goes (the complete body's "playlist"), and a page per file (GET /library/<id>, POST
// /library/<id>/rename). The fixtures are the editor's; every other account gets the 404 of a
// missing row.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import * as db from "../src/db.js";
import * as manifest from "../src/manifest.js";
import { appendToPlaylist, MAX_DELETE } from "../src/pages/library.js";
import * as links from "../src/pages/links.js";
import { Client, query } from "./helpers.js";
import { audits, defaultPlaylistOf, detail, device, ins, media, NOPE, one, playlist, post, postJson, roleMatrix, roles, XSS } from "./pages_common.js";

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (data) => hex(await crypto.subtle.digest("SHA-256", data));
const fakeFile = (size, seed) => Uint8Array.from({ length: size }, (_, i) => (i * seed + 7) & 0xff);
const items = (pid) => query("SELECT media_id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position, id", pid);
const updatedAt = async (pid) => (await one("SELECT updated_at FROM playlists WHERE id = ?", pid)).updated_at;
const age = (pid) => query("UPDATE playlists SET updated_at = '2000-01-01 00:00:00' WHERE id = ?", pid);
// [kind, message] of the notice the next page shows (and clears).
const flash = async (c, path = "/library") => /<div class="alert ([a-z]+)" role="alert">([^<]*)<\/div>/.exec(await (await c.get(path)).text())?.slice(1);
// The Library form's fields for "Add to playlist": the picked playlist and the ticked files, in order.
const ticked = (pid, ids) => [["playlist_id", String(pid)], ...ids.map((id) => ["media_id", String(id)])];

let r, DEFAULT;

beforeAll(async () => {
  r = await roles();
  DEFAULT = await defaultPlaylistOf(r.ids.editor);
});

describe("Add to playlist (POST /library/add-to-playlist)", () => {
  it("appends the ticked files in the page's order after the last item, skips one already in it and another account's, audits once", async () => {
    const pid = await playlist("Friday night");
    const inAlready = await media("in.png");
    const new1 = await media("new1.png");
    const new2 = await media("new2.mp4", "video");
    const theirs = await media("theirs.png", "image", { owner: r.ids.admin });
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 4)", pid, inAlready); // after the last, wherever that is
    await age(pid);
    const res = await post(r.editor, "/library/add-to-playlist", ticked(pid, [new2, inAlready, new1, theirs, new2]));
    expect([res.status, res.headers.get("location")]).toEqual([303, "/library"]);
    expect(await flash(r.editor)).toEqual(["ok", "Added 2 files to Friday night; 1 was already in it."]);
    expect(await items(pid)).toEqual([{ media_id: inAlready, position: 4 }, { media_id: new2, position: 5 }, { media_id: new1, position: 6 }]);
    expect(await updatedAt(pid)).not.toBe("2000-01-01 00:00:00");
    expect(await query("SELECT id FROM playlist_items WHERE media_id = ?", theirs)).toEqual([]);
    const rows = await audits("playlist_add_items");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ username: "ed", target_type: "playlist", target_id: String(pid) });
    expect(JSON.parse(rows[0].details)).toEqual({ added: 2, media_ids: [new2, inAlready, new1, theirs] });
  });

  it("one file reads in the singular; files all in it already are a warning that writes nothing", async () => {
    const pid = await playlist("Lobby");
    const a = await media("lobby-a.png");
    const b = await media("lobby-b.png");
    await post(r.editor, "/library/add-to-playlist", ticked(pid, [a]));
    expect(await flash(r.editor)).toEqual(["ok", "Added 1 file to Lobby."]);
    await post(r.editor, "/library/add-to-playlist", ticked(pid, [b, a]));
    expect(await flash(r.editor)).toEqual(["ok", "Added 1 file to Lobby; 1 was already in it."]);
    await age(pid);
    const audited = (await audits("playlist_add_items")).length;
    let res = await post(r.editor, "/library/add-to-playlist", ticked(pid, [a, b]));
    expect([res.status, res.headers.get("location")]).toEqual([303, "/library"]);
    expect(await flash(r.editor)).toEqual(["warn", "Those files are already in Lobby."]);
    res = await post(r.editor, "/library/add-to-playlist", ticked(pid, [b]));
    expect(await flash(r.editor)).toEqual(["warn", "That file is already in Lobby."]);
    expect(await items(pid)).toEqual([{ media_id: a, position: 0 }, { media_id: b, position: 1 }]);
    expect(await updatedAt(pid)).toBe("2000-01-01 00:00:00");
    expect((await audits("playlist_add_items")).length).toBe(audited);
  });

  it("warns when no playlist is picked or nothing is ticked; 404 for a playlist or files that are not the caller's; 400 for junk and past the cap", async () => {
    const pid = await playlist("Warnings");
    const m = await media("warn.png");
    const count = () => query("SELECT COUNT(*) AS n FROM playlist_items");
    const before = await count();
    let res = await post(r.editor, "/library/add-to-playlist", [["media_id", String(m)]]);
    expect([res.status, res.headers.get("location")]).toEqual([303, "/library"]);
    expect(await flash(r.editor)).toEqual(["warn", "Pick a playlist."]);
    await post(r.editor, "/library/add-to-playlist", [["playlist_id", ""], ["media_id", String(m)]]);
    expect(await flash(r.editor)).toEqual(["warn", "Pick a playlist."]);
    res = await post(r.editor, "/library/add-to-playlist", { playlist_id: String(pid) });
    expect([res.status, res.headers.get("location")]).toEqual([303, "/library"]);
    expect(await flash(r.editor)).toEqual(["warn", "Nothing was ticked."]);
    const adminPl = await playlist("Admin's own", r.ids.admin);
    expect(await detail(await post(r.editor, "/library/add-to-playlist", ticked(adminPl, [m])), 404)).toBe("Playlist not found");
    expect(await detail(await post(r.admin, "/library/add-to-playlist", ticked(pid, [m])), 404)).toBe("Playlist not found");
    expect(await detail(await post(r.editor, "/library/add-to-playlist", ticked(NOPE, [m])), 404)).toBe("Playlist not found");
    const theirs = await media("warn-theirs.png", "image", { owner: r.ids.admin });
    expect(await detail(await post(r.editor, "/library/add-to-playlist", ticked(pid, [theirs, NOPE])), 404)).toBe("Media not found");
    expect(await detail(await post(r.editor, "/library/add-to-playlist", ticked(pid, ["abc"])), 400)).toBe("media_id: value is not a valid integer");
    expect(await detail(await post(r.editor, "/library/add-to-playlist", [["playlist_id", "x"], ["media_id", String(m)]]), 400)).toBe("Playlist must be a whole number");
    const tooMany = Array.from({ length: MAX_DELETE + 1 }, (_, i) => NOPE + i);
    expect(await detail(await post(r.editor, "/library/add-to-playlist", ticked(pid, tooMany)), 400)).toBe(`Add at most ${MAX_DELETE} files at a time`);
    expect(await count()).toEqual(before);
    // as many as one go takes, in one statement: the file among them lands
    await post(r.editor, "/library/add-to-playlist", ticked(pid, [...tooMany.slice(2), m]));
    expect(await flash(r.editor)).toEqual(["ok", "Added 1 file to Warnings."]);
    expect(await items(pid)).toEqual([{ media_id: m, position: 0 }]);
  });

  it("viewers 403; appendToPlaylist itself adds nothing to another account's playlist", async () => {
    await roleMatrix(r, "POST", "/library/add-to-playlist"); // the editor's empty post: back with a warning
    expect(await flash(r.editor)).toEqual(["warn", "Pick a playlist."]);
    const m = await media("direct.png");
    const adminPl = await playlist("Not the editor's", r.ids.admin);
    expect(await appendToPlaylist(env, adminPl, [m], r.ids.editor)).toEqual({ added: 0, already: 0 });
    expect(await items(adminPl)).toEqual([]);
    const pid = await playlist("Direct");
    expect(await appendToPlaylist(env, pid, [], r.ids.editor)).toEqual({ added: 0, already: 0 });
    expect(await appendToPlaylist(env, pid, [m, m], r.ids.editor)).toEqual({ added: 1, already: 0 });
    expect(await appendToPlaylist(env, pid, [m], r.ids.editor)).toEqual({ added: 0, already: 1 });
  });
});

describe("the playlist editor's Add", () => {
  it("takes several files in one post, in that order, and keeps the 409 when none is new", async () => {
    const pid = await playlist("Several");
    const [a, b, c] = [await media("sev-a.png"), await media("sev-b.png"), await media("sev-c.png")];
    const res = await post(r.editor, `/playlists/${pid}/items`, [["media_id", String(b)], ["media_id", String(a)]]);
    expect([res.status, res.headers.get("location")]).toEqual([303, `/playlists/${pid}`]);
    expect(await items(pid)).toEqual([{ media_id: b, position: 0 }, { media_id: a, position: 1 }]);
    expect(JSON.parse((await audits("playlist_add_item"))[0].details)).toEqual({ media_ids: [b, a], added: 2 });
    expect((await post(r.editor, `/playlists/${pid}/items`, [["media_id", String(a)], ["media_id", String(c)]])).status).toBe(303);
    expect((await items(pid)).map((x) => x.media_id)).toEqual([b, a, c]);
    expect(await detail(await post(r.editor, `/playlists/${pid}/items`, [["media_id", String(a)], ["media_id", String(b)]]), 409)).toBe("That file is already in this playlist");
    expect(await detail(await post(r.editor, `/playlists/${pid}/items`, [["media_id", ""], ["media_id", ""]]), 400)).toBe("Pick a file to add");
    expect((await items(pid)).length).toBe(3);
  });

  it("offers Add from Library beside Add, for editors", async () => {
    const pid = await playlist("Linked");
    await media("not-in-it-yet.png"); // so the Add row has something to pick
    expect(await (await r.editor.get(`/playlists/${pid}`)).text())
      .toMatch(new RegExp(`<button type="submit" class="primary">Add</button>\\s*<a class="button small" href="/library\\?to=${pid}">Add from Library</a>`));
    const vpid = await playlist("Viewer's", r.ids.viewer);
    expect(await (await r.viewer.get(`/playlists/${vpid}`)).text()).not.toContain("Add from Library");
  });
});

describe("where a Library upload goes (the complete body's playlist)", () => {
  // init and one part of `data` as `name`, then complete with `body`: an object goes as JSON, a
  // string as it is, undefined as no body at all (what an upload.js from before the choice sends).
  async function upload(name, data, body) {
    const c = r.editor;
    const init = await postJson(c, "/library/upload/init", { name, size: data.length, sha256: await digest(data), media_type: "image" });
    expect(init.status, await init.clone().text()).toBe(200);
    const { upload_id } = await init.json();
    const part = await c.fetch(`/library/upload/${upload_id}/part/1`, { method: "PUT", body: data, headers: { "X-CSRF-Token": c.token } });
    expect(part.status, await part.clone().text()).toBe(200);
    const complete = (b) => (typeof b === "object" && b !== null ? postJson(c, `/library/upload/${upload_id}/complete`, b)
      : c.fetch(`/library/upload/${upload_id}/complete`, { method: "POST", body: b, headers: { "X-CSRF-Token": c.token } }));
    return { upload_id, complete, res: await complete(body) };
  }
  const lastUpload = async () => JSON.parse((await audits("upload_media"))[0].details);
  const playlistsOf = (mediaId) => query("SELECT playlist_id FROM playlist_items WHERE media_id = ?", mediaId).then((x) => x.map((y) => y.playlist_id));

  it("another playlist of the uploader's own: last in it, not in the Default, updated_at moved, audited", async () => {
    const pid = await playlist("Destination");
    const first = await media("dest-first.png");
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", pid, first);
    await age(pid);
    const { res } = await upload("dest-own.png", fakeFile(600, 21), { playlist: String(pid) });
    expect(res.status, await res.clone().text()).toBe(200);
    const { media_id } = await res.json();
    expect(await items(pid)).toEqual([{ media_id: first, position: 0 }, { media_id, position: 1 }]);
    expect(await playlistsOf(media_id)).toEqual([pid]);
    expect(await updatedAt(pid)).not.toBe("2000-01-01 00:00:00");
    expect(await lastUpload()).toEqual({ filename: "dest-own.png", type: "image", playlist: pid });
  });

  it("\"none\": in no playlist, and its page says so", async () => {
    const { res } = await upload("dest-none.png", fakeFile(600, 22), { playlist: "none" });
    expect(res.status, await res.clone().text()).toBe(200);
    const { media_id } = await res.json();
    expect(await playlistsOf(media_id)).toEqual([]);
    expect(await lastUpload()).toEqual({ filename: "dest-none.png", type: "image" });
    const page = await (await r.editor.get(`/library/${media_id}`)).text();
    expect(page).toContain("<h2>Playlists (0)</h2>");
    expect(page).toContain('<p class="muted">Not in any playlist</p>');
  });

  it("no choice (an empty object, \"\", no body, or a form post) joins the Default at the end, as before", async () => {
    for (const [i, body] of [{}, { playlist: "" }, undefined, "{}"].entries()) {
      const { res } = await upload(`dest-default-${i}.png`, fakeFile(600, 23 + i), body);
      expect(res.status, `${i}: ${await res.clone().text()}`).toBe(200);
      const { media_id } = await res.json();
      expect(await playlistsOf(media_id)).toEqual([DEFAULT]);
      expect((await items(DEFAULT)).at(-1).media_id).toBe(media_id);
      expect((await lastUpload()).playlist).toBe(DEFAULT);
    }
    // a form post: the CSRF check has read its body, so it carries no choice (and is no 500)
    const data = fakeFile(600, 28);
    const init = await postJson(r.editor, "/library/upload/init", { name: "dest-form.png", size: data.length, sha256: await digest(data), media_type: "image" });
    const { upload_id } = await init.json();
    await r.editor.fetch(`/library/upload/${upload_id}/part/1`, { method: "PUT", body: data, headers: { "X-CSRF-Token": r.editor.token } });
    const res = await r.editor.post(`/library/upload/${upload_id}/complete`, { csrf_token: r.editor.token, playlist: "none" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await playlistsOf((await res.json()).media_id)).toEqual([DEFAULT]);
  });

  it("another account's playlist is a 404 before anything is written: the upload stays to be completed again", async () => {
    const adminPl = await defaultPlaylistOf(r.ids.admin);
    const { upload_id, complete, res } = await upload("dest-theirs.png", fakeFile(700, 31), { playlist: String(adminPl) });
    expect(await detail(res, 404)).toBe("Playlist not found");
    expect(await detail(await complete({ playlist: String(NOPE) }), 404)).toBe("Playlist not found");
    for (const bad of [{ playlist: "abc" }, { playlist: 5 }, { playlist: null }, { playlist: "-1" }, { playlist: " 7" }, { playlist: ["none"] }]) {
      expect(await detail(await complete(bad), 400), JSON.stringify(bad)).toBe('playlist must be a playlist id, "" or "none"');
    }
    for (const raw of ["[1]", "not json", "null", "\"none\""]) {
      expect(await detail(await complete(raw), 400), raw).toBe("body must be a JSON object");
    }
    expect(await query("SELECT id FROM media WHERE original_name = 'dest-theirs.png'")).toEqual([]);
    expect(await query("SELECT id FROM uploads WHERE id = ?", upload_id)).toEqual([{ id: upload_id }]);
    expect(await items(adminPl)).toEqual([]);
    const again = await complete({ playlist: "none" });
    expect(again.status, await again.clone().text()).toBe(200);
    expect(await playlistsOf((await again.json()).media_id)).toEqual([]);
    expect(await query("SELECT id FROM uploads WHERE id = ?", upload_id)).toEqual([]);
  });

  it("an upload link ignores the body: its files join no playlist whatever it says", async () => {
    const { token } = await links.issueLink({ env }, r.ids.editor, "Ava");
    const anon = new Client();
    const base = `/api/link/${token}/upload`;
    const pid = await playlist("Not for links");
    for (const [i, body] of [{ playlist: "none" }, { playlist: String(pid) }, { playlist: "abc" }].entries()) {
      const data = fakeFile(500, 60 + i);
      const init = await anon.postJson(`${base}/init`, { name: `linked-${i}.png`, size: data.length, sha256: await digest(data), media_type: "image" });
      expect(init.status, await init.clone().text()).toBe(200);
      const { upload_id } = await init.json();
      expect((await anon.fetch(`${base}/${upload_id}/part/1`, { method: "PUT", body: data })).status).toBe(200);
      const res = await anon.postJson(`${base}/${upload_id}/complete`, body);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await playlistsOf((await res.json()).media_id)).toEqual([]);
      expect(await lastUpload()).toEqual({ filename: `linked-${i}.png`, type: "image", link: "Ava" });
    }
    expect(await items(pid)).toEqual([]);
  });
});

describe("a page per file (GET /library/<id>)", () => {
  it("an editor gets a rename form, the preview, the facts, Download under the file's own name, its playlists as links and Delete", async () => {
    const m = await media("Lobby loop.mp4", "video", { filename: "f1_u1_Lobby_loop.mp4", duration: 65, size: 12 * 1024 * 1024 });
    await query("UPDATE media SET width = 1920, height = 1080 WHERE id = ?", m);
    const second = await playlist("b-second");
    const first = await playlist("A first");
    for (const [pid, pos] of [[second, 0], [second, 1], [first, 0]]) {
      await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, ?)", pid, m, pos); // twice in one: listed once
    }
    const page = await (await r.editor.get(`/library/${m}`)).text();
    expect(page).toContain("<title>Lobby loop.mp4 ");
    expect(page).toContain('<a href="/library" class="back">← Library</a>');
    expect(page).toContain('<div class="file-page" data-thumb-put>');
    expect(page).toMatch(new RegExp(`<form method="post" action="/library/${m}/rename" class="row">\\s*<input type="hidden" name="csrf_token" value="[^"]+">\\s*<label>file name\\s*<input type="text" name="name" value="Lobby loop.mp4" maxlength="1024" required>\\s*</label>\\s*<button type="submit">Rename</button>`));
    expect(page).toMatch(/<span class="page-meta">Video · 1:05 · 1920×1080 · 12 MB · uploaded \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/span>/);
    // the preview tile (thumbCell): it opens the viewer, whose line is the page's
    expect(page).toContain('<a class="media-thumb" href="/api/media/f1_u1_Lobby_loop.mp4"');
    expect(page).toContain('data-meta="Video · 1:05 · 1920×1080 · 12 MB · uploaded ');
    expect(page).toContain(`<img src="/library/${m}/thumb?v=f1_u1_Lobby_loop"`);
    expect(page).toContain('<a class="button small" href="/api/media/f1_u1_Lobby_loop.mp4" download="Lobby loop.mp4">Download</a>');
    expect(page).toMatch(new RegExp(`<form method="post" action="/library/${m}/delete" class="inline" data-confirm="Delete Lobby loop.mp4\\? It is removed from every playlist that uses it.">\\s*<input type="hidden" name="csrf_token" value="[^"]+">\\s*<button type="submit" class="danger small">Delete</button>`));
    expect(page).toContain(`<h2>Playlists (2)</h2>\n<ul>\n  <li><a href="/playlists/${first}">A first</a></li>\n  <li><a href="/playlists/${second}">b-second</a></li>\n</ul>`);
    expect(page).toContain('<script src="/static/media.js"></script>');
  });

  it("a viewer gets the name as a heading, Download and the playlists, nothing to change", async () => {
    const m = await media("their pic.jpg", "image", { owner: r.ids.viewer, filename: "f2_u3_their_pic.jpg" });
    const page = await (await r.viewer.get(`/library/${m}`)).text();
    expect(page).toContain("<h1>their pic.jpg</h1>");
    expect(page).toMatch(/<span class="page-meta">Image · 1\.0 KB · uploaded [^<]+<\/span>/);
    expect(page).toContain('download="their pic.jpg">Download</a>');
    expect(page).toContain('<p class="muted">Not in any playlist</p>');
    expect(page).toContain('<div class="file-page">');
    for (const absent of ["/rename", "/delete", "data-thumb-put", "data-confirm"]) expect(page).not.toContain(absent);
  });

  it("another account's file, an admin's look included, is the 404 of a missing one, and so is a word (GET /library/delete); anonymous to sign-in", async () => {
    const m = await media("private.png");
    for (const c of [r.viewer, r.admin]) expect(await detail(await c.get(`/library/${m}`), 404)).toBe("Not Found");
    expect(await detail(await r.editor.get(`/library/${NOPE}`), 404)).toBe("Not Found");
    for (const word of ["abc", "delete", "add-to-playlist", "trash", "upload"]) expect(await detail(await r.editor.get(`/library/${word}`), 404), word).toBe("Not Found");
    const anon = await new Client().get(`/library/${m}`);
    expect([anon.status, anon.headers.get("location")]).toEqual([303, "/login"]);
    // the uploads' own routes are deeper and still theirs
    expect(await detail(await r.editor.get(`/library/upload/${NOPE}`), 404)).toBe("Upload not found");
  });

  it("Download adds the stored file's extension when the name has none or another", async () => {
    for (const [name, filename, saveAs] of [["Poster", "f3_u1_poster.jpg", "Poster.jpg"], ["Poster.PNG", "f4_u1_poster.jpg", "Poster.PNG.jpg"], ["CLIP.MP4", "f5_u1_CLIP.mp4", "CLIP.MP4"]]) {
      const m = await media(name, "image", { filename });
      expect(await (await r.editor.get(`/library/${m}`)).text(), name).toContain(`href="/api/media/${filename}" download="${saveAs}">Download</a>`);
    }
  });
});

describe("rename (POST /library/<id>/rename)", () => {
  it("changes the name the pages show and nothing a projector uses; audits from and to; says so on the file's page", async () => {
    const m = await media("IMG_7781.MOV", "video", { filename: "r1_u1_IMG_7781.mov", duration: 5 });
    const pid = await playlist("Rename loop");
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", pid, m);
    const dev = await device("rename-dev", "Rename Dev", { playlist_id: pid });
    const row = { ...(await one("SELECT id, playlist_id, group_id, owner_id FROM devices WHERE id = ?", dev.id)), device_id: dev.device_id, name: dev.name };
    const settings = await db.loadSettings(env, r.ids.editor);
    const before = await manifest.manifest_for_device(env, row, "https://cms.example", settings);
    const stored = await one("SELECT filename, sha256 FROM media WHERE id = ?", m);

    const res = await post(r.editor, `/library/${m}/rename`, { name: "  Lobby loop  " });
    expect([res.status, res.headers.get("location")]).toEqual([303, `/library/${m}`]);
    expect(await one("SELECT original_name, filename, sha256 FROM media WHERE id = ?", m)).toEqual({ original_name: "Lobby loop", ...stored });
    const after = await manifest.manifest_for_device(env, row, "https://cms.example", settings);
    expect(after.playlist.hash).toBe(before.playlist.hash);
    expect(after.playlist.items).toEqual(before.playlist.items);
    const [a] = await audits("media_rename");
    expect(a).toMatchObject({ username: "ed", target_type: "media", target_id: String(m) });
    expect(JSON.parse(a.details)).toEqual({ from: "IMG_7781.MOV", to: "Lobby loop" });
    const page = await (await r.editor.get(`/library/${m}`)).text();
    expect(page).toContain('<div class="alert ok" role="alert">Renamed to Lobby loop.</div>');
    expect(page).toContain('name="name" value="Lobby loop"');
    expect(page).toContain('download="Lobby loop.mov">Download</a>');
    const editorPage = await (await r.editor.get(`/playlists/${pid}`)).text();
    expect(editorPage).toContain("Lobby loop");
    expect(editorPage).not.toContain("IMG_7781.MOV");
  });

  it("refuses an empty, overlong or control-character name (400, unchanged); 1024 characters is fine", async () => {
    const m = await media("keep.png");
    for (const bad of ["", "   ", "x".repeat(1025), "tab\there", "nul\u0000x", "del\u007fx", "line\nbreak"]) {
      expect(await detail(await post(r.editor, `/library/${m}/rename`, { name: bad }), 400), JSON.stringify(bad)).toBe("File name must be 1-1024 printable characters");
    }
    expect((await one("SELECT original_name FROM media WHERE id = ?", m)).original_name).toBe("keep.png");
    expect((await post(r.editor, `/library/${m}/rename`, { name: "y".repeat(1024) })).status).toBe(303);
    expect(await flash(r.editor, `/library/${m}`)).toEqual(["ok", `Renamed to ${"y".repeat(1024)}.`]);
  });

  it("viewers 403, another account (an admin too) the 404 of a missing file; a name is escaped wherever it shows", async () => {
    const m = await media("safe.png");
    await roleMatrix(r, "POST", `/library/${m}/rename`, { fields: { name: "matrix" } });
    expect(await flash(r.editor, `/library/${m}`)).toEqual(["ok", "Renamed to matrix."]);
    expect(await detail(await post(r.admin, `/library/${m}/rename`, { name: "Mine now" }), 404)).toBe("Not Found");
    expect(await detail(await post(r.editor, `/library/${NOPE}/rename`, { name: "x" }), 404)).toBe("Not Found");
    expect((await post(r.editor, "/library/abc/rename", { name: "x" })).status).toBe(400);
    expect((await one("SELECT original_name FROM media WHERE id = ?", m)).original_name).toBe("matrix");

    const pid = await playlist("Escapes");
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", pid, m);
    const name = XSS + "<svg onload=alert(1)>";
    expect((await post(r.editor, `/library/${m}/rename`, { name })).status).toBe(303);
    for (const path of [`/library/${m}`, "/library", `/playlists/${pid}`]) {
      const html = await (await r.editor.get(path)).text();
      expect(html, path).not.toContain(name);
      expect(html, path).not.toContain("<svg onload");
      expect(html, path).toContain("x&#39;);alert(1);//&lt;svg onload=alert(1)&gt;");
    }
  });
});
