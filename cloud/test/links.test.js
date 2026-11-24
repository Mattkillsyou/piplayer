// Upload links (migration 0017, src/pages/links.js): an address made on the Settings page that
// lets someone with no account put files on that account's projectors. Covers making and
// revoking a link (the address is shown once, only its hash is stored), the page it opens, the
// chunk protocol driven by the token alone, sending files to projectors (each gets its own
// "Upload link · <device id>" playlist holding just those files, in place of what it played;
// the account's own playlists are left as they were), and that a link reaches nothing outside its
// account and nothing at all once revoked or once its account can no longer upload.
import { beforeAll, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as db from "../src/db.js";
import * as manifest from "../src/manifest.js";
import * as links from "../src/pages/links.js";
import { wallClock } from "../src/util.js";
import { Client, query } from "./helpers.js";
import { audits, defaultPlaylistOf, detail, device, ins, one, playlist, post, roles } from "./pages_common.js";

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (data) => hex(await crypto.subtle.digest("SHA-256", data));
const fakeFile = (size, seed) => Uint8Array.from({ length: size }, (_, i) => (i * seed + 7) & 0xff);
const anon = new Client(); // no cookie, no CSRF token: what the holder of a link has
const itemsOf = (pid) => query(
  "SELECT m.original_name FROM playlist_items pi JOIN media m ON m.id = pi.media_id WHERE pi.playlist_id = ? ORDER BY pi.position", pid)
  .then((rows) => rows.map((x) => x.original_name));
const playlistOf = async (dev) => (await one("SELECT playlist_id FROM devices WHERE id = ?", dev.id)).playlist_id;
const playingOn = async (dev) => manifest.resolve_active_playlist_id(env,
  await one("SELECT id, playlist_id, group_id, owner_id FROM devices WHERE id = ?", dev.id), wallClock("UTC"));

let r, token, api, hall, den, adminDev;

// Make a link as `client` on the Settings page; returns {token, html}.
async function makeLink(client, name) {
  const res = await post(client, "/settings/links", { name });
  expect(res.status, await res.clone().text()).toBe(200);
  const html = await res.text();
  const m = /id="new-upload-link" value="([^"]+)"/.exec(html);
  expect(m, "the new address is on the page").not.toBeNull();
  return { url: m[1], token: m[1].split("/u/")[1], html };
}

// The whole chunk protocol through a link, one part. Returns the last response.
async function send(base, name, data, { media_type = "image" } = {}) {
  const init = await anon.postJson(`${base}/upload/init`, { name, size: data.length, sha256: await digest(data), media_type });
  if (init.status !== 200) return init;
  const body = await init.json();
  if (body.existing) return new Response(JSON.stringify(body));
  const part = await anon.fetch(`${base}/upload/${body.upload_id}/part/1`, { method: "PUT", body: data });
  expect(part.status, await part.clone().text()).toBe(200);
  return anon.postJson(`${base}/upload/${body.upload_id}/complete`, {});
}

beforeAll(async () => {
  r = await roles();
  hall = await device("hall", "Hall", { last_seen_at: new Date().toISOString().slice(0, 19).replace("T", " ") }); // the editor's, on
  den = await device("den", "Den"); // the editor's, never seen: off
  adminDev = await device("admin-wall", "Admin Wall", { owner_id: r.ids.admin });
  ({ token } = await makeLink(r.editor, "Ava"));
  api = `/api/link/${token}`;
});

