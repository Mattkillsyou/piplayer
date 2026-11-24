// Recently deleted and uploads, the trash track's fixes (src/pages/library.js, src/uploads.js,
// migration 0019): two copies of one file restored together, the playlist order when only some
// files come back or two deletes share a second, the same post sent twice at once, a "/" in an
// upload's name, what an init and the Library page read from D1, Select all, and a file already
// in the library dropped again with Add to.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index.js";
import { MAX_DELETE, mergePlaces } from "../src/pages/library.js";
import { BASE, Client, query } from "./helpers.js";
import { audits, defaultPlaylistOf, ins, media, one, playlist, post, postJson, roles } from "./pages_common.js";

let r;
beforeAll(async () => {
  r = await roles();
});

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (data) => hex(await crypto.subtle.digest("SHA-256", data));
const bytes = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

// A file of the roles() editor (or of `owner`) with its object in R2.
async function file(name, owner) {
  const id = await media(name, "image", owner === undefined ? {} : { owner });
  const { filename, sha256 } = await one("SELECT filename, sha256 FROM media WHERE id = ?", id);
  await env.MEDIA.put(`media/${filename}`, new Uint8Array([1, 2, 3]));
  return { id, filename, sha256, name };
}
const fill = async (pid, files) => {
  for (const [i, f] of files.entries()) await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, ?)", pid, f.id, i);
};
// The playlist's files in order, by name.
const order = async (pid) => (await query(
  "SELECT m.original_name AS n FROM playlist_items pi JOIN media m ON m.id = pi.media_id WHERE pi.playlist_id = ? ORDER BY pi.position, pi.id", pid)).map((x) => x.n);
const names = (files) => files.map((f) => f.name);
const del = (c, files) => post(c, "/library/delete", files.map((f) => ["media_id", String(f.id)]));
const restore = (c, files) => trashIds(files).then((ids) => post(c, "/library/trash/restore", ids.map((id) => ["trash_id", String(id)])));
const trashIds = async (files) => (await query(`SELECT id FROM media_trash WHERE media_id IN (${files.map((f) => f.id).join(",")}) ORDER BY id`)).map((t) => t.id);
// [kind, message] of the notice the next Library page shows.
async function flash(c) {
  const m = /<div class="alert ([a-z]+)" role="alert">([^<]*)<\/div>/.exec(await (await c.get("/library")).text());
  return m ? [m[1], m[2]] : null;
}
// The notice a response sets ({m, k}).
const flashOf = (res) => {
  const c = res.headers.getSetCookie().find((x) => x.startsWith("piplayer_flash="));
  return c ? JSON.parse(decodeURIComponent(c.split(";")[0].slice("piplayer_flash=".length))) : null;
};
// A request straight to the worker as `c`, with `DB` in place of the real one.
const direct = (c, path, init, DB) => worker.fetch(new Request(BASE + path, { ...init, headers: { ...init.headers, cookie: c.cookie } }),
  { ...env, ...(DB ? { DB } : {}) }, createExecutionContext());
const form = (c, pairs) => ({
  method: "POST", body: new URLSearchParams([["csrf_token", c.token], ...pairs]), headers: { "content-type": "application/x-www-form-urlencoded" },
});
// The same form posted twice at once, each post held at its first D1 batch until both have read
// what they need: a double click whose second post reaches D1 before the first one's batch.
function twice(c, path, pairs) {
  let n = 0, open;
  const both = new Promise((res) => { open = res; });
  const DB = { prepare: (sql) => env.DB.prepare(sql), batch: async (s) => { if (++n === 2) open(); await both; return env.DB.batch(s); } };
  return Promise.all([direct(c, path, form(c, pairs), DB), direct(c, path, form(c, pairs), DB)]);
}
// A D1 that adds up the rows every statement reads (meta.rows_read).
function metered() {
  const log = [];
  const note = (res) => { log.push(res.meta.rows_read); return res; };
  const wrap = (s) => ({
    real: s,
    bind: (...p) => wrap(s.bind(...p)),
    all: () => s.all().then(note),
    run: () => s.run().then(note),
    first: (col) => s.all().then((res) => { const row = note(res).results[0] ?? null; return row && col !== undefined ? row[col] : row; }),
  });
  const DB = {
    prepare: (sql) => wrap(env.DB.prepare(sql)),
    batch: (stmts) => env.DB.batch(stmts.map((x) => x.real)).then((rs) => { rs.forEach(note); return rs; }),
  };
  return { DB, read: () => log.reduce((a, b) => a + b, 0) };
}
// A new signed-in editor account of its own (made on the Users page).
async function account(username) {
  expect((await post(r.admin, "/users", { username, password: `${username}-pass`, role: "editor" })).status).toBe(303);
  const c = new Client();
  expect((await c.login(username, `${username}-pass`)).status).toBe(303);
  c.token = await c.csrf("/dashboard");
  c.id = (await one("SELECT id FROM users WHERE username = ?", username)).id;
  return c;
}

