// Devices track fixes of the console-ui release (verify run): the decode badge of a projector that
// is not playing, a now-playing file in Recently deleted, the empty playlist's links for a viewer
// or another account's projector, the card a New token or a tunnel lands on, the links to a
// projector's card and its playlist and file, and pausing a projector's alerts.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import * as alerts from "../src/alerts.js";
import { query } from "./helpers.js";
import { audits, device, media, one, playlist, post, roleMatrix, roles } from "./pages_common.js";

let r;
const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

beforeAll(async () => {
  r = await roles();
});

describe("decode badge", () => {
  it("says playing only for a projector that plays; an offline or paused one shows its last measured speed", async () => {
    const dev = await device("slow-1", "Slow", { last_seen_at: now(), player_status: "playing", decode_mode: "software", play_rate: 0.62 });
    const badge = async () => /software decoding[^<]*/.exec(await (await r.editor.get("/devices")).text())[0];
    expect(await badge()).toBe("software decoding · playing at 0.62x speed");
    await query("UPDATE devices SET player_status = 'paused' WHERE id = ?", dev.id);
    expect(await badge()).toBe("software decoding · last played at 0.62x speed");
    await query("UPDATE devices SET player_status = 'playing', last_seen_at = datetime('now', '-7 days') WHERE id = ?", dev.id);
    expect(await badge()).toBe("software decoding · last played at 0.62x speed");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});

describe("now playing a file in Recently deleted", () => {
  it("names it as the Library did, on Devices and on the wall; another account's trash never names it", async () => {
    const stored = `ff742c04538efe43_u${r.ids.editor}_IMG_7781.mov`; // what the player reports
    const id = await media("IMG_7781.MOV", "video", { filename: stored });
    const dev = await device("trash-np", "Trash NP", { last_seen_at: "2026-01-01 00:00:00", current_position: 1, current_filename: stored, player_status: "playing" });
    const other = await device("trash-np-admin", "Admin NP", { owner_id: r.ids.admin, last_seen_at: "2026-01-01 00:00:00", current_position: 0, current_filename: stored });
    expect((await post(r.editor, `/library/${id}/delete`)).status).toBe(303);
    expect(await one("SELECT original_name FROM media_trash WHERE filename = ?", stored)).toEqual({ original_name: "IMG_7781.MOV" });
    const devices = await (await r.editor.get("/devices")).text();
    const wall = await (await r.editor.get("/dashboard")).text();
    expect(devices).toContain('<span class="now-file">last: #2 IMG_7781.MOV</span>');
    expect(wall).toContain('<span class="screen-now">last: #2 IMG_7781.MOV</span>');
    for (const page of [devices, wall]) expect(page).not.toContain(stored);
    // the admin's own projector reporting that name: the editor's trash is not the admin's
    expect(await (await r.admin.get("/devices")).text()).toContain(`<span class="now-file">last: #1 ${stored}</span>`);
    await query("DELETE FROM devices WHERE id IN (?, ?)", dev.id, other.id);
    await query("DELETE FROM media_trash");
  });
});

describe("an empty playlist on a projector's card", () => {
  it("tells only its own account's editors to add files: not a viewer, not an admin reading another account's", async () => {
    const dev = await device("empty-vw", "Empty viewer", { owner_id: r.ids.viewer }); // plays the viewer's empty Default
    let page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain('<span class="now-file">nothing in it yet</span>');
    expect(page).not.toContain("upload files in the Library");
    const pid = await playlist("Viewer empty", r.ids.viewer);
    await query("UPDATE devices SET playlist_id = ? WHERE id = ?", pid, dev.id);
    page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain('<span class="now-file">nothing in it yet</span>');
    expect(page).not.toContain("add files to it");
    page = await (await r.admin.get("/devices")).text();
    expect(page).toContain('<span class="now-file">nothing in it yet</span>');
    expect(page).not.toContain(`/playlists/${pid}"`);
    // the editor's own: still the link
    await query("UPDATE devices SET owner_id = ?, playlist_id = NULL WHERE id = ?", r.ids.editor, dev.id);
    expect(await (await r.editor.get("/devices")).text()).toContain('<span class="now-file">nothing in it yet · <a href="/library">upload files in the Library</a></span>');
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});

describe("links to a projector's card, its playlist and its file", () => {
  it("the Dashboard's tiles and wall titles and the Alerts rows link through; a card links its own account's playlist and file", async () => {
    const stored = `4444444444444444_u${r.ids.editor}_loop.mp4`;
    const mid = await media("Loop.mp4", "video", { filename: stored });
    const pid = await playlist("Linked PL");
    const dev = await device("link-1", "Linked <one>", { playlist_id: pid, last_seen_at: now(), current_position: 0, current_filename: stored, player_status: "playing" });
    await query("INSERT INTO alerts (device_id, kind, opened_at) VALUES (?, 'sync-error', ?)", dev.id, now());
    const dash = await (await r.editor.get("/dashboard")).text();
    for (const href of ["/library", "/playlists", "/devices", "/alerts"]) expect(dash).toContain(`<a class="card" href="${href}"`);
    expect(dash).toContain(`<div class="device-card-title"><a href="/devices#device-${dev.id}">Linked &lt;one&gt;</a></div>`);
    expect(await (await r.editor.get("/alerts")).text())
      .toContain(`<td class="name"><a href="/devices#device-${dev.id}">Linked &lt;one&gt;</a> <code class="muted small">link-1</code></td>`);
    const card = await (await r.editor.get("/devices")).text();
    expect(card).toContain(`<span class="now-playlist"><a href="/playlists/${pid}">Linked PL</a></span>`);
    expect(card).toContain(`<span class="now-file">#1 <a href="/library/${mid}">Loop.mp4</a> · playing</span>`);
    // an admin reading the editor's projector: those pages are the editor's, so the names stay plain
    const admin = await (await r.admin.get("/devices")).text();
    expect(admin).toContain('<span class="now-playlist">Linked PL</span>');
    expect(admin).toContain('<span class="now-file">#1 Loop.mp4 · playing</span>');
    await query("DELETE FROM alerts");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});

describe("pausing a projector's alerts", () => {
  it("Pause alerts: no fault, its open alerts close without a word, the alert check skips it; Resume brings it back", async () => {
    const dev = await device("spare-1", "Spare <one>", { last_seen_at: "2026-01-01 00:00:00" }); // unplugged for months
    const open = () => query("SELECT kind FROM alerts WHERE device_id = ? AND closed_at IS NULL", dev.id);
    expect((await alerts.evaluate(env)).opened).toBe(1);
    expect(await open()).toEqual([{ kind: "offline" }]);
    expect(await (await r.editor.get("/dashboard")).text()).toContain("0 playing · 1 fault</span>");
    let res = await post(r.editor, `/devices/${dev.id}/alerts`, { paused: "1" });
    expect([res.status, res.headers.get("location")]).toEqual([303, `/devices#device-${dev.id}`]);
    expect(await one("SELECT alerts_paused FROM devices WHERE id = ?", dev.id)).toEqual({ alerts_paused: 1 });
    expect(await open()).toEqual([]);
    let page = await (await r.editor.get("/devices")).text();
    expect(page).toContain('<div class="alert ok" role="alert">Alerts paused for Spare &lt;one&gt;.</div>');
    expect(page).toContain(`<div class="device-row" id="device-${dev.id}">`); // not is-fault
    expect(page).toContain('<span class="badge badge-muted alerts-paused">alerts paused</span>');
    expect(page).toMatch(/<input type="hidden" name="paused" value="0">\s*<button type="submit" class="small">Resume alerts<\/button>/);
    const dash = await (await r.editor.get("/dashboard")).text();
    expect(dash).toContain("0 playing · 0 faults</span>");
    expect(dash).toContain('<span class="device-meta">alerts paused</span>');
    expect(dash).toContain(`<div class="device-card">`);
    // its closed alert on the Alerts page says why it closed
    expect(await (await r.editor.get("/alerts")).text()).toContain(`<code class="muted small">spare-1</code> <span class="badge badge-muted">alerts paused</span></td>`);
    // the check opens nothing for it; one left open (a check running while it was paused) closes, unannounced
    expect(await alerts.evaluate(env)).toMatchObject({ opened: 0, closed: 0, repeated: 0 });
    await query("INSERT INTO alerts (device_id, kind, opened_at, notified_at) VALUES (?, 'offline', ?, ?)", dev.id, now(), now());
    expect(await alerts.evaluate(env)).toMatchObject({ opened: 0, closed: 0, repeated: 0 });
    expect(await open()).toEqual([]);
    res = await post(r.editor, `/devices/${dev.id}/alerts`, { paused: "0" });
    expect(res.headers.get("location")).toBe(`/devices#device-${dev.id}`);
    page = await (await r.editor.get("/devices")).text();
    expect(page).toContain('<div class="alert ok" role="alert">Alerts resumed for Spare &lt;one&gt;.</div>');
    expect(page).toContain(`<div class="device-row is-fault" id="device-${dev.id}">`);
    expect(page).toMatch(/<input type="hidden" name="paused" value="1">\s*<button type="submit" class="small">Pause alerts<\/button>/);
    expect(page).not.toContain("alerts paused</span>");
    expect((await alerts.evaluate(env)).opened).toBe(1);
    expect((await audits("device_pause_alerts"))[0]).toMatchObject({ username: "ed", target_type: "device", target_id: String(dev.id) });
    expect((await audits("device_resume_alerts"))[0]).toMatchObject({ username: "ed", target_id: String(dev.id) });
    await query("DELETE FROM alerts");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });

  it("is for editors and admins; a viewer sees that it is paused; another account's projector is a 404", async () => {
    const dev = await device("spare-2", "Spare two");
    await roleMatrix(r, "POST", `/devices/${dev.id}/alerts`, { fields: { paused: "1" } });
    const theirs = await device("spare-3", "Theirs", { owner_id: r.ids.admin });
    const res = await post(r.editor, `/devices/${theirs.id}/alerts`, { paused: "1" });
    expect([res.status, (await res.json()).detail]).toEqual([404, "Device not found"]);
    await query("UPDATE devices SET owner_id = ? WHERE id = ?", r.ids.viewer, dev.id);
    const page = await (await r.viewer.get("/devices")).text();
    expect(page).toContain('<span class="badge badge-muted alerts-paused">alerts paused</span>');
    expect(page).not.toContain(`action="/devices/${dev.id}/alerts"`);
    await query("DELETE FROM devices WHERE id IN (?, ?)", dev.id, theirs.id);
  });
});

describe("migration 0020", () => {
  it("adds alerts_paused with a default, so the worker from before it keeps adding and reading projectors", async () => {
    const col = (await query("PRAGMA table_info(devices)")).find((c) => c.name === "alerts_paused");
    expect([col.notnull, col.dflt_value]).toEqual([1, "0"]);
    // api.registerDevice's INSERT as the worker before 0020 sends it
    const id = (await env.DB.prepare("INSERT INTO devices (device_id, name, token, group_id, playlist_id, owner_id, pi_model) VALUES ('old-worker', 'Old', 'tok-old', NULL, NULL, NULL, NULL)").run()).meta.last_row_id;
    expect(await one("SELECT alerts_paused FROM devices WHERE id = ?", id)).toEqual({ alerts_paused: 0 });
    expect((await query("PRAGMA index_list(media_trash)")).map((i) => i.name)).toContain("idx_media_trash_filename");
    await query("DELETE FROM devices WHERE id = ?", id);
  });
});
