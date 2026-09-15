// /dashboard: cards, device grid with screenshot thumb + stale badge, active source, last_error.
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { device, group, ins, media, playlist, roleMatrix, roles, XSS } from "./pages_common.js";

let r;

beforeAll(async () => {
  r = await roles();
});

describe("dashboard", () => {
  it("renders for every role, anonymous goes to /login", async () => {
    await roleMatrix(r, "GET", "/dashboard");
    const page = await (await r.viewer.get("/dashboard")).text();
    expect(page).toContain("<h1>Dashboard</h1>");
    expect(page).toContain('No devices yet. <a href="/devices">Register one</a>');
    expect(page).toContain("0.0 MB on disk");
  });

  it("cards count media/playlists/devices; cards show active source, now playing, stale badge, last_error", async () => {
    await media("big.mp4", "video", { size: 3 * 1024 * 1024 });
    await media("small.png", "image", { size: 512 * 1024 });
    const pid = await playlist("Grid PL");
    const gpl = await playlist("Group PL");
    const gid = await group("G1");
    await query("UPDATE device_groups SET playlist_id = ? WHERE id = ?", gpl, gid);
    const a = await device("a-dev", XSS + "A", {
      playlist_id: pid, last_screenshot_at: "2020-01-01 00:00:00", last_seen_at: "2020-01-01 00:00:00",
      current_position: 0, current_filename: "big.mp4", player_status: "playing", last_error: "2 of 5 items missing: <x>",
    });
    const b = await device("b-dev", "B dev", { group_id: gid });
    const c = await device("c-dev", "C dev");
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'Always on', 3)", c.id, gpl);
    const page = await (await r.viewer.get("/dashboard")).text();
    expect(page).toContain('<div class="card-value">2</div>');   // media
    expect(page).toContain("3.5 MB on disk");
    expect(page).toContain('<div class="card-value">3</div>');   // devices (and 2 playlists -> "2" already asserted)
    expect(page).not.toContain(XSS);
    expect(page).toContain("x&#39;);alert(1);//A");
    // device A: thumb (stale, from 2020), active by default, now playing, error
    expect(page).toContain(`<img src="/devices/${a.id}/screenshot?t=2020-01-01%2000%3A00%3A00" class="device-thumb device-thumb-stale"`);
    expect(page).toContain('<span class="badge badge-stale" title="No new screenshot for more than 3 capture intervals: the player may be idle, black or down">stale</span>');
    expect(page).toContain("(2020-01-01 00:00 UTC)");
    expect(page).toContain('Grid PL <span class="source">via device default</span>');
    expect(page).toContain('<span class="screen-now">#1 big.mp4</span>');
    expect(page).toContain('<span class="lamp lamp-playing">playing</span>');
    expect(page).toMatch(/<span title="2020-01-01 00:00 UTC">last seen \d+ d ago<\/span>/);
    expect(page).toContain("Sync problem: 2 of 5 items missing: &lt;x&gt;");
    // device B: group fallback, no screenshot
    expect(page).toContain("<code>b-dev</code> · G1");
    expect(page).toContain('Group PL <span class="source">via group: G1</span>');
    expect(page).toContain('<div class="device-thumb device-thumb-empty">no screenshot yet</div>');
    expect(page).toContain('<span class="lamp lamp-offline">offline</span>');
    expect(page).toContain("<span>last seen never</span>");
    // device C: schedule wins
    expect(page).toContain('Group PL <span class="source">via schedule: Always on</span>');
    expect(page).toContain("Monitor wall · 3 devices</h2>");
    expect((page.match(/class="device-card"/g) || []).length).toBe(3);
    void b;
  });

  it("timestamps follow the site timezone setting", async () => {
    await query("INSERT INTO settings (key, value) VALUES ('timezone', 'America/Los_Angeles') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const page = await (await r.viewer.get("/dashboard")).text();
    expect(page).toContain("(2019-12-31 16:00 PST)");
    await query("DELETE FROM settings WHERE key = 'timezone'");
  });
});
