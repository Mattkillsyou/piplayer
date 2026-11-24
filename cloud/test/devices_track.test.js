// Devices track: what each projector plays by its Library name (and never "playing" for one that
// is offline), a change made on a projector's card lands back on that card, a viewer's empty
// state, the "none" labels, the Dashboard's clock, library size and dates, and the stylesheet
// rules behind the visual fixes.
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { device, group, media, playlist, post, roles } from "./pages_common.js";

let r;
const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

beforeAll(async () => {
  r = await roles();
});

describe("now playing", () => {
  it("names the file as the Library does, on Devices and on the wall; offline says last: and never playing", async () => {
    const stored = `1b814e5034bc2b4f_u${r.ids.editor}_b.mp4`; // what the player reports: the stored name
    const mid = await media("Friday <b>.mp4", "video", { filename: stored });
    const dev = await device("np-1", "Now playing", { last_seen_at: now(), current_position: 2, current_filename: stored, player_status: "playing" });
    let devices = await (await r.editor.get("/devices")).text();
    let wall = await (await r.editor.get("/dashboard")).text();
    expect(devices).toContain(`<span class="now-file">#3 <a href="/library/${mid}">Friday &lt;b&gt;.mp4</a> · playing</span>`);
    expect(wall).toContain('<span class="screen-now">#3 Friday &lt;b&gt;.mp4</span>');
    for (const page of [devices, wall]) expect(page).not.toContain(stored);
    // two hours without a check-in: offline, so what it last reported, without its old status
    await query("UPDATE devices SET last_seen_at = datetime('now', '-2 hours') WHERE id = ?", dev.id);
    devices = await (await r.editor.get("/devices")).text();
    wall = await (await r.editor.get("/dashboard")).text();
    expect(devices).toContain('<span class="status status-offline"><span class="lamp"></span>offline</span>');
    expect(devices).toContain(`<span class="now-file">last: #3 <a href="/library/${mid}">Friday &lt;b&gt;.mp4</a></span>`);
    expect(devices).not.toContain(" · playing</span>");
    expect(wall).toContain('<span class="screen-now">last: #3 Friday &lt;b&gt;.mp4</span>');
    // a file with no Library row (a USB stick's): the name as reported
    await query("UPDATE devices SET last_seen_at = datetime('now'), current_position = 0, current_filename = 'usb <clip>.mp4', player_status = 'paused' WHERE id = ?", dev.id);
    devices = await (await r.editor.get("/devices")).text();
    expect(devices).toContain('<span class="now-file">#1 usb &lt;clip&gt;.mp4 · paused</span>');
    expect(await (await r.editor.get("/dashboard")).text()).toContain('<span class="screen-now">#1 usb &lt;clip&gt;.mp4</span>');
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });

  it("only the projector's own account's file names it: an admin sees that account's name, another account's file never", async () => {
    const mine = `2222222222222222_u${r.ids.editor}_clip.mp4`;
    const admins = `3333333333333333_u${r.ids.admin}_secret.mp4`;
    const mineId = await media("Editor's clip.mp4", "video", { filename: mine });
    await media("Admin's secret.mp4", "video", { filename: admins, owner: r.ids.admin });
    const a = await device("np-a", "Plays mine", { last_seen_at: now(), current_position: 0, current_filename: mine, player_status: "playing" });
    const b = await device("np-b", "Reports the admin's", { last_seen_at: now(), current_position: 0, current_filename: admins, player_status: "playing" });
    for (const [c, name] of [[r.admin, "Editor&#39;s clip.mp4"], [r.editor, `<a href="/library/${mineId}">Editor&#39;s clip.mp4</a>`]]) { // the admin sees every projector, the editor its own (its file linked)
      const page = await (await c.get("/devices")).text();
      expect(page).toContain(`<span class="now-file">#1 ${name} · playing</span>`);
      expect(page).toContain(`<span class="now-file">#1 ${admins} · playing</span>`);
      expect(page).not.toContain("Admin&#39;s secret.mp4");
    }
    await query("DELETE FROM devices WHERE id IN (?, ?)", a.id, b.id);
  });
});