describe("uploads and Recently deleted", () => {
  // init + its one part; returns the upload id.
  async function stage(c, name, data, sha) {
    const res = await postJson(c, "/library/upload/init", { name, size: data.length, sha256: sha || await digest(data), media_type: "image" });
    expect(res.status, await res.clone().text()).toBe(200);
    const { upload_id } = await res.json();
    expect((await c.fetch(`/library/upload/${upload_id}/part/1`, { method: "PUT", body: data, headers: { "X-CSRF-Token": c.token } })).status).toBe(200);
    return upload_id;
  }
  const complete = (c, id) => postJson(c, `/library/upload/${id}/complete`, { playlist: "none" });

  it("a \"/\" in the name of an upload of a file in Recently deleted cannot land on its stored name: a failed check leaves its bytes", async () => {
    const data = bytes(700, 1);
    const { media_id } = await (await complete(r.editor, await stage(r.editor, "photo.png", data))).json();
    const { filename } = await one("SELECT filename FROM media WHERE id = ?", media_id);
    expect((await post(r.editor, `/library/${media_id}/delete`)).status).toBe(303);
    const id = await stage(r.editor, "x/photo.png", bytes(700, 2), await digest(data)); // other bytes under the trashed file's sha256
    const { key } = await one("SELECT key FROM uploads WHERE id = ?", id);
    expect(key).not.toBe(`media/${filename}`);
    expect(key).toMatch(new RegExp(`^media/${filename.slice(0, 16)}_u${r.ids.editor}_[A-Za-z0-9-][A-Za-z0-9_-]*_photo\\.png$`));
    expect((await complete(r.editor, id)).status).toBe(400);
    expect(await digest(await (await env.MEDIA.get(`media/${filename}`)).arrayBuffer())).toBe(await digest(data));
  });

  it("an init reads its own rows of Recently deleted, not every account's", async () => {
    await query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
      INSERT INTO media_trash (owner_id, media_id, filename, original_name, media_type, size_bytes, sha256, uploaded_at, places)
      SELECT ?, 600000 + i, 'scan-' || i || '.png', 'scan-' || i || '.png', 'image', 1, printf('%064d', i), datetime('now'), '[]' FROM n`, r.ids.admin);
    const m = metered();
    const res = await direct(r.editor, "/library/upload/init", {
      method: "POST", body: JSON.stringify({ name: "fresh.png", size: 10, sha256: "e".repeat(64), media_type: "image" }),
      headers: { "content-type": "application/json", "X-CSRF-Token": r.editor.token },
    }, m.DB);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(m.read()).toBeLessThan(50);
  });
});

describe("a file already in the library, dropped again with Add to", () => {
  it("joins the playlist picked instead of the 409; already in it, it is left as it is; no choice or No playlist is the 409", async () => {
    const id = await media("dup.png");
    const { sha256 } = await one("SELECT sha256 FROM media WHERE id = ?", id);
    const p = await playlist("dup P");
    const again = (choice) => postJson(r.editor, "/library/upload/init", { name: "dup again.png", size: 1000, sha256, media_type: "image", ...choice });
    let res = await again({ playlist: String(p) });
    expect([res.status, await res.json()]).toEqual([200, { existing: true, added: true }]);
    expect(await query("SELECT media_id, position FROM playlist_items WHERE playlist_id = ?", p)).toEqual([{ media_id: id, position: 0 }]);
    const [a] = await audits("playlist_add_items");
    expect([a.username, a.target_id, a.details]).toEqual(["ed", String(p), `{"added": 1, "media_ids": [${id}]}`]);
    res = await again({ playlist: String(p) });
    expect([res.status, await res.json()]).toEqual([200, { existing: true, added: false }]);
    expect((await query("SELECT id FROM playlist_items WHERE playlist_id = ?", p)).length).toBe(1);
    // "" is the account's Default playlist
    res = await again({ playlist: "" });
    expect([res.status, await res.json()]).toEqual([200, { existing: true, added: true }]);
    expect(await one("SELECT media_id FROM playlist_items WHERE playlist_id = ? AND media_id = ?", await defaultPlaylistOf(r.ids.editor), id)).toEqual({ media_id: id });
    for (const choice of [{}, { playlist: "none" }]) {
      res = await again(choice);
      expect([res.status, await res.json()]).toEqual([409, { detail: "Already in the library as 'dup.png'." }]);
    }
    // another account's playlist: a missing one
    res = await again({ playlist: String(await playlist("their P", r.ids.admin)) });
    expect([res.status, await res.json()]).toEqual([404, { detail: "Playlist not found" }]);
    expect(await query("SELECT id FROM uploads WHERE sha256 = ?", sha256)).toEqual([]);
  });

  it("through an upload link the answer stays {existing: true}, whatever playlist the body names", async () => {
    const id = await media("dup-link.png");
    const { sha256 } = await one("SELECT sha256 FROM media WHERE id = ?", id);
    const p = await playlist("dup link P");
    const made = await post(r.editor, "/settings/links", { name: "Dup" });
    const token = /id="new-upload-link" value="[^"]*\/u\/([^"]+)"/.exec(await made.text())[1];
    const res = await new Client().postJson(`/api/link/${token}/upload/init`, { name: "x.png", size: 1000, sha256, playlist: String(p) });
    expect([res.status, await res.json()]).toEqual([200, { existing: true }]);
    expect(await query("SELECT id FROM playlist_items WHERE playlist_id = ?", p)).toEqual([]);
  });
});

describe("the Library page's Recently deleted", () => {
  it("Select all sits before Restore selected, which stays the form's first submit button", async () => {
    const c = await account("selector");
    const f = await file("sel.png", c.id);
    expect((await del(c, [f])).status).toBe(303);
    const html = await (await c.get("/library")).text();
    const at = html.indexOf('action="/library/trash/restore"');
    expect(at).toBeGreaterThan(0);
    expect(html.indexOf('<button type="button" class="small" data-select-trash>Select all</button>\n      <button type="submit" class="small">Restore selected</button>', at)).toBeGreaterThan(at);
  });

  it("past the list's cap: the count is right, each delete's time is formatted once, and the rows are read about once", async () => {
    const c = await account("bigtrash");
    const n = MAX_DELETE + 100;
    await query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
      INSERT INTO media_trash (owner_id, media_id, filename, original_name, media_type, size_bytes, sha256, uploaded_at, places, deleted_at)
      SELECT ?1, 700000 + i, 'big-' || i || '.png', 'big-' || i || '.png', 'image', 1, printf('%064d', i), datetime('now'), '[]', '2026-11-20 10:00:00.000' FROM n`, c.id, n);
    const m = metered();
    const parts = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    const res = await direct(c, "/library", { method: "GET", headers: {} }, m.DB);
    const html = await res.text();
    const formatted = parts.mock.calls.length;
    parts.mockRestore();
    expect(html).toContain(`<summary>Recently deleted (${n})</summary>`);
    expect(html.match(/name="trash_id"/g).length).toBe(MAX_DELETE);
    expect(formatted).toBeLessThan(10);
    expect(m.read()).toBeLessThan(MAX_DELETE + n + 100);
  });
});
