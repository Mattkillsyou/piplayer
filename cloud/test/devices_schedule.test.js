// The schedule page's Edit rule and Also add to (devices track): a rule is changed in place
// (POST /devices/:id/schedule/:rule) instead of deleted and typed again, and Add rule puts a copy
// of the rule on more of the account's own projectors at once, each copy its own row.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import * as manifest from "../src/manifest.js";
import { wallClock } from "../src/util.js";
import { query } from "./helpers.js";
import { audits, detail, device, ins, NOPE, one, playlist, post, roleMatrix, roles } from "./pages_common.js";

let r;
const w = {};
const base = (d = w.dev) => `/devices/${d.id}/schedule`;
const rulesOf = (d) => query("SELECT * FROM device_schedules WHERE device_id = ? ORDER BY id", d.id);
const count = async () => (await query("SELECT COUNT(*) AS n FROM device_schedules"))[0].n;
// A form body with repeated keys (ticked boxes), as a browser sends it.
const form = (fields, ...pairs) => [...Object.entries(fields), ...pairs];
const banner = async (c, path) => /<div class="alert (\w+)" role="alert">([^<]*)<\/div>/.exec(await (await c.get(path)).text())?.slice(1) ?? null;
// Save rule on `id` with the name and playlist it was made with.
const save = (id, fields, ...pairs) => post(r.editor, `${base()}/${id}`, form({ name: "weekdays", playlist_id: String(w.morning), ...fields }, ...pairs));
const OTHER = "This projector belongs to another account: only that account can change what it plays or see its token. Hand it over with the Owner select first if it should be yours.";

beforeAll(async () => {
  r = await roles();
  w.morning = await playlist("Morning");
  w.evening = await playlist("Evening");
  w.dev = await device("hall", "Hall");
  w.stage = await device("stage", "Stage");
  w.bar = await device("bar", "Bar");
  w.admins = await device("admins", "Admin's own", { owner_id: r.ids.admin });
});

describe("the page", () => {
  it("offers the account's other projectors under Also add to, never this one or another account's", async () => {
    const page = await (await r.editor.get(base())).text();
    expect(page).toContain("<legend>Also add to</legend>");
    expect(page).toContain(`<label class="inline-check"><input type="checkbox" name="also" value="${w.bar.id}">Bar</label>`);
    expect(page).toContain(`<label class="inline-check"><input type="checkbox" name="also" value="${w.stage.id}">Stage</label>`);
    expect(page.indexOf(">Bar</label>")).toBeLessThan(page.indexOf(">Stage</label>"));
    expect(page).not.toContain(`name="also" value="${w.dev.id}"`);
    expect(page).not.toContain(`name="also" value="${w.admins.id}"`);
    // the days are read from the ticked boxes: no hidden field for a script to fill in
    expect(page).not.toContain('name="days_of_week"');
    // an account with no other projector gets no Also add to
    expect(await (await r.admin.get(base(w.admins))).text()).not.toContain("Also add to");
  });

  it("?edit= fills the form with that rule and posts to it; any other id gets the Add form", async () => {
    const id = await ins(`INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_time, end_time, days_of_week, start_date, end_date)
      VALUES (?, ?, ?, 7, '06:30', '09:00', '026', '2026-01-01', '2026-12-31')`, w.dev.id, w.morning, "Breakfast <b>");
    const page = await (await r.editor.get(`${base()}?edit=${id}`)).text();
    expect(page).toContain('<div class="panel" id="rule-form">\n  <h2>Edit rule</h2>');
    expect(page).toContain(`<form method="post" action="${base()}/${id}">`);
    expect(page).toContain('<input type="text" name="name" value="Breakfast &lt;b&gt;"');
    expect(page).toContain(`<option value="${w.morning}" selected>Morning</option>`);
    expect(page).toContain(`<option value="${w.evening}">Evening</option>`);
    expect(page).toContain('<input type="number" name="priority" value="7"');
    expect(page).toContain('<input type="time" name="start_time" value="06:30"');
    expect(page).toContain('<input type="time" name="end_time" value="09:00"');
    expect(page).toContain('<input type="date" name="start_date" value="2026-01-01">');
    expect(page).toContain('<input type="date" name="end_date" value="2026-12-31"');
    // 0 = Monday
    expect(page).toContain('value="0" checked>Mon</label>');
    expect(page).toContain('value="1">Tue</label>');
    expect(page).toContain('value="2" checked>Wed</label>');
    expect(page).toContain('value="6" checked>Sun</label>');
    expect(page).toContain('<button type="submit" class="primary">Save rule</button>');
    expect(page).toContain(`<a href="${base()}" class="button">Cancel</a>`);
    expect(page).not.toContain("Also add to");
    // each row's Edit opens its own rule at the form
    expect(page).toContain(`<a href="${base()}?edit=${id}#rule-form" class="button small">Edit</a>`);
    const other = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'theirs', 1)", w.stage.id, w.evening);
    for (const q of [other, NOPE, "abc", ""]) {
      const add = await (await r.editor.get(`${base()}?edit=${q}`)).text();
      expect(add, String(q)).toContain("<h2>Add rule</h2>");
      expect(add).toContain(`<form method="post" action="${base()}">`);
      expect(add).toContain('<input type="text" name="name" placeholder="e.g., Morning Classes" required>');
      expect(add).toContain('<input type="number" name="priority" value="10"');
      expect(add).not.toContain(" checked>");
      expect(add).not.toContain(" selected>");
      expect(add).not.toContain("Cancel</a>");
    }
    // the admin reads another account's projector: neither Edit nor a form
    const admin = await (await r.admin.get(`${base()}?edit=${id}`)).text();
    expect(admin).not.toContain("?edit=");
    expect(admin).not.toContain('id="rule-form"');
    await query("DELETE FROM device_schedules");
  });
});