describe("a change made on a card lands back on that card", () => {
  it("the card forms answer with /devices#device-<id> (New token with its Token / install open); a new or deleted projector and the fleet update go to the top", async () => {
    const dev = await device("card-1", "Card", { last_seen_at: now() });
    const pid = await playlist("Card PL");
    const gid = await group("Card group");
    const card = `/devices#device-${dev.id}`;
    expect(await (await r.editor.get("/devices")).text()).toContain(`<div class="device-row" id="device-${dev.id}">`);
    for (const [path, fields] of [
      ["rename", { name: "Card two" }],
      ["assign", { playlist_id: String(pid) }],
      ["group", { group_id: String(gid) }],
      ["command", { command: "force-sync" }],
      ["command", { command: "force-sync" }], // already waiting: the warning lands there too
      ["command/cancel", {}],
      ["command/cancel", {}], // nothing waiting
      ["camera-url", { camera_live_url: "https://cam.example.com/card" }],
      ["camera-source", { camera_source: "none" }],
      ["camera-source", { camera_source: "none" }], // unchanged
      ["projector", { projector_control: "cec", projector_power_mode: "manual" }],
    ]) {
      const res = await post(r.editor, `/devices/${dev.id}/${path}`, fields);
      expect([res.status, res.headers.get("location")], path).toEqual([303, card]);
    }
    // the admin's Owner select, kept on the same account: back to the card as well
    let res = await post(r.admin, `/devices/${dev.id}/owner`, { owner_id: String(r.ids.editor) });
    expect([res.status, res.headers.get("location")]).toEqual([303, card]);
    res = await post(r.editor, `/devices/${dev.id}/regen-token`);
    expect(res.headers.get("location")).toBe(`/devices?open=${dev.id}#device-${dev.id}`);
    res = await post(r.editor, "/devices/update-all", { command: "update-os" });
    expect(res.headers.get("location")).toBe("/devices");
    res = await post(r.editor, "/devices", { device_id: "card-2", name: "Card 2" });
    expect(res.headers.get("location")).toBe("/devices");
    res = await post(r.editor, `/devices/${dev.id}/delete`);
    expect(res.headers.get("location")).toBe("/devices");
    await query("DELETE FROM devices");
    await query("DELETE FROM device_commands");
  });
});

describe("empty states and labels", () => {
  it("a viewer with no projectors is not sent to the SD Flasher, which refuses viewers", async () => {
    for (const path of ["/devices", "/dashboard"]) {
      const page = await (await r.viewer.get(path)).text();
      expect(page, path).toContain('<span class="empty-title">NO PROJECTORS</span>\n    <p>No projectors yet.</p>');
      expect(page, path).not.toContain("Flash a card");
      const ed = await (await r.editor.get(path)).text();
      expect(ed, path).toContain('No projectors yet. Flash a card with the <a href="/flasher">SD Flasher</a> and it appears here.');
    }
  });

  it("an admin reading another account's projector with no playlist of its own reads none, not Default", async () => {
    const dev = await device("lbl-1", "Labels");
    expect(await (await r.admin.get("/devices")).text()).toContain("Plays what ed picks: group none, default playlist none.</p>");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });
});

describe("dashboard", () => {
  it("names the account's clock once, sizes the library as the Library does, keeps a date on one line", async () => {
    await query("DELETE FROM media");
    let page = await (await r.editor.get("/dashboard")).text();
    expect(page).toMatch(/<span class="page-meta">your time \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/span>/);
    expect(page).not.toContain("server ");
    expect(page).toContain('<span class="card-sub">0 B total</span>');
    await media("a.png", "image", { size: 700 });
    expect(await (await r.editor.get("/dashboard")).text()).toContain('<span class="card-sub">700 B total</span>');
    await media("b.mp4", "video", { size: 5 * 1024 * 1024 });
    const dev = await device("dash-1", "Dash", { last_seen_at: "2026-01-02 03:04:05" });
    page = await (await r.editor.get("/dashboard")).text();
    expect(page).toContain('<span class="card-sub">5.0 MB total</span>');
    expect(page).toMatch(/<span class="device-meta">last seen \d+ d ago · <span class="nowrap">2026-01-02 03:04 UTC<\/span><\/span>/);
    await query("DELETE FROM devices WHERE id = ?", dev.id);
    await query("DELETE FROM media");
  });
});

describe("style.css", () => {
  it("carries the visual fixes: picker icons, phone tick boxes, the wall's rows, the tablet card, the phone rename row", async () => {
    const css = await (await r.viewer.get("/static/style.css")).text();
    // Chrome's own white icons under color-scheme: dark; inverted they were black on black
    expect(css).toContain("input[type=time]::-webkit-calendar-picker-indicator, input[type=date]::-webkit-calendar-picker-indicator { opacity: .5; cursor: pointer; }");
    expect(css).not.toContain("invert(1)");
    // the schedule's day boxes and Also add to: 44px rows and 22px boxes on a phone
    expect(css).toContain("@media (max-width: 720px) {\n  .days-fieldset .inline-check { min-height: var(--p5k-touch); }\n  .days-fieldset input[type=checkbox] { width: 22px; height: 22px; }");
    // the monitor wall's cards share their row's height (no hole under the short ones)
    expect(css).toContain(".device-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 18px; margin-bottom: 22px; }");
    // 721-1100px: the first column keeps its desktop width (the camera chips stop overlapping) and
    // the Actions sit three to a line
    const tablet = css.slice(css.indexOf("@media (max-width: 1100px) {"));
    expect(tablet).toMatch(/^@media \(max-width: 1100px\) \{[^}]*\.device-row \{ grid-template-columns: 270px 1fr; \}/);
    expect(tablet.slice(0, tablet.indexOf("\n}"))).toContain(".device-actions .action-buttons { flex-direction: row; }\n  .device-actions .action-buttons form { flex: 1 1 30%; }");
    // a phone: the rename box spans the card
    expect(css).toContain(".device-row .device-ident > .alert, .device-row .device-ident > form { grid-column: 1 / -1; }");
  });

  it("app.js no longer folds the days into a hidden field: the server reads the ticked boxes", async () => {
    expect(await (await r.viewer.get("/static/app.js")).text()).not.toContain("days-hidden");
  });
});
