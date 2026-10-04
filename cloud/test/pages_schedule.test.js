// /devices/:id/schedule: page (zone, matches_now, describe), create with contract-10
// validation (HH:MM normalised, start != end, ISO dates, priority range, 404s), delete. A
// projector's rules use its own account's playlists and zone (migration 0016); an admin reads
// another account's schedule but does not change it.
import { beforeAll, describe, expect, it } from "vitest";
import { Client, query } from "./helpers.js";
import { audits, detail, device, ins, NOPE, one, playlist, post, roleMatrix, roles, setting, XSS } from "./pages_common.js";

let r;
const w = {};
const base = () => `/devices/${w.dev.id}/schedule`;
const rule = (fields) => post(r.editor, base(), { name: "Rule", playlist_id: String(w.pid), priority: "1", ...fields });
const last = () => one("SELECT * FROM device_schedules ORDER BY id DESC LIMIT 1");

beforeAll(async () => {
  r = await roles();
  w.pid = await playlist("Morning");
  w.dev = await device("sched-1", "Sched <dev>", { playlist_id: w.pid });
});

describe("role matrix", () => {
  it("page for all, create/delete for editor+", async () => {
    // the fixture device is the editor's: the viewer gets the same 404 as for an unknown id
    expect((await new Client().get(base())).status).toBe(303);
    for (const [c, status] of [[r.viewer, 404], [r.editor, 200], [r.admin, 200]]) expect((await c.get(base())).status).toBe(status);
    await roleMatrix(r, "POST", base(), { fields: { name: "m", playlist_id: String(w.pid) } });
    const sid = (await last()).id;
    await roleMatrix(r, "POST", `${base()}/${sid}/delete`);
    expect(await one("SELECT id FROM device_schedules WHERE id = ?", sid)).toBeNull();
    expect((await r.viewer.get(`/devices/${NOPE}/schedule`)).status).toBe(404);
    expect((await r.viewer.get("/devices/abc/schedule")).status).toBe(400);
  });
});