describe("Save rule", () => {
  it("changes every field in place; the Devices page and the manifest follow the new window", async () => {
    const id = await ins(`INSERT INTO device_schedules (device_id, playlist_id, name, priority, start_date, end_date)
      VALUES (?, ?, 'Old', 1, '2000-01-01', '2000-01-02')`, w.dev.id, w.morning);
    const device = { id: w.dev.id, playlist_id: null, group_id: null, owner_id: r.ids.editor };
    expect((await manifest.resolve_active_playlist_id(env, device, wallClock("UTC")))[1]).toBe("site-default");
    let res = await post(r.editor, `${base()}/${id}`, form({ name: "Late", playlist_id: String(w.evening), priority: "3",
      start_time: "21:00", end_time: "2:30", start_date: "2026-01-01", end_date: "2030-12-31" }, ["days_of_week_chk", "5"], ["days_of_week_chk", "4"]));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(base());
    expect(await rulesOf(w.dev)).toMatchObject([{ id, playlist_id: w.evening, name: "Late", priority: 3, start_time: "21:00",
      end_time: "02:30", days_of_week: "45", start_date: "2026-01-01", end_date: "2030-12-31" }]);
    expect(await banner(r.editor, base())).toBeNull(); // nothing else was added: no banner
    const [a] = await audits("device_schedule_update");
    expect(a).toMatchObject({ username: "ed", target_type: "device_schedule", target_id: String(id) });
    expect(JSON.parse(a.details)).toEqual({ device_id: w.dev.id, name: "Late", playlist_id: w.evening });
    expect(await one("SELECT owner_id FROM audit_log WHERE action = 'device_schedule_update'")).toEqual({ owner_id: r.ids.editor });
    // all day, every day: it matches now, so it plays
    res = await post(r.editor, `${base()}/${id}`, { name: "Always", playlist_id: String(w.evening), priority: "3",
      start_time: "", end_time: "", start_date: "", end_date: "" });
    expect(res.status).toBe(303);
    expect(await rulesOf(w.dev)).toMatchObject([{ id, name: "Always", start_time: null, end_time: null, days_of_week: null, start_date: null, end_date: null }]);
    expect(await manifest.resolve_active_playlist_id(env, device, wallClock("UTC"))).toEqual([w.evening, "schedule:Always"]);
    const page = await (await r.editor.get("/devices")).text();
    expect(page).toContain('<span class="now-label">active now · via schedule: Always</span>');
    expect(page).toContain('<span class="now-playlist">Evening</span>');
    expect(await count()).toBe(1);
    await query("DELETE FROM device_schedules");
    await query("DELETE FROM audit_log");
  });

  it("answers like Add rule: the same 400s, a 404 for another projector's rule, 403 for a viewer and for an admin on another account's projector", async () => {
    const id = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'keep', 1)", w.dev.id, w.morning);
    const edit = (fields, ...pairs) => post(r.editor, `${base()}/${id}`, form({ name: "x", playlist_id: String(w.morning), ...fields }, ...pairs));
    expect(await detail(await edit({ start_time: "25:00" }), 400)).toBe("The start time must be in HH:MM form (00:00 to 23:59)");
    expect(await detail(await edit({ end_time: "8am" }), 400)).toBe("The end time must be in HH:MM form (00:00 to 23:59)");
    expect(await detail(await edit({ start_time: "09:00", end_time: "9:00" }), 400)).toBe("Start and end must differ; leave both empty for all day");
    expect(await detail(await edit({ start_date: "2026-09-20", end_date: "2026-09-19" }), 400)).toBe("The start date must be on or before the end date");
    expect(await detail(await edit({ start_date: "2026-02-30" }), 400)).toBe("Start date must be a date in YYYY-MM-DD form");
    expect(await detail(await edit({ playlist_id: "" }), 400)).toBe("Pick a playlist");
    expect(await detail(await edit({ priority: "1001" }), 400)).toBe("Priority must be between 0 and 1000");
    expect(await detail(await edit({ days_of_week: "7" }), 400)).toBe("Pick the days by ticking them");
    expect(await detail(await edit({}, ["days_of_week_chk", "1"], ["days_of_week_chk", "9"]), 400)).toBe("Pick the days by ticking them");
    expect(await detail(await edit({ playlist_id: String(NOPE) }), 404)).toBe("Playlist not found");
    const theirs = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'theirs', 1)", w.stage.id, w.morning);
    expect(await detail(await post(r.editor, `${base()}/${theirs}`, { name: "x", playlist_id: String(w.morning) }), 404)).toBe("Schedule rule not found");
    expect(await detail(await post(r.editor, `${base()}/${NOPE}`, { name: "x", playlist_id: String(w.morning) }), 404)).toBe("Schedule rule not found");
    expect((await post(r.editor, `${base()}/abc`, { name: "x", playlist_id: String(w.morning) })).status).toBe(400);
    expect(await detail(await post(r.editor, `/devices/${NOPE}/schedule/${id}`, { name: "x", playlist_id: String(w.morning) }), 404)).toBe("Device not found");
    const adminPl = await playlist("Admin rules", r.ids.admin);
    expect(await detail(await post(r.admin, `${base()}/${id}`, { name: "x", playlist_id: String(adminPl) }), 403)).toBe(OTHER);
    expect(await one("SELECT name FROM device_schedules WHERE id = ?", id)).toEqual({ name: "keep" });
    expect(await one("SELECT name FROM device_schedules WHERE id = ?", theirs)).toEqual({ name: "theirs" });
    expect(await audits("device_schedule_update")).toEqual([]);
    // anonymous back to the login, the viewer 403, the editor saves
    await roleMatrix(r, "POST", `${base()}/${id}`, { fields: { name: "m", playlist_id: String(w.morning) } });
    expect(await one("SELECT name FROM device_schedules WHERE id = ?", id)).toEqual({ name: "m" });
    await query("DELETE FROM device_schedules");
    await query("DELETE FROM audit_log");
  });

  it("no days ticked means every day: unticking them all clears the rule's days without a script", async () => {
    const id = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority, days_of_week) VALUES (?, ?, 'weekdays', 1, '01234')", w.dev.id, w.morning);
    expect((await save(id, {})).status).toBe(303);
    expect(await rulesOf(w.dev)).toMatchObject([{ id, days_of_week: null }]);
    // the boxes win over a days_of_week sent with them
    expect((await save(id, { days_of_week: "0123456" }, ["days_of_week_chk", "6"], ["days_of_week_chk", "6"])).status).toBe(303);
    expect(await rulesOf(w.dev)).toMatchObject([{ id, days_of_week: "6" }]);
    await query("DELETE FROM device_schedules");
  });
});

