// Owner-facing wording (L27, L29) and the accessibility basics (L32): no developer jargon on
// the pages a non-technical owner reads, one name per concept across pages, every data table
// captioned with scoped column headers, and the skip link + main landmark on every page.
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "./helpers.js";
import { device, group, ins, media, playlist, post, roles } from "./pages_common.js";

let r, pid, dev;

beforeAll(async () => {
  r = await roles();
  pid = await playlist("Lobby loop");
  const mid = await media("clip.mp4", "video");
  await ins("INSERT INTO playlist_items (playlist_id, media_id, position) VALUES (?, ?, 0)", pid, mid);
  const gid = await group("Lobby");
  await ins("UPDATE device_groups SET playlist_id = ? WHERE id = ?", pid, gid);
  dev = await device("lobby-1", "Lobby", { playlist_id: pid, group_id: gid, projector_control: "broadlink", player_version: "1.2.3" });
  await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'Always', 1)", dev.id, pid);
  await ins("INSERT INTO device_commands (device_id, command, issued_by) VALUES (?, 'restart-mpv', 1)", dev.id);
  await ins("INSERT INTO alerts (device_id, kind, opened_at) VALUES (?, 'mpv-down', datetime('now'))", dev.id);
  await ins("INSERT INTO alerts (device_id, kind, opened_at, closed_at) VALUES (?, 'offline', datetime('now', '-1 hour'), datetime('now'))", dev.id);
  expect((await post(r.admin, "/settings/tokens", { name: "laptop" })).status).toBe(200); // renders the tokens table
});

const page = (c, p) => c.get(p).then((res) => res.text());

// Every page an owner reads, each with at least one data table rendered by the fixtures above.
const PAGES = ["/dashboard", "/library", "/playlists", "/playlists/:pid", "/devices", "/devices/:id/schedule", "/groups", "/alerts", "/audit", "/users", "/settings", "/flasher"];
const path = (p) => p.replace(":pid", pid).replace(":id", dev.id);

describe("accessibility basics (L32)", () => {
  it("every data table has a screen-reader caption and scoped column headers", async () => {
    let tables = 0;
    for (const p of PAGES.map(path)) {
      const html = await page(r.admin, p);
      expect(html, p).not.toMatch(/<th(?=[\s>])(?![^>]*\bscope="col")/);
      const found = html.match(/<table class="data[^>]*>\s*<caption class="sr-only">[^<]+<\/caption>/g) || [];
      expect(found.length, `${p} captions`).toBe((html.match(/<table class="data/g) || []).length);
      tables += found.length;
    }
    expect(tables).toBeGreaterThanOrEqual(PAGES.length - 2); // the dashboard and the SD Flasher page have no table
  });

  it("every signed-in page has the skip link before the nav and the main landmark; the login card has neither", async () => {
    for (const p of PAGES.map(path)) {
      const html = await page(r.admin, p);
      expect(html, p).toMatch(/<a class="skip-link" href="#main">Skip to content<\/a>\s*<header class="topbar">/);
      expect(html, p).toContain('<main id="main" class="container">');
    }
    const login = await page(new Client(), "/login");
    expect(login).not.toContain("skip-link");
    expect(login).toContain('<main id="main" class="container">');
  });
});

describe("owner wording (L27, L29)", () => {
  it("no developer jargon on the pages an owner reads", async () => {
    const jargon = /\bIANA\b|E\.164|apt-get|wrangler|HDMI-CEC|RM4|Restart mpv|mpv playback|git tag|database stores|<code>mpv-down<\/code>|<code>force-sync<\/code>|\/api\/camera-config|\/api\/enroll\b/;
    for (const p of PAGES.map(path)) expect(await page(r.admin, p), p).not.toMatch(jargon);
  });

  it("Devices: Restart playback, Device ID, Add device, the button label in Recent commands, player version", async () => {
    const html = await page(r.editor, "/devices");
    expect(html).toContain('title="Restart the video player on the Pi">Restart playback</button>');
    expect(html).toContain('title="Reinstall the player software at the release set in Settings">Update player</button>');
    expect(html).toContain("title=\"Update the Pi's operating system packages; it may reboot\">Update OS</button>");
    expect(html).toContain("<label>Device ID\n");
    expect(html).toContain('<button type="submit" class="primary">Add device</button>');
    expect(html).not.toContain(">Register<");
    expect(html).toContain("Restart playback →"); // the queued restart-mpv row
    expect(html).toContain('<span class="label">player version</span><span class="value">v1.2.3</span>');
    expect(html).not.toContain("cec switches the projector through the HDMI cable");
    expect(html).toContain("<label>Broadlink address (optional)");
    expect(html).toContain("<label>Stream address (for the rtsp source)");
  });

  it("Settings: alert kinds in plain words, timezone / release / phone labels, New key", async () => {
    const html = await page(r.admin, "/settings");
    expect(html).not.toContain("checks each device for:");
    expect(html).toContain("<label>Site timezone (e.g. America/New_York)");
    expect(html).toContain("<label>Player software version (release name)");
    expect(html).toContain("<label>Text messages from (phone number with country code, e.g. +15551234567)");
    expect(html).toContain("<label>Text messages to (phone number with country code, e.g. +15551234567)");
    expect(html).toContain('<button type="submit" class="danger">New key</button>');
    expect(html).toContain('data-confirm="Make a new enrollment key?');
    expect(html).not.toContain("Rotate key");
  });

  it("one name per concept: default playlist on Groups and Playlists, Set password on Users, no NO SIGNAL for an empty fleet", async () => {
    const groups = await page(r.editor, "/groups");
    expect(groups).not.toContain("use the group's playlist as their default playlist");
    expect(groups).toContain("will lose this default playlist.");
    expect(groups).not.toContain("fallback");
    const playlists = await page(r.editor, "/playlists");
    expect(playlists).toContain("1 device(s) will lose it as their default playlist; 1 group(s) will lose it as their default playlist.");
    expect(playlists).toContain('title="devices with this as their default playlist"');
    const users = await page(r.admin, "/users");
    expect(users).toContain('<th scope="col">Set password</th>');
    expect(users).not.toContain("Reset password");
    const audit = await page(r.viewer, "/audit");
    expect(audit).toMatch(/times in UTC<\/span>/);
  });
});