describe("page", () => {
  it("names the zone, escapes names, shows summary + matches_now, viewer has no forms", async () => {
    await query("DELETE FROM device_schedules");
    // the viewer's own projector and playlist for the read-only checks
    const vdev = await device("sched-v", "Sched <dev>", { owner_id: r.ids.viewer });
    const vpid = await playlist("Morning", r.ids.viewer); // names are per account: the editor has one too
    const vbase = `/devices/${vdev.id}/schedule`;
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority, days_of_week) VALUES (?, ?, ?, 5, '0123456')", vdev.id, vpid, XSS + "r");
    await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_date, end_date) VALUES (?, ?, 'past', 1, '2000-01-01', '2000-01-02')", vdev.id, vpid);
    // a second always-matching rule at lower priority: it matches, but only the top one plays (L19)
    const shadowed = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority, days_of_week) VALUES (?, ?, 'all day', 0, '0123456')", vdev.id, vpid);
    let page = await (await r.viewer.get(vbase)).text();
    expect(page.match(/active now/g)).toHaveLength(1);
    expect(page.match(/class="rule-active"/g)).toHaveLength(1);
    expect(page).toContain('<span class="badge badge-muted">matches, but a higher-priority rule is playing</span>');
    expect(page).toContain("Rules (3)");
    await query("DELETE FROM device_schedules WHERE id = ?", shadowed);
    page = await (await r.viewer.get(vbase)).text();
    expect(page).toContain("<h1>Sched &lt;dev&gt;</h1>");
    expect(page).toContain('<span class="eyebrow">Schedule · sched-v</span>');
    expect(page).toContain("(zone UTC)");
    expect(page).toMatch(/<strong>local time \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC<\/strong>/);
    expect(page).toContain("Rules (2)");
    expect(page).not.toContain(XSS);
    expect(page).toContain("x&#39;);alert(1);//r");
    expect(page).toContain("Mon,Tue,Wed,Thu,Fri,Sat,Sun");
    expect(page).toContain("2000-01-01–2000-01-02");
    expect(page).toContain('<tr class="rule-active">');
    expect(page).toContain('<span class="badge badge-active">active now</span>');
    expect(page).toContain('<span class="badge badge-muted">waiting</span>');
    expect(page).not.toContain("Add rule");
    expect(page).not.toContain("data-confirm");
    // a viewer cannot open Settings, so no link: the note says how its zone could change
    expect(page).not.toContain('href="/settings"');
    expect(page).toContain("this account can only view: an admin can make it an editor, which can change the timezone on the Settings page.");
    await query("DELETE FROM devices WHERE id = ?", vdev.id);

    // the editor's own projector: forms, delete buttons, its own playlists, the Settings link
    const always = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority, days_of_week) VALUES (?, ?, ?, 5, '0123456')", w.dev.id, w.pid, XSS + "r");
    page = await (await r.editor.get(base())).text();
    expect(page).toContain('change the timezone on the <a href="/settings">Settings</a> page.');
    expect(page).toContain('data-confirm="Delete rule x&#39;);alert(1);//r?"');
    expect(page).toContain(`action="${base()}/${always}/delete"`);
    expect(page).toContain("Add rule");
    expect(page).toContain('name="days_of_week_chk" value="6"');
    expect(page).toContain(`<option value="${w.pid}">Morning</option>`);
    expect(page).not.toContain(`<option value="${vpid}">`); // another account's playlist never offered
    expect(page).not.toContain("onsubmit");
    expect(page).not.toContain("belongs to the day it starts on");
    // the admin reads it (another account's projector): no forms, its account changes the zone
    page = await (await r.admin.get(base())).text();
    expect(page).toContain("Rules (1)");
    expect(page).not.toContain("Add rule");
    expect(page).not.toContain(`action="${base()}/${always}/delete"`);
    expect(page).toContain("its own account changes the timezone on its Settings page.");
    // the projector's account's zone drives the page, whoever reads it
    await setting(r.ids.editor, "timezone", "Europe/Berlin");
    page = await (await r.editor.get(base())).text();
    expect(page).toMatch(/\(zone (CET|CEST|GMT\+[12])\)/);
    page = await (await r.admin.get(base())).text();
    expect(page).toMatch(/\(zone (CET|CEST|GMT\+[12])\)/);
    await query("DELETE FROM account_settings WHERE key = 'timezone'");
    await query("DELETE FROM device_schedules");
  });

  it("the admin cannot add or delete rules on another account's projector; nobody uses another account's playlist", async () => {
    const sid = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'keep', 1)", w.dev.id, w.pid);
    const adminPl = await playlist("Admin rules", r.ids.admin);
    const OTHER = "This projector belongs to another account: only that account can change what it plays or see its token. Hand it over with the Owner select first if it should be yours.";
    expect(await detail(await post(r.admin, base(), { name: "x", playlist_id: String(adminPl) }), 403)).toBe(OTHER);
    expect(await detail(await post(r.admin, `${base()}/${sid}/delete`), 403)).toBe(OTHER);
    expect(await one("SELECT id FROM device_schedules WHERE id = ?", sid)).toEqual({ id: sid });
    // the editor naming the admin's playlist gets the 404 of a missing one
    expect(await detail(await rule({ playlist_id: String(adminPl) }), 404)).toBe("Playlist not found");
    expect((await query("SELECT COUNT(*) AS n FROM device_schedules"))[0].n).toBe(1);
    await query("DELETE FROM device_schedules");
  });
});