describe("making and revoking a link (Settings page)", () => {
  it("shows the address once, stores only its hash, lists the link and audits its name", async () => {
    const made = await makeLink(r.editor, "Guest <b>");
    expect(made.url).toMatch(/^https?:\/\/[^/]+\/u\/[A-Za-z0-9_-]{32}$/);
    const rows = await query("SELECT name, token_hash, user_id, last_used_at FROM upload_links WHERE user_id = ? ORDER BY id", r.ids.editor);
    expect(rows.map((x) => x.name)).toEqual(["Ava", "Guest <b>"]);
    expect(rows[1].token_hash).toBe(await digest(new TextEncoder().encode(made.token)));
    expect(JSON.stringify(rows)).not.toContain(made.token);
    expect(made.html).toContain("New upload link (copy it now, it is not shown again):");
    expect(made.html).toContain("Guest &lt;b&gt;"); // escaped in the table and the confirm text
    expect(made.html).not.toContain("Guest <b>");
    // the page loaded again no longer has the address
    const again = await (await r.editor.get("/settings")).text();
    expect(again).toContain("<h2>Upload links</h2>");
    expect(again).not.toContain(made.token);
    expect(again).toContain("Revoke the upload link Ava? Its address stops working.");
    const [a] = await audits("upload_link_created");
    expect([a.username, a.target_type, JSON.parse(a.details)]).toEqual(["ed", "upload_link", { name: "Guest <b>" }]);
    expect(a.details).not.toContain(made.token);
  });

  it("refuses an empty or over-long name and lists nobody else's links", async () => {
    expect(await detail(await post(r.editor, "/settings/links", { name: "  " }), 400)).toBe("Link name must be 1-60 characters");
    expect(await detail(await post(r.editor, "/settings/links", { name: "x".repeat(61) }), 400)).toBe("Link name must be 1-60 characters");
    expect(await (await r.admin.get("/settings")).text()).not.toContain("Revoke the upload link Ava?");
  });

  it("a link is revoked by its own account only, and its address stops working at once", async () => {
    const made = await makeLink(r.editor, "Short-lived");
    const row = await one("SELECT id FROM upload_links WHERE name = 'Short-lived'");
    expect((await anon.get(`/u/${made.token}`)).status).toBe(200);
    expect(await detail(await post(r.admin, `/settings/links/${row.id}/revoke`), 404)).toBe("upload link not found"); // another account's: a missing one
    expect((await anon.get(`/u/${made.token}`)).status).toBe(200);
    const res = await post(r.editor, `/settings/links/${row.id}/revoke`);
    expect([res.status, res.headers.get("location")]).toEqual([303, "/settings"]);
    expect(await query("SELECT id FROM upload_links WHERE id = ?", row.id)).toEqual([]);
    const gone = await anon.get(`/u/${made.token}`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain(links.LINK_GONE);
    expect(await detail(await anon.postJson(`/api/link/${made.token}/play`, { media: ["a".repeat(64)], devices: [hall.id] }), 404)).toBe(links.LINK_GONE);
    expect(JSON.parse((await audits("upload_link_revoked"))[0].details)).toEqual({ name: "Short-lived" });
  });
});

describe("the page behind a link", () => {
  it("opens with no session, lists the account's projectors only, on or off, and wires upload.js to the link's routes", async () => {
    const res = await anon.get(`/u/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull(); // no session is started
    const html = await res.text();
    expect(html).toContain(`<form id="upload-form" class="link-form" data-init="${api}/upload/init" data-base="${api}/upload" data-play="${api}/play" data-max-files="50">`);
    expect(html).not.toContain('method="post"'); // without upload.js a submit loads this page again, it does not leave for the API
    expect(html).toContain('<script src="/static/sha256.js"></script>');
    expect(html).toContain('<script src="/static/upload.js"></script>');
    expect(html).toMatch(new RegExp(`value="${hall.id}">Hall\\s+<span class="status status-playing"><span class="lamp"></span>online</span>`));
    expect(html).toMatch(new RegExp(`value="${den.id}">Den\\s+<span class="status status-offline"><span class="lamp"></span>offline</span>`));
    expect(html).not.toContain("Admin Wall"); // another account's projector
    expect(html).not.toContain(" checked"); // two projectors: the sender picks
    expect(html).not.toContain('<nav id="site-nav"'); // nothing of the console
    expect(html).not.toContain("tok-hall"); // no device token, no library
  });

  it("ticks the projector when the account has just one; says so when it has none", async () => {
    const solo = await makeLink(r.admin, "Solo");
    expect(await (await anon.get(`/u/${solo.token}`)).text()).toMatch(new RegExp(`name="device" value="${adminDev.id}" checked>Admin Wall`));
    await query("UPDATE devices SET owner_id = ? WHERE id = ?", r.ids.viewer, adminDev.id);
    const html = await (await anon.get(`/u/${solo.token}`)).text();
    expect(html).toContain("No projectors here yet.");
    expect(html).not.toContain("upload-form");
    await query("UPDATE devices SET owner_id = ? WHERE id = ?", r.ids.admin, adminDev.id);
  });

  it("an unknown, malformed or other-length token is the same 404 page, and the API the same 404 JSON", async () => {
    for (const t of ["A".repeat(32), "short", "A".repeat(33), "%3Cscript%3E"]) {
      const res = await anon.get(`/u/${t}`);
      expect(res.status, t).toBe(404);
      const html = await res.text();
      expect(html, t).toContain(links.LINK_GONE);
      expect(html, t).not.toContain("<script>"); // the page's own tags are <script src=...>: the token is never echoed
      expect(await detail(await anon.postJson(`/api/link/${t}/upload/init`, {}), 404), t).toBe(links.LINK_GONE);
      expect(await detail(await anon.get(`/api/link/${t}/upload/x`), 404), t).toBe(links.LINK_GONE);
    }
  });
});

describe("uploading and sending through a link", () => {
  const A = fakeFile(300, 3), B = fakeFile(500, 5), C = fakeFile(700, 11);
  let EDITOR_DEFAULT, own;

  beforeAll(async () => {
    EDITOR_DEFAULT = await defaultPlaylistOf(r.ids.editor);
    own = await playlist("Evening loop"); // the editor's own playlist, assigned to Hall
    await query("UPDATE devices SET playlist_id = ? WHERE id = ?", own, hall.id);
  });

  it("the file lands in the link's account's library and in no playlist; the audit row names the link", async () => {
    const done = await send(api, "party.png", A);
    expect(done.status, await done.clone().text()).toBe(200);
    const { media_id } = await done.json();
    const row = await one("SELECT original_name, owner_id, sha256, filename FROM media WHERE id = ?", media_id);
    expect(row).toEqual({ original_name: "party.png", owner_id: r.ids.editor, sha256: await digest(A), filename: `${(await digest(A)).slice(0, 16)}_u${r.ids.editor}_party.png` });
    expect(await query("SELECT playlist_id FROM playlist_items WHERE media_id = ?", media_id)).toEqual([]); // not Default: only where the sender points it
    expect(await itemsOf(EDITOR_DEFAULT)).toEqual([]);
    const [a] = await audits("upload_media");
    expect([a.username, JSON.parse(a.details)]).toEqual([null, { filename: "party.png", type: "image", link: "Ava" }]);
    expect((await one("SELECT owner_id FROM audit_log WHERE action = 'upload_media' ORDER BY id DESC LIMIT 1")).owner_id).toBe(r.ids.editor);
    // the bytes are the ones sent (uploadComplete verified the hash)
    expect(new Uint8Array(await (await env.MEDIA.get("media/" + row.filename)).arrayBuffer())).toEqual(A);
  });

  it("play puts the files on the chosen projector in place of what it played, and leaves the account's playlists alone", async () => {
    expect((await send(api, "second.png", B)).status).toBe(200);
    const shaA = await digest(A), shaB = await digest(B);
    const res = await anon.postJson(`${api}/play`, { media: [shaB, shaA.toUpperCase()], devices: [hall.id] });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({
      devices: [{ id: hall.id, name: "Hall", on: true, scheduled: false }],
      message: "Sent to Hall. It starts once the projector has downloaded it.",
    });
    const pid = await playlistOf(hall);
    expect(pid).not.toBe(own);
    expect(await one("SELECT name, owner_id FROM playlists WHERE id = ?", pid)).toEqual({ name: "Upload link · hall", owner_id: r.ids.editor });
    expect(await itemsOf(pid)).toEqual(["second.png", "party.png"]); // the order sent
    expect(await playingOn(hall)).toEqual([pid, "device-default"]); // what its manifest serves now
    // nothing of the account's own changed, and the other projector was not touched
    expect(await one("SELECT name FROM playlists WHERE id = ?", own)).toEqual({ name: "Evening loop" });
    expect(await itemsOf(EDITOR_DEFAULT)).toEqual([]);
    expect(await playlistOf(den)).toBeNull();
    expect((await one("SELECT last_used_at FROM upload_links WHERE name = 'Ava'")).last_used_at).not.toBeNull();
    const [a] = await audits("upload_link_play");
    expect([a.username, a.target_type, JSON.parse(a.details)]).toEqual([null, "upload_link", { link: "Ava", devices: ["hall"], files: ["second.png", "party.png"] }]);
    expect((await one("SELECT owner_id FROM audit_log WHERE action = 'upload_link_play' ORDER BY id DESC LIMIT 1")).owner_id).toBe(r.ids.editor);
  });

  it("the next send replaces the projector's upload playlist rather than adding to it, reusing the same playlist", async () => {
    const before = await playlistOf(hall);
    expect((await send(api, "third.png", C)).status).toBe(200);
    const res = await anon.postJson(`${api}/play`, { media: [await digest(C)], devices: [hall.id, den.id] });
    expect((await res.json()).message).toBe("Sent to Hall. It starts once the projector has downloaded it. Den is offline and will play it when back online.");
    expect(await playlistOf(hall)).toBe(before);
    expect(await itemsOf(before)).toEqual(["third.png"]);
    const denPid = await playlistOf(den);
    expect(denPid).not.toBe(before); // one playlist per projector: sending to one never changes another
    expect(await one("SELECT name FROM playlists WHERE id = ?", denPid)).toEqual({ name: "Upload link · den" });
    expect(await itemsOf(denPid)).toEqual(["third.png"]);
    expect((await query("SELECT id FROM playlists WHERE owner_id = ? AND name LIKE 'Upload link%'", r.ids.editor)).length).toBe(2);
    // the files sent earlier stay in the library
    expect((await query("SELECT id FROM media WHERE owner_id = ?", r.ids.editor)).length).toBe(3);
  });

  it("a file the library already holds needs no upload and can be sent as it is", async () => {
    const again = await anon.postJson(`${api}/upload/init`, { name: "renamed.png", size: A.length, sha256: await digest(A), media_type: "image" });
    expect([again.status, await again.json()]).toEqual([200, { existing: true }]);
    expect(await query("SELECT id FROM uploads")).toEqual([]); // nothing was opened
    const res = await anon.postJson(`${api}/play`, { media: [await digest(A)], devices: [den.id] });
    expect(res.status).toBe(200);
    expect(await itemsOf(await playlistOf(den))).toEqual(["party.png"]);
    // the Library page still refuses a duplicate, in its own words
    const lib = await r.editor.postJson("/library/upload/init", { name: "renamed.png", size: A.length, sha256: await digest(A), media_type: "image" }, { "X-CSRF-Token": r.editor.token });
    expect(await detail(lib, 409)).toBe("Already in the library as 'party.png'.");
  });

  it("an upload made on the Library page still joins Default and is audited as the user's", async () => {
    const D = fakeFile(900, 13);
    const init = await r.editor.postJson("/library/upload/init", { name: "mine.png", size: D.length, sha256: await digest(D), media_type: "image" }, { "X-CSRF-Token": r.editor.token });
    const { upload_id } = await init.json();
    await r.editor.fetch(`/library/upload/${upload_id}/part/1`, { method: "PUT", body: D, headers: { "X-CSRF-Token": r.editor.token } });
    const done = await r.editor.postJson(`/library/upload/${upload_id}/complete`, {}, { "X-CSRF-Token": r.editor.token });
    expect(done.status).toBe(200);
    expect(await itemsOf(EDITOR_DEFAULT)).toEqual(["mine.png"]);
    const [a] = await audits("upload_media");
    expect([a.username, JSON.parse(a.details)]).toEqual(["ed", { filename: "mine.png", type: "image", playlist: EDITOR_DEFAULT }]);
  });

  it("play refuses a malformed body, a file that is not in the account's library and a projector that is not the account's", async () => {
    const shaA = await digest(A);
    const before = await query("SELECT id, playlist_id FROM devices ORDER BY id");
    const bad = [
      [{}, 400, "media must be a list of sha256 values"],
      [{ media: [], devices: [hall.id] }, 400, "media must be a list of sha256 values"],
      [{ media: ["nope"], devices: [hall.id] }, 400, "media must be a list of sha256 values"],
      [{ media: Array(51).fill(shaA), devices: [hall.id] }, 400, "Send at most 50 files at a time"],
      [{ media: [shaA] }, 400, "Pick at least one projector"],
      [{ media: [shaA], devices: [] }, 400, "Pick at least one projector"],
      [{ media: [shaA], devices: ["1"] }, 400, "Pick at least one projector"],
      [{ media: [shaA], devices: [1.5] }, 400, "Pick at least one projector"],
      [{ media: ["f".repeat(64)], devices: [hall.id] }, 404, "A file is no longer in the library. Upload it again."],
      [{ media: [shaA], devices: [adminDev.id] }, 404, "Projector not found"], // another account's
      [{ media: [shaA], devices: [hall.id, 999999] }, 404, "Projector not found"], // one bad id sends nothing
    ];
    for (const [body, status, msg] of bad) expect(await detail(await anon.postJson(`${api}/play`, body), status), JSON.stringify(body).slice(0, 80)).toBe(msg);
    const raw = await anon.fetch(`${api}/play`, { method: "POST", body: "not json" });
    expect(await detail(raw, 400)).toBe("body must be a JSON object");
    expect(await query("SELECT id, playlist_id FROM devices ORDER BY id")).toEqual(before);
  });

  it("the same file sent twice plays twice; a file of another account cannot be sent", async () => {
    const shaA = await digest(A);
    await anon.postJson(`${api}/play`, { media: [shaA, shaA], devices: [den.id] });
    expect(await itemsOf(await playlistOf(den))).toEqual(["party.png", "party.png"]);
    // the admin's own copy of other bytes is not in the editor's library
    const mine = await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id) VALUES ('adm.png', 'adm.png', 'image', 1, ?, ?)", "e".repeat(64), r.ids.admin);
    expect(await detail(await anon.postJson(`${api}/play`, { media: ["e".repeat(64)], devices: [den.id] }), 404)).toBe("A file is no longer in the library. Upload it again.");
    await query("DELETE FROM media WHERE id = ?", mine);
  });

  it("an upload opened through one link is the account's: its own session sees it, another link of another account does not", async () => {
    const E = fakeFile(1200, 17);
    const init = await anon.postJson(`${api}/upload/init`, { name: "half.png", size: E.length, sha256: await digest(E), media_type: "image" });
    const { upload_id } = await init.json();
    expect((await r.editor.get(`/library/upload/${upload_id}`)).status).toBe(200);
    const other = await makeLink(r.admin, "Other account");
    expect(await detail(await anon.get(`/api/link/${other.token}/upload/${upload_id}`), 404)).toBe("Upload not found");
    expect(await detail(await anon.fetch(`/api/link/${other.token}/upload/${upload_id}/part/1`, { method: "PUT", body: E }), 404)).toBe("Upload not found");
    expect(await detail(await anon.postJson(`/api/link/${other.token}/upload/${upload_id}/complete`, {}), 404)).toBe("Upload not found");
    // and the link itself reads its own upload's progress
    expect(await (await anon.get(`${api}/upload/${upload_id}`)).json()).toEqual({ received: 0, size: E.length, part_size: 8 * 1024 * 1024, parts: [] });
    await query("DELETE FROM uploads WHERE id = ?", upload_id);
  });

  it("init applies the Library's rules: file type, size and hash are checked the same way", async () => {
    const base = { name: "x.png", size: 10, sha256: "a".repeat(64), media_type: "image" };
    expect(await detail(await anon.postJson(`${api}/upload/init`, { ...base, name: "x.exe" }), 400)).toContain("That file type (.exe) is not supported.");
    expect(await detail(await anon.postJson(`${api}/upload/init`, { ...base, size: 0 }), 400)).toBe("empty file");
    expect(await detail(await anon.postJson(`${api}/upload/init`, { ...base, sha256: "zz" }), 400)).toBe("sha256 must be 64 hex chars");
    expect(await detail(await anon.postJson(`${api}/upload/init`, { ...base, size: 6 * 2 ** 30 }), 413)).toContain("the limit is");
  });

  it("a schedule rule running on the projector still wins until it ends, and the answer says so", async () => {
    const ruled = await playlist("Scheduled");
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'always', 1)", hall.id, ruled);
    // a rule that is not running now holds nothing
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_date, end_date) VALUES (?, ?, 'over', 9, '2020-01-01', '2020-01-02')", den.id, ruled);
    const res = await anon.postJson(`${api}/play`, { media: [await digest(A)], devices: [hall.id, den.id] });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    expect(body.devices).toEqual([{ id: den.id, name: "Den", on: false, scheduled: false }, { id: hall.id, name: "Hall", on: true, scheduled: true }]);
    expect(body.message).toBe("Sent. Hall has a schedule running and will play it when that ends. Den is offline and will play it when back online.");
    expect(await itemsOf(await playlistOf(hall))).toEqual(["party.png"]); // sent all the same (it held third.png before)
    expect(await playingOn(hall)).toEqual([ruled, "schedule:always"]);
    // a rule that plays the projector's own upload playlist holds nothing back: it plays what was sent
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'mine', 5)", hall.id, await playlistOf(hall));
    const again = await anon.postJson(`${api}/play`, { media: [await digest(A)], devices: [hall.id, den.id] });
    expect(again.status, await again.clone().text()).toBe(200);
    expect((await again.json()).message).toBe("Sent to Hall. It starts once the projector has downloaded it. Den is offline and will play it when back online.");
    await query("DELETE FROM device_schedules WHERE device_id IN (?, ?)", hall.id, den.id);
    expect((await playingOn(hall))[1]).toBe("device-default"); // the upload plays once the rule is gone
  });

  it("a file of several parts goes through a link like through the Library, and picks up where it stopped", async () => {
    const PART = 8 * 1024 * 1024;
    const big = fakeFile(PART + 5, 37);
    const body = { name: "long.mp4", size: big.length, sha256: await digest(big), media_type: "video", duration_seconds: 3, width: 1920, height: 1080 };
    const first = await (await anon.postJson(`${api}/upload/init`, body)).json();
    expect(first).toEqual({ upload_id: first.upload_id, part_size: PART, received: 0 });
    const p2 = await anon.fetch(`${api}/upload/${first.upload_id}/part/2`, { method: "PUT", body: big.subarray(PART) });
    expect([p2.status, await p2.json()]).toEqual([200, { received: 5 }]);
    // the page was loaded again: the same file is handed the upload in flight and what it holds
    expect(await (await anon.postJson(`${api}/upload/init`, body)).json()).toEqual({ upload_id: first.upload_id, part_size: PART, received: 5 });
    expect((await (await anon.get(`${api}/upload/${first.upload_id}`)).json()).parts).toEqual([2]);
    expect(await detail(await anon.postJson(`${api}/upload/${first.upload_id}/complete`, {}), 400)).toContain("upload incomplete");
    expect((await anon.fetch(`${api}/upload/${first.upload_id}/part/1`, { method: "PUT", body: big.subarray(0, PART) })).status).toBe(200);
    const done = await anon.postJson(`${api}/upload/${first.upload_id}/complete`, {});
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await one("SELECT original_name, media_type, size_bytes, width, height, owner_id FROM media WHERE id = ?", (await done.json()).media_id))
      .toEqual({ original_name: "long.mp4", media_type: "video", size_bytes: PART + 5, width: 1920, height: 1080, owner_id: r.ids.editor });
  });

  it("picking another playlist on the Devices page puts the projector back; the upload playlist can be deleted like any other", async () => {
    const res = await post(r.editor, `/devices/${hall.id}/assign`, { playlist_id: String(own) });
    expect(res.status).toBe(303);
    expect(await playingOn(hall)).toEqual([own, "device-default"]);
    const pid = (await one("SELECT id FROM playlists WHERE owner_id = ? AND name = 'Upload link · hall'", r.ids.editor)).id;
    expect((await post(r.editor, `/playlists/${pid}/delete`)).status).toBe(303);
    // the next send makes it again
    await anon.postJson(`${api}/play`, { media: [await digest(A)], devices: [hall.id] });
    expect(await one("SELECT name FROM playlists WHERE id = ?", await playlistOf(hall))).toEqual({ name: "Upload link · hall" });
  });

  it("deleting what was sent on the Library page takes it off the projector: back to its Default, not a standby screen", async () => {
    const H = fakeFile(333, 29), I = fakeFile(444, 31);
    expect((await send(api, "wall-1.png", H)).status).toBe(200);
    expect((await send(api, "wall-2.png", I)).status).toBe(200);
    expect((await anon.postJson(`${api}/play`, { media: [await digest(H), await digest(I)], devices: [den.id] })).status).toBe(200);
    const pid = await playlistOf(den);
    const idOf = async (name) => (await one("SELECT id FROM media WHERE original_name = ? AND owner_id = ?", name, r.ids.editor)).id;
    // one of the two gone: the projector stays on what is left
    expect((await post(r.editor, `/library/${await idOf("wall-1.png")}/delete`)).status).toBe(303);
    expect(await playlistOf(den)).toBe(pid);
    expect(await itemsOf(pid)).toEqual(["wall-2.png"]);
    expect(JSON.parse((await audits("delete_media"))[0].details).devices_cleared).toBeUndefined();
    // the last one gone: no playlist of its own any more, so the account's Default plays
    expect((await post(r.editor, `/library/${await idOf("wall-2.png")}/delete`)).status).toBe(303);
    expect(await playlistOf(den)).toBeNull();
    expect(JSON.parse((await audits("delete_media"))[0].details)).toMatchObject({ filename: "wall-2.png", devices_cleared: [den.id] });
    expect(await playingOn(den)).toEqual([EDITOR_DEFAULT, "site-default"]);
    // only an upload link's playlist falls back: one the owner made and emptied keeps its projector,
    // also when its name is a link's in another case
    const mine = await playlist("upload link · den");
    const mid = await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id) VALUES ('own-x.png', 'own-x.png', 'image', 1, ?, ?)", "9".repeat(64), r.ids.editor);
    await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", mine, mid);
    await query("UPDATE devices SET playlist_id = ? WHERE id = ?", mine, den.id);
    expect((await post(r.editor, `/library/${mid}/delete`)).status).toBe(303);
    expect(await playlistOf(den)).toBe(mine);
    await query("UPDATE devices SET playlist_id = NULL WHERE id = ?", den.id);
  });

  it("Delete selected names the projector it took off an upload playlist on the audit row of that playlist's file only", async () => {
    const J = fakeFile(555, 41);
    expect((await send(api, "wall-3.png", J)).status).toBe(200);
    expect((await anon.postJson(`${api}/play`, { media: [await digest(J)], devices: [den.id] })).status).toBe(200);
    expect(await playlistOf(den)).not.toBeNull();
    const wall = (await one("SELECT id FROM media WHERE original_name = 'wall-3.png' AND owner_id = ?", r.ids.editor)).id;
    const plain = await ins("INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id) VALUES ('plain-k.png', 'plain-k.png', 'image', 1, ?, ?)", "8".repeat(64), r.ids.editor);
    const res = await post(r.editor, "/library/delete", [["media_id", String(plain)], ["media_id", String(wall)]]);
    expect(res.status).toBe(303);
    expect(await playlistOf(den)).toBeNull();
    const rows = Object.fromEntries((await audits("delete_media")).slice(0, 2).map((a) => [Number(a.target_id), JSON.parse(a.details)]));
    expect(rows[plain]).toEqual({ filename: "plain-k.png", playlists: [] });
    expect(rows[wall]).toMatchObject({ filename: "wall-3.png", devices_cleared: [den.id] });
  });

  it("from a browser that is signed in to the console a link still acts as the link: its own account, no user on the audit rows", async () => {
    const G = fakeFile(410, 23);
    // the admin's session cookie rides along on the editor's link (and /api/link needs no CSRF token)
    const init = await r.admin.postJson(`${api}/upload/init`, { name: "visitor.png", size: G.length, sha256: await digest(G), media_type: "image" });
    const { upload_id } = await init.json();
    expect((await r.admin.fetch(`${api}/upload/${upload_id}/part/1`, { method: "PUT", body: G })).status).toBe(200);
    const done = await r.admin.postJson(`${api}/upload/${upload_id}/complete`, {});
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await one("SELECT owner_id FROM media WHERE original_name = 'visitor.png'")).toEqual({ owner_id: r.ids.editor });
    const up = await one("SELECT user_id, username, owner_id, details FROM audit_log WHERE action = 'upload_media' ORDER BY id DESC LIMIT 1");
    expect([up.user_id, up.username, up.owner_id, JSON.parse(up.details).link]).toEqual([null, null, r.ids.editor, "Ava"]);
    expect((await r.admin.postJson(`${api}/play`, { media: [await digest(G)], devices: [den.id] })).status).toBe(200);
    expect(await one("SELECT user_id, username, owner_id FROM audit_log WHERE action = 'upload_link_play' ORDER BY id DESC LIMIT 1"))
      .toEqual({ user_id: null, username: null, owner_id: r.ids.editor });
    // the page is the link's too: the editor's projectors, whoever is signed in
    const html = await (await r.admin.get(`/u/${token}`)).text();
    expect(html).toContain(`value="${hall.id}">Hall`);
    expect(html).not.toContain("Admin Wall");
  });

  it("the site admin's link also reaches the projectors nobody owns, as its Dashboard does", async () => {
    const loose = await device("loose", "Loose", { owner_id: null });
    const adminLink = await makeLink(r.admin, "House");
    const html = await (await anon.get(`/u/${adminLink.token}`)).text();
    expect(html).toContain(`value="${loose.id}">Loose`);
    expect(html).not.toContain(`value="${hall.id}"`); // the editor's: not the admin's content
    const F = fakeFile(640, 19);
    expect((await send(`/api/link/${adminLink.token}`, "house.png", F)).status).toBe(200);
    const res = await anon.postJson(`/api/link/${adminLink.token}/play`, { media: [await digest(F)], devices: [loose.id, adminDev.id] });
    expect(res.status, await res.clone().text()).toBe(200);
    const pid = await playlistOf(loose);
    expect(await one("SELECT name, owner_id FROM playlists WHERE id = ?", pid)).toEqual({ name: "Upload link · loose", owner_id: r.ids.admin });
    expect(await playingOn(loose)).toEqual([pid, "device-default"]);
    expect(await detail(await anon.postJson(`/api/link/${adminLink.token}/play`, { media: [await digest(F)], devices: [hall.id] }), 404)).toBe("Projector not found");
  });
});

describe("a link stops with its account", () => {
  it("an account demoted to viewer can no longer upload, and neither can its links; deleting the account deletes them", async () => {
    const res = await post(r.admin, "/users", { username: "tmp", password: "tmp-pass-1", role: "editor" });
    expect(res.status).toBe(303);
    const tmpId = (await one("SELECT id FROM users WHERE username = 'tmp'")).id;
    const tmp = new Client();
    await tmp.login("tmp", "tmp-pass-1");
    tmp.token = await tmp.csrf("/dashboard");
    const made = await makeLink(tmp, "Tmp link");
    expect((await anon.get(`/u/${made.token}`)).status).toBe(200);
    expect((await post(r.admin, `/users/${tmpId}/role`, { role: "viewer" })).status).toBe(303);
    expect((await anon.get(`/u/${made.token}`)).status).toBe(404);
    expect(await detail(await anon.postJson(`/api/link/${made.token}/upload/init`, { name: "x.png", size: 1, sha256: "a".repeat(64) }), 404)).toBe(links.LINK_GONE);
    expect(await detail(await anon.postJson(`/api/link/${made.token}/play`, { media: ["a".repeat(64)], devices: [hall.id] }), 404)).toBe(links.LINK_GONE);
    expect((await post(r.admin, `/users/${tmpId}/role`, { role: "editor" })).status).toBe(303);
    expect((await anon.get(`/u/${made.token}`)).status).toBe(200); // the link itself was never removed
    expect((await post(r.admin, `/users/${tmpId}/delete`)).status).toBe(303);
    expect(await query("SELECT id FROM upload_links WHERE user_id = ?", tmpId)).toEqual([]);
    expect((await anon.get(`/u/${made.token}`)).status).toBe(404);
  });
});

describe("the upload host (PIPLAYER_UPLOAD_HOST)", () => {
  const HOST = "http://upload.projection5000.com"; // wrangler.toml PIPLAYER_UPLOAD_HOST
  const TOKEN = "upload-host-test-token-012345678"; // vitest.config.js PIPLAYER_UPLOAD_TOKEN
  const at = (path, init = {}) => SELF.fetch(HOST + path, { redirect: "manual", ...init });

  it("is the configured link's page at / for anyone, passes its routes and the static files, sends the rest to /, and stops with the link", async () => {
    const id = await ins("INSERT INTO upload_links (user_id, name, token_hash) VALUES (?, 'upload host', ?)",
      r.ids.editor, await digest(new TextEncoder().encode(TOKEN)));
    const page = await at("/");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`data-init="/api/link/${TOKEN}/upload/init"`);
    expect(html).toMatch(new RegExp(`value="${den.id}">Den`));
    expect(html).toMatch(new RegExp(`value="${hall.id}">Hall`));
    expect((await at("/static/upload.js")).status).toBe(200);
    for (const path of ["/login", "/dashboard", "/settings", `/u/${token}`]) {
      const res = await at(path);
      expect([path, res.status, res.headers.get("location")]).toEqual([path, 302, "/"]);
    }
    // the name with its trailing dot is the same host
    const dotted = await SELF.fetch("http://upload.projection5000.com./login", { redirect: "manual" });
    expect([dotted.status, dotted.headers.get("location")]).toEqual([302, "/"]);
    // the page's own routes answer on this host (a file the library holds: nothing is created)
    const known = await one("SELECT sha256, size_bytes, media_type FROM media WHERE owner_id = ? ORDER BY id LIMIT 1", r.ids.editor);
    const init = await at(`/api/link/${TOKEN}/upload/init`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "again.png", size: known.size_bytes, sha256: known.sha256, media_type: known.media_type }) });
    expect(init.status, await init.clone().text()).toBe(200);
    expect(await init.json()).toMatchObject({ existing: true });
    // revoking the link switches the host off
    await env.DB.prepare("DELETE FROM upload_links WHERE id = ?").bind(id).run();
    const gone = await at("/");
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain(links.LINK_GONE);
  });

  it("changes nothing on the other hosts", async () => {
    expect((await anon.get(`/u/${token}`)).status).toBe(200);
    expect((await anon.get("/login")).status).toBe(200);
  });
});

describe("projectors left off upload links (Settings page)", () => {
  const save = (ids, listed = [hall.id, den.id, ...ids]) => r.editor.post("/settings/links/projectors",
    [...listed.map((id) => ["listed", String(id)]), ...ids.map((id) => ["device", String(id)])], { "X-CSRF-Token": r.editor.token });

  it("leaves an unticked projector off every link page and refuses a send to it; ticking it again brings it back", async () => {
    const before = await (await r.editor.get("/settings")).text();
    expect(before).toMatch(/action="\/settings\/links\/projectors">\s*<input type="hidden" name="csrf_token" value="[^"]+">/);
    expect(before).toMatch(new RegExp(`name="device" value="${den.id}" checked>Den`));
    await query("UPDATE devices SET in_upload_links = 0 WHERE id = ?", adminDev.id);
    const res = await save([hall.id, adminDev.id]);
    expect([res.status, res.headers.get("location")]).toEqual([303, "/settings"]);
    expect(await query("SELECT name, in_upload_links FROM devices WHERE id IN (?, ?) ORDER BY name", hall.id, den.id))
      .toEqual([{ name: "Den", in_upload_links: 0 }, { name: "Hall", in_upload_links: 1 }]);
    expect(JSON.parse((await audits("upload_link_projectors"))[0].details)).toEqual({ shown: ["hall"], left_off: ["den"] });
    // another account's projector is out of reach: ticked and listed by the editor, it stays off
    expect((await one("SELECT in_upload_links FROM devices WHERE id = ?", adminDev.id)).in_upload_links).toBe(0);
    await query("UPDATE devices SET in_upload_links = 1 WHERE id = ?", adminDev.id);
    expect(await (await r.editor.get("/settings")).text()).toMatch(new RegExp(`name="device" value="${den.id}">Den`));
    const page = await (await anon.get(`/u/${token}`)).text();
    expect(page).toContain(`value="${hall.id}" checked>Hall`); // the only one left, so it comes ticked
    expect(page).not.toContain(">Den");
    const known = await one("SELECT sha256 FROM media WHERE owner_id = ? ORDER BY id LIMIT 1", r.ids.editor);
    expect(await detail(await anon.postJson(`${api}/play`, { media: [known.sha256], devices: [den.id] }), 404)).toBe("Projector not found");
    // a projector that joined after the page was loaded is not on the form, so a save keeps it as it is
    const late = await device("late", "Late");
    expect((await save([hall.id, den.id])).status).toBe(303);
    expect((await one("SELECT in_upload_links FROM devices WHERE id = ?", late.id)).in_upload_links).toBe(1);
    await query("DELETE FROM devices WHERE id = ?", late.id);
    expect(await query("SELECT name FROM devices WHERE id IN (?, ?) AND in_upload_links = 1 ORDER BY name", hall.id, den.id))
      .toEqual([{ name: "Den" }, { name: "Hall" }]);
    expect(await (await anon.get(`/u/${token}`)).text()).toContain(">Den");
  });

  it("a projector handed to another account arrives on that account's upload links", async () => {
    const moving = await device("moving", "Moving", { in_upload_links: 0 });
    expect((await post(r.admin, `/devices/${moving.id}/owner`, { owner_id: String(r.ids.admin) })).status).toBe(303);
    expect(await one("SELECT owner_id, in_upload_links FROM devices WHERE id = ?", moving.id)).toEqual({ owner_id: r.ids.admin, in_upload_links: 1 });
    await query("DELETE FROM devices WHERE id = ?", moving.id);
  });

  it("a projector handed to another account arrives with its alerts on, whatever the old account paused", async () => {
    const paused = await device("paused", "Paused", { alerts_paused: 1 });
    expect((await post(r.admin, `/devices/${paused.id}/owner`, { owner_id: String(r.ids.admin) })).status).toBe(303);
    expect(await one("SELECT owner_id, alerts_paused FROM devices WHERE id = ?", paused.id)).toEqual({ owner_id: r.ids.admin, alerts_paused: 0 });
    await query("DELETE FROM devices WHERE id = ?", paused.id);
  });
});

describe("sentMessage", () => {
  const d = (name, on, scheduled = false) => ({ name, on, scheduled });
  it("names the projectors that will play it now, the ones a schedule holds and the ones that are offline", () => {
    expect(links.sentMessage([d("A", true)])).toBe("Sent to A. It starts once the projector has downloaded it.");
    expect(links.sentMessage([d("A", true), d("B", true), d("C", true)])).toBe("Sent to A, B and C. It starts once the projector has downloaded it.");
    expect(links.sentMessage([d("A", false)])).toBe("Sent. A is offline and will play it when back online.");
    expect(links.sentMessage([d("A", false), d("B", false)])).toBe("Sent. A and B are offline and will play it when back online.");
    expect(links.sentMessage([d("A", true), d("B", false)])).toBe("Sent to A. It starts once the projector has downloaded it. B is offline and will play it when back online.");
    expect(links.sentMessage([d("A", true, true)])).toBe("Sent. A has a schedule running and will play it when that ends.");
    expect(links.sentMessage([d("A", true, true), d("B", true, true)])).toBe("Sent. A and B have a schedule running and will play it when that ends.");
    // an offline one with a rule running is told both
    expect(links.sentMessage([d("A", true), d("B", true, true), d("C", false, true)]))
      .toBe("Sent to A. It starts once the projector has downloaded it. B has a schedule running and will play it when that ends. C is offline with a schedule running and will play it once back online and that has ended.");
    expect(links.sentMessage([d("A", false), d("B", false, true), d("C", false, true)]))
      .toBe("Sent. A is offline and will play it when back online. B and C are offline with a schedule running and will play it once back online and that has ended.");
  });
});

describe("schema", () => {
  it("migrations 0017 and 0018 made upload_links and devices.in_upload_links, and the version matches db.js", async () => {
    expect(db.SCHEMA_VERSION).toBe(20);
    expect(await one("SELECT value FROM meta WHERE key = 'schema_version'")).toEqual({ value: "20" });
    const dev = (await query("PRAGMA table_info(devices)")).find((c) => c.name === "in_upload_links");
    expect([dev.notnull, dev.dflt_value]).toEqual([1, "1"]);
    const cols = (await query("PRAGMA table_info(upload_links)")).map((c) => c.name);
    expect(cols).toEqual(["id", "user_id", "name", "token_hash", "created_at", "last_used_at"]);
  });
});