describe("Also add to", () => {
  it("Add rule with two ticked writes three independent rows, three audit rows and one banner", async () => {
    const res = await post(r.editor, base(), form({ name: "Show", playlist_id: String(w.evening), priority: "5", start_time: "20:00", end_time: "23:00" },
      ["days_of_week_chk", "4"], ["days_of_week_chk", "5"], ["also", String(w.stage.id)], ["also", String(w.bar.id)], ["also", String(w.bar.id)]));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(base());
    const ids = [];
    for (const d of [w.dev, w.stage, w.bar]) {
      const rows = await rulesOf(d);
      expect(rows, d.name).toMatchObject([{ playlist_id: w.evening, name: "Show", priority: 5, start_time: "20:00", end_time: "23:00",
        days_of_week: "45", start_date: null, end_date: null }]);
      ids.push(rows[0].id);
    }
    expect(new Set(ids).size).toBe(3);
    const rows = await query("SELECT target_id, details, owner_id FROM audit_log WHERE action = 'device_schedule_create' ORDER BY id");
    expect(rows.map((a) => [Number(a.target_id), JSON.parse(a.details), a.owner_id])).toEqual([w.dev, w.stage, w.bar].map((d, i) =>
      [ids[i], { device_id: d.id, name: "Show", playlist_id: w.evening }, r.ids.editor]));
    expect(await banner(r.editor, base())).toEqual(["ok", "Rule added to 3 projectors."]);
    // each copy is its own row: deleting or editing one leaves the others alone
    expect((await post(r.editor, `${base(w.stage)}/${ids[1]}/delete`)).status).toBe(303);
    expect((await post(r.editor, `${base()}/${ids[0]}`, { name: "Show moved", playlist_id: String(w.evening), start_time: "21:00", end_time: "23:00" })).status).toBe(303);
    expect((await rulesOf(w.bar))[0]).toMatchObject({ id: ids[2], name: "Show", start_time: "20:00" });
    await query("DELETE FROM device_schedules");
    await query("DELETE FROM audit_log");
  });

  it("a ticked projector that is not another of the account's own fails the whole request before anything is written", async () => {
    const id = await ins("INSERT INTO device_schedules (device_id, playlist_id, name, priority) VALUES (?, ?, 'keep', 1)", w.dev.id, w.morning);
    const before = await count();
    // another account's, a missing one, this projector itself
    for (const bad of [w.admins.id, NOPE, w.dev.id]) {
      const fields = form({ name: "x", playlist_id: String(w.morning) }, ["also", String(w.stage.id)], ["also", String(bad)]);
      expect(await detail(await post(r.editor, base(), fields), 404), `add ${bad}`).toBe("Device not found");
    }
    expect(await detail(await post(r.editor, base(), form({ name: "x", playlist_id: String(w.morning) }, ["also", "abc"])), 400)).toBe("also: value is not a valid integer");
    expect(await count()).toBe(before);
    expect(await one("SELECT name FROM device_schedules WHERE id = ?", id)).toEqual({ name: "keep" });
    expect(await audits("device_schedule_create")).toEqual([]);
    await query("DELETE FROM device_schedules");
  });

  it("a copy's audit row is about its own projector's account: the site admin's ownerless projector has none", async () => {
    const pl = await playlist("Admin PL", r.ids.admin);
    const ownerless = await device("spare", "Spare", { owner_id: null });
    const page = await (await r.admin.get(base(w.admins))).text();
    expect(page).toContain(`name="also" value="${ownerless.id}">Spare</label>`);
    expect(page).not.toContain(`name="also" value="${w.dev.id}"`); // the Devices page shows the admin every projector; this list does not
    const res = await post(r.admin, base(w.admins), form({ name: "Admin rule", playlist_id: String(pl) }, ["also", String(ownerless.id)]));
    expect(res.status).toBe(303);
    const rows = await query("SELECT target_id, owner_id FROM audit_log WHERE action = 'device_schedule_create' ORDER BY id");
    expect(rows.map((a) => a.owner_id)).toEqual([r.ids.admin, null]);
    expect((await rulesOf(ownerless))[0]).toMatchObject({ name: "Admin rule", playlist_id: pl });
    // the editor cannot reach the admin's projectors through its own form
    expect(await detail(await post(r.editor, base(), form({ name: "x", playlist_id: String(w.morning) }, ["also", String(ownerless.id)])), 404)).toBe("Device not found");
  });
});