describe("create validation (contract 10)", () => {
  it("times must be HH:MM and are normalised; start != end", async () => {
    for (const bad of ["25:99", "24:00", "12:60", "7", "0800", "8am", "07:00:00", "junk"]) {
      expect(await detail(await rule({ start_time: bad }), 400), bad).toBe("The start time must be in HH:MM form (00:00 to 23:59)");
      expect(await detail(await rule({ end_time: bad }), 400), bad).toBe("The end time must be in HH:MM form (00:00 to 23:59)");
    }
    expect(await detail(await rule({ start_time: "09:00", end_time: "9:00" }), 400)).toBe("Start and end must differ; leave both empty for all day");
    let res = await rule({ start_time: "7:05", end_time: " 23:59 " });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(base());
    expect(await last()).toMatchObject({ start_time: "07:05", end_time: "23:59", days_of_week: null, start_date: null, end_date: null });
    res = await rule({ start_time: "22:00", end_time: "02:00" }); // wrap midnight is fine
    expect(res.status).toBe(303);
    expect(await last()).toMatchObject({ start_time: "22:00", end_time: "02:00" });
  });

  it("dates must be ISO and ordered", async () => {
    for (const bad of ["2026-13-01", "2026-02-30", "01/02/2026", "yesterday", "2026-1-1"]) {
      expect(await detail(await rule({ start_date: bad }), 400), bad).toBe("Start date must be a date in YYYY-MM-DD form");
      expect(await detail(await rule({ end_date: bad }), 400), bad).toBe("End date must be a date in YYYY-MM-DD form");
    }
    expect(await detail(await rule({ start_date: "2026-09-20", end_date: "2026-09-19" }), 400)).toBe("The start date must be on or before the end date");
    expect((await rule({ start_date: "2026-09-19", end_date: "2026-09-19" })).status).toBe(303);
    expect(await last()).toMatchObject({ start_date: "2026-09-19", end_date: "2026-09-19" });
  });

  it("priority 0..1000 integer, playlist_id integer + required, days filtered/sorted, name defaults", async () => {
    for (const bad of ["-1", "1001", "5.5", "abc"]) {
      const res = await rule({ priority: bad });
      expect(res.status, bad).toBe(400);
    }
    expect(await detail(await rule({ priority: "1001" }), 400)).toBe("Priority must be between 0 and 1000");
    expect(await detail(await rule({ priority: "x" }), 400)).toBe("Priority must be a whole number");
    expect(await detail(await rule({ playlist_id: "abc" }), 400)).toBe("Playlist must be a whole number");
    expect(await detail(await rule({ playlist_id: "" }), 400)).toBe("Pick a playlist");
    expect(await detail(await rule({ playlist_id: String(NOPE) }), 404)).toBe("Playlist not found");
    expect(await detail(await post(r.editor, `/devices/${NOPE}/schedule`, { name: "x", playlist_id: String(w.pid) }), 404)).toBe("Device not found");
    // junk days -> 400 like web.py, never silently filtered to "always"
    expect(await detail(await rule({ days_of_week: "6x40 4" }), 400)).toBe("Pick the days by ticking them");
    expect(await detail(await rule({ days_of_week: "abc" }), 400)).toBe("Pick the days by ticking them");
    expect(await detail(await rule({ days_of_week: "7" }), 400)).toBe("Pick the days by ticking them");
    let res = await rule({ priority: "1000", name: "   ", days_of_week: " 6404 " });
    expect(res.status).toBe(303);
    expect(await last()).toMatchObject({ priority: 1000, name: "Rule", days_of_week: "046" });
    res = await rule({ priority: "", days_of_week: "" });
    expect(res.status).toBe(303);
    expect(await last()).toMatchObject({ priority: 0, days_of_week: null });
    const [a] = await audits("device_schedule_create");
    expect(a.target_type).toBe("device_schedule");
    expect(JSON.parse(a.details)).toEqual({ device_id: w.dev.id, name: "Rule", playlist_id: w.pid });
  });
});

describe("delete", () => {
  it("404 for unknown or another device's rule; deletes and audits", async () => {
    const other = await device("sched-2", "Other");
    await rule({ name: "mine" });
    const sid = (await last()).id;
    expect(await detail(await post(r.editor, `${base()}/${NOPE}/delete`), 404)).toBe("Schedule rule not found");
    expect((await post(r.editor, `/devices/${other.id}/schedule/${sid}/delete`)).status).toBe(404);
    expect((await post(r.editor, `${base()}/abc/delete`)).status).toBe(400);
    const res = await post(r.editor, `${base()}/${sid}/delete`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(base());
    expect(await one("SELECT id FROM device_schedules WHERE id = ?", sid)).toBeNull();
    expect((await audits("device_schedule_delete"))[0]).toMatchObject({ target_id: String(sid), details: `{"device_id": ${w.dev.id}}` });
  });
});
