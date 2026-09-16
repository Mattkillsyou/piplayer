// /dashboard: stat tiles, monitor wall (screen chips, lamp, active source, last_error, tile
// actions for editor+), wall filters and the audit tail.
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
    expect(page).toMatch(/<span class="page-meta">server \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · UTC<\/span>/);
    expect(page).toContain('<span class="empty-title">NO SIGNAL</span>');
    expect(page).toContain("No devices yet. Register one to start the wall.");
    expect(page).toContain('<a href="/devices" class="button small">Register a device</a>');
    expect(page).not.toContain('id="wall-filters"');
    expect(page).toContain("0.0 MB on disk");
    expect(page).toContain("0 playing · 0 faults");
    expect(page).toContain("Monitor wall · 0 devices");
    expect(page).toContain('<ul class="log-lines">');
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
    expect(page).toContain('<span class="card-value">2</span>');   // media
    expect(page).toContain("3.5 MB on disk");
    expect(page).toContain('<span class="card-value">3</span>');   // devices (and 2 playlists -> "2" already asserted)
    // A last synced in 2020 so it is offline (lamp beats the reported "playing"); B and C never synced
    expect(page).toContain("0 playing · 3 faults");
    expect(page).toContain("Monitor wall · 3 devices");
    expect(page).toContain('<div class="filters" id="wall-filters">');
    expect(page).toContain('data-filter="faults" aria-pressed="false">Faults (3)</button>');
    expect(page).toContain('<div class="device-grid" id="monitor-wall">');
    expect(page).not.toContain(XSS);
    expect(page).toContain("x&#39;);alert(1);//A");
    // device A: thumb (stale, from 2020), active by default, now playing, error
    expect(page).toContain(`<img src="/devices/${a.id}/screenshot?t=2020-01-01%2000%3A00%3A00" class="device-thumb device-thumb-stale" alt="Latest screenshot from x&#39;);alert(1);//A">`);
    expect(page).toContain('<div class="device-screen is-stale">');
    expect(page).toContain('<span class="screen-chip tl" title="2020-01-01 00:00 UTC">');
    expect(page).toContain('<span class="screen-chip tr is-stale badge-stale" title="No new screenshot for more than 3 capture intervals: the player may be idle, black or down">stale</span>');
    expect(page).not.toContain('<span class="screen-chip tr">live</span>');
    expect(page).toContain('<span class="screen-now">#1 big.mp4</span>');
    expect(page).toContain('<span class="now-playlist">Grid PL</span>');
    expect(page).toContain('<span class="now-via">via device default</span>');
    expect(page).toContain('<span class="status status-offline"><span class="lamp"></span>offline</span>');
    expect(page).toContain("d ago · 2020-01-01 00:00 UTC</span>");
    expect(page).toContain('<div class="alert error small" title="Reported by the player on its last sync">Sync problem: 2 of 5 items missing: &lt;x&gt;</div>');
    // device B: group fallback, no screenshot
    expect(page).toContain("<code>b-dev</code> · G1");
    expect(page).toContain('<span class="now-via">via group: G1</span>');
    expect(page).toContain('<span class="empty-sub">no screenshot yet</span>');
    expect(page).not.toContain("device-camera"); // no camera snapshot yet
    expect(page).toContain('<span class="device-meta">last seen never</span>');
    // device C: schedule wins
    expect(page).toContain('<span class="now-via">via schedule: Always on</span>');
    expect((page.match(/<div class="device-card is-fault">/g) || []).length).toBe(3);
    // viewers get no tile actions
    expect(page).not.toContain('class="tile-actions"');
    expect(page).not.toContain(`action="/devices/${a.id}/command"`);
    void b;
  });

  it("editor and admin get Resync / Reboot tile actions; a fresh sync lights the playing lamp", async () => {
    const live = await device("live-dev", "Live <dev>", { last_seen_at: new Date().toISOString().slice(0, 19).replace("T", " "), player_status: "playing" });
    for (const c of [r.editor, r.admin]) {
      const page = await (await c.get("/dashboard")).text();
      expect(page).toContain('<div class="tile-actions">');
      expect(page).toContain(`<form method="post" action="/devices/${live.id}/command" class="inline" data-confirm="Reboot Live &lt;dev&gt;?">`);
      expect(page).toContain('<input type="hidden" name="command" value="force-sync">');
      expect(page).toContain('<button type="submit" class="small">Resync</button>');
      expect(page).toContain('<button type="submit" class="small danger">Reboot</button>');
      expect(page).not.toContain("onsubmit");
      expect(page).toContain('<div class="device-card">');
      expect(page).toContain('<span class="status status-playing"><span class="lamp"></span>playing</span>');
      expect(page).toContain("1 playing · 3 faults");
      expect(page).toContain('<span class="now-playlist">no playlist</span>');
    }
    await query("DELETE FROM devices WHERE id = ?", live.id);
  });

  it("a failed remote update makes the card a fault with the error box; ok is a muted line and no fault", async () => {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const dev = await device("upd-dev", "Upd dev", { last_seen_at: now, player_status: "playing" });
    await query("UPDATE devices SET last_update_at = datetime('now', '-90 seconds'), last_update_ok = 0, last_update_message = 'install-player.sh exited 1: <pip>', last_update_ref = 'v1.4.0' WHERE id = ?", dev.id);
    let page = await (await r.viewer.get("/dashboard")).text();
    expect(page).toContain("1 playing · 4 faults");
    expect(page).toContain('data-filter="faults" aria-pressed="false">Faults (4)</button>');
    expect((page.match(/<div class="device-card is-fault">/g) || []).length).toBe(4);
    expect(page).toContain('<div class="alert error update-status" title="Reported by the player after its last update">Update failed <code>v1.4.0</code> · 1 min ago · ');
    expect(page).toContain(" UTC: install-player.sh exited 1: &lt;pip&gt;</div>");
    await query("UPDATE devices SET last_update_ok = 1, last_update_message = 'already at abc123' WHERE id = ?", dev.id);
    page = await (await r.viewer.get("/dashboard")).text();
    expect(page).toContain("1 playing · 3 faults");
    expect((page.match(/<div class="device-card is-fault">/g) || []).length).toBe(3);
    expect(page).toContain('<div class="device-card">');
    expect(page).toContain('<p class="update-status muted small" title="Reported by the player after its last update">Update ok <code>v1.4.0</code> · 1 min ago · ');
    expect(page).not.toContain("Update failed");
    await query("DELETE FROM devices WHERE id = ?", dev.id);
  });

  it("audit tail lists the last 8 entries, newest first, with local minute timestamps", async () => {
    await query("DELETE FROM audit_log");
    let page = await (await r.viewer.get("/dashboard")).text();
    expect(page).toContain('<li class="empty-line">no activity yet</li>');
    for (let i = 0; i < 10; i++) {
      await ins("INSERT INTO audit_log (user_id, username, action, target_type, target_id, ip, created_at) VALUES (NULL, ?, ?, 'device', ?, '10.0.0.9', ?)",
        i === 9 ? null : "ed<b>", `act_${i}`, String(i), `2021-03-04 05:0${i % 10}:00`);
    }
    page = await (await r.viewer.get("/dashboard")).text();
    expect(page).not.toContain("no activity yet");
    expect((page.match(/<span class="log-t">/g) || []).length).toBe(8);
    expect(page).toContain('<li><span class="log-t">2021-03-04 05:09</span> <span class="log-u">system</span> <span class="log-a">act_9</span> <span class="log-tg">device 9</span> <span class="log-ip">10.0.0.9</span></li>');
    expect(page).toContain('<span class="log-u">ed&lt;b&gt;</span> <span class="log-a">act_8</span>');
    expect(page).not.toContain("act_1</span>");
    expect(page).not.toContain("act_0</span>");
    expect(page.indexOf("act_9")).toBeLessThan(page.indexOf("act_8"));
    expect(page).toContain('<h2>Audit tail · <a href="/audit">full log</a></h2>');
  });

  it("timestamps follow the site timezone setting", async () => {
    await query("INSERT INTO settings (key, value) VALUES ('timezone', 'America/Los_Angeles') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const page = await (await r.viewer.get("/dashboard")).text();
    expect(page).toContain("d ago · 2019-12-31 16:00 PST</span>");
    expect(page).toContain('title="2019-12-31 16:00 PST"');
    expect(page).toContain('<span class="log-t">2021-03-03 21:09</span>');
    expect(page).toMatch(/server \d{4}-\d{2}-\d{2} \d{2}:\d{2} P[DS]T · P[DS]T<\/span>/);
    await query("DELETE FROM settings WHERE key = 'timezone'");
  });
});
