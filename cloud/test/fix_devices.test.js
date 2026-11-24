// Devices track fixes of the console-ui release (verify run): the decode badge of a projector that
// is not playing, a now-playing file in Recently deleted, the empty playlist's links for a viewer
// or another account's projector, the card a New token or a tunnel lands on, the links to a
// projector's card and its playlist and file, and pausing a projector's alerts.
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { device, media, one, playlist, post, roles } from "./pages_common.js";

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
