// Alerts (F): conditions + evaluate with fixed clocks (open once, recovered, repeat after the
// quiet period, offline freezes the rest), the cron dispatch, channel payload shapes with fetch
// and the mail binding faked, the Settings panel (validation, secrets never echoed, Send test
// banners), the /alerts page and the dashboard badge.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index.js";
import * as alerts from "../src/alerts.js";
import * as secrets from "../src/secrets.js";
import { nowUtc } from "../src/util.js";
import { query } from "./helpers.js";
import { audits, detail, device, one, post, roleMatrix, roles } from "./pages_common.js";

const NOW = new Date("2026-09-16T10:00:00Z");
const ago = (seconds, from = NOW) => nowUtc(new Date(from.getTime() - seconds * 1000));
const later = (minutes) => new Date(NOW.getTime() + minutes * 60000);
const SETTINGS = { timezone: "UTC", screenshot_interval: 60, alert_offline_minutes: 10, alert_repeat_minutes: 240, alert_email: "", alert_webhook_url: "" };
const rows = (where = "1=1") => query(`SELECT a.device_id, a.kind, a.opened_at, a.closed_at, a.notified_at FROM alerts a WHERE ${where} ORDER BY a.id`);
const setDevice = (id, cols) => query(`UPDATE devices SET ${Object.keys(cols).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...Object.values(cols), id);
// One evaluator pass at `at` with the lobby device having synced 30 s before (so only the
// fault columns decide), unless `cols` says otherwise.
async function run(at, cols = {}) {
  await setDevice(lobby.id, { last_seen_at: ago(30, at), ...cols });
  return alerts.evaluate(env, at);
}
const MSG = { subject: "Projection5000: 1 opened", text: "ALERT 1\nLobby (lobby): offline (no sync) since 2026-09-16 09:00 UTC" };

// fetch stub capturing every outbound call; answers `status` with `body`.
function stubFetch(status = 200, body = "{}") {
  const calls = [];
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push({ url: String(url), init, body: init && init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init && init.body });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

let r;
let lobby;
let hall;

beforeAll(async () => {
  r = await roles();
  lobby = await device("lobby", "Lobby", { last_seen_at: ago(30), player_status: "playing" });
  hall = await device("hall", "Hall");
});

afterEach(() => vi.unstubAllGlobals());

describe("conditions", () => {
  it("each stored fault maps to one kind; a device that never synced has none; offline wins", () => {
    const base = { last_seen_at: ago(30), player_status: "playing", last_screenshot_at: ago(30), last_error: null, last_update_ok: null, camera_error: null, projector_error: null };
    expect(alerts.conditions(base, SETTINGS, NOW)).toEqual(new Set());
    expect(alerts.conditions({ ...base, last_seen_at: null, last_error: "x" }, SETTINGS, NOW)).toEqual(new Set());
    expect(alerts.conditions({ ...base, player_status: "mpv-down" }, SETTINGS, NOW)).toEqual(new Set(["mpv-down"]));
    // stale = 3 intervals behind the last sync (30 s ago), not behind the clock
    expect(alerts.conditions({ ...base, last_screenshot_at: ago(211) }, SETTINGS, NOW)).toEqual(new Set(["screenshot-stale"]));
    expect(alerts.conditions({ ...base, last_screenshot_at: ago(209) }, SETTINGS, NOW)).toEqual(new Set());
    expect(alerts.conditions({ ...base, last_seen_at: ago(200), last_screenshot_at: ago(260) }, SETTINGS, NOW)).toEqual(new Set());
    expect(alerts.conditions({ ...base, last_screenshot_at: null }, SETTINGS, NOW)).toEqual(new Set());
    expect(alerts.conditions({ ...base, last_error: "boom" }, SETTINGS, NOW)).toEqual(new Set(["sync-error"]));
    expect(alerts.conditions({ ...base, last_update_ok: 0 }, SETTINGS, NOW)).toEqual(new Set(["update-failed"]));
    expect(alerts.conditions({ ...base, last_update_ok: 1 }, SETTINGS, NOW)).toEqual(new Set());
    expect(alerts.conditions({ ...base, camera_error: "no cam" }, SETTINGS, NOW)).toEqual(new Set(["camera-error"]));
    expect(alerts.conditions({ ...base, projector_error: "no ir" }, SETTINGS, NOW)).toEqual(new Set(["projector-error"]));
    expect(alerts.conditions({ ...base, last_error: "a", camera_error: "b", player_status: "mpv-down" }, SETTINGS, NOW))
      .toEqual(new Set(["mpv-down", "sync-error", "camera-error"]));
    // offline after alert_offline_minutes (never below the page's 180 s), and then nothing else
    expect(alerts.conditions({ ...base, last_seen_at: ago(599), last_error: "a" }, SETTINGS, NOW)).toEqual(new Set(["sync-error"]));
    expect(alerts.conditions({ ...base, last_seen_at: ago(601), last_error: "a" }, SETTINGS, NOW)).toEqual(new Set(["offline"]));
    expect(alerts.conditions({ ...base, last_seen_at: ago(200) }, { ...SETTINGS, alert_offline_minutes: 1 }, NOW)).toEqual(new Set(["offline"]));
    expect(alerts.conditions({ ...base, last_seen_at: ago(170) }, { ...SETTINGS, alert_offline_minutes: 1 }, NOW)).toEqual(new Set());
  });
});

describe("evaluate", () => {
  it("opens once, repeats after the quiet period, closes as recovered; audits; nothing sent without channels", async () => {
    let res = await run(NOW, { last_error: "sync failed" });
    expect(res).toEqual({ opened: 1, closed: 0, repeated: 0, sent: [], errors: [] });
    expect(await rows()).toEqual([{ device_id: lobby.id, kind: "sync-error", opened_at: nowUtc(NOW), closed_at: null, notified_at: nowUtc(NOW) }]);
    // dedupe: still failing 5 min later -> nothing new, no repeat yet
    res = await run(later(5));
    expect(res).toEqual({ opened: 0, closed: 0, repeated: 0, sent: [], errors: [] });
    expect((await rows()).length).toBe(1);
    // repeat once the quiet period (240 min) has passed, stamping notified_at
    expect((await run(later(239))).repeated).toBe(0);
    res = await run(later(240));
    expect(res.repeated).toBe(1);
    expect((await rows())[0].notified_at).toBe(nowUtc(later(240)));
    expect((await run(later(245))).repeated).toBe(0);
    expect((await run(later(480))).repeated).toBe(1);
    // cleared -> closed with the recovery stamp; a later run does nothing
    res = await run(later(490), { last_error: null });
    expect(res).toEqual({ opened: 0, closed: 1, repeated: 0, sent: [], errors: [] });
    expect((await rows())[0].closed_at).toBe(nowUtc(later(490)));
    expect(await run(later(495))).toEqual({ opened: 0, closed: 0, repeated: 0, sent: [], errors: [] });
    // failing again opens a NEW row
    expect((await run(later(500), { last_error: "again" })).opened).toBe(1);
    expect((await rows()).map((a) => a.closed_at)).toEqual([nowUtc(later(490)), null]);
    const opened = await audits("alert_opened");
    expect(opened.length).toBe(2);
    expect(opened[0]).toEqual({ username: null, target_type: "device", target_id: "lobby", details: '{"kind": "sync-error"}', ip: null });
    expect((await audits("alert_closed")).length).toBe(1);
    await run(later(505), { last_error: null });
    await query("DELETE FROM alerts");
    await query("DELETE FROM audit_log WHERE action LIKE 'alert_%'");
  });

  it("repeat 0 never re-notifies; offline keeps the other alerts frozen until the device is back", async () => {
    await query("INSERT INTO settings (key, value) VALUES ('alert_repeat_minutes', '0')");
    expect((await run(NOW, { camera_error: "no cam" })).opened).toBe(1);
    expect((await run(later(600))).repeated).toBe(0);
    await query("DELETE FROM settings WHERE key = 'alert_repeat_minutes'");
    // goes offline (last sync at 600): only "offline" opens; camera-error stays open (the columns are frozen)
    const res = await alerts.evaluate(env, later(611));
    expect(res.opened).toBe(1);
    expect(res.closed).toBe(0);
    expect((await rows("a.closed_at IS NULL")).map((a) => a.kind).sort()).toEqual(["camera-error", "offline"]);
    // back online with the camera fixed: offline and camera-error both recover
    const back = await run(later(620), { camera_error: null });
    expect(back).toMatchObject({ opened: 0, closed: 2 });
    expect((await rows("a.closed_at IS NULL")).length).toBe(0);
    await query("DELETE FROM alerts");
  });

  it("the */5 cron runs the evaluator, the daily cron does not", async () => {
    const ALERT_CRON = alerts.CRON;
    expect(ALERT_CRON).toBe("*/5 * * * *");
    // Real clock here (worker.scheduled has no injected `now`): keep the lobby fresh.
    await setDevice(lobby.id, { last_seen_at: ago(30, new Date()) });
    await setDevice(hall.id, { last_seen_at: nowUtc(new Date(Date.now() - 3600 * 1000)) });
    await worker.scheduled(createScheduledController({ cron: "0 3 * * *" }), env, createExecutionContext());
    expect((await rows()).length).toBe(0);
    await worker.scheduled(createScheduledController({ cron: ALERT_CRON }), env, createExecutionContext());
    expect((await rows()).map((a) => [a.device_id, a.kind])).toEqual([[hall.id, "offline"]]);
    await setDevice(hall.id, { last_seen_at: null });
    await query("DELETE FROM alerts");
  });

  it("the daily cron prunes closed alerts older than 90 days and keeps the rest", async () => {
    // Real clock: the SQL compares against datetime('now').
    const real = new Date();
    const daysAgo = (n) => ago(n * 86400, real);
    await query("INSERT INTO alerts (device_id, kind, opened_at, closed_at, notified_at) VALUES (?, 'offline', ?, ?, ?)", hall.id, daysAgo(92), daysAgo(91), daysAgo(91));
    await query("INSERT INTO alerts (device_id, kind, opened_at, closed_at, notified_at) VALUES (?, 'offline', ?, ?, ?)", hall.id, daysAgo(11), daysAgo(10), daysAgo(10));
    await query("INSERT INTO alerts (device_id, kind, opened_at, closed_at, notified_at) VALUES (?, 'mpv-down', ?, NULL, ?)", hall.id, daysAgo(200), daysAgo(200));
    await worker.scheduled(createScheduledController({ cron: "0 3 * * *" }), env, createExecutionContext());
    expect((await rows()).map((a) => [a.kind, a.closed_at])).toEqual([["offline", daysAgo(10)], ["mpv-down", null]]);
    await query("DELETE FROM alerts");
  });

  // env.DB.prepare wrapped so `hook(sql)` runs inside .run() of every matching statement.
  function hookInsert(pattern, hook) {
    const orig = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const stmt = orig(sql);
      if (!pattern.test(sql)) return stmt;
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...p) => {
        const b = bind(...p);
        const run = b.run.bind(b);
        b.run = async () => { await hook(sql, p); return run(); };
        return b;
      };
      return stmt;
    };
    return () => { delete env.DB.prepare; };
  }

  it("a run that throws before its digest leaves the rows unstamped; the next run announces them", async () => {
    await query("INSERT INTO settings (key, value) VALUES ('alert_webhook_url', 'https://hooks.example.com/a')");
    await setDevice(hall.id, { last_seen_at: ago(30), last_error: "hall broke" });
    let inserts = 0;
    const restore = hookInsert(/INSERT OR IGNORE INTO alerts/, async () => { if (++inserts === 2) throw new Error("D1 hiccup"); });
    try {
      await expect(run(NOW, { last_error: "lobby broke" })).rejects.toThrow("D1 hiccup");
    } finally {
      restore();
    }
    expect((await rows()).map((a) => [a.device_id, a.notified_at])).toEqual([[lobby.id, null]]);
    const calls = stubFetch(200);
    expect(await run(later(5))).toEqual({ opened: 2, closed: 0, repeated: 0, sent: ["webhook"], errors: [] });
    const text = JSON.parse(calls[0].body).text;
    expect(text).toContain("Lobby (lobby): sync error since 2026-09-16 10:00 UTC");
    expect(text).toContain("Hall (hall): sync error since 2026-09-16 10:05 UTC");
    expect((await rows()).map((a) => a.notified_at)).toEqual([nowUtc(later(5)), nowUtc(later(5))]);
    await setDevice(hall.id, { last_seen_at: ago(30, later(10)) });
    expect(await run(later(10))).toEqual({ opened: 0, closed: 0, repeated: 0, sent: [], errors: [] });
    await setDevice(hall.id, { last_seen_at: null, last_error: null });
    await run(later(15), { last_error: null });
    await query("DELETE FROM settings WHERE key = 'alert_webhook_url'");
    await query("DELETE FROM alerts");
  });

  it("an overlapping run opening the same (device, kind) does not make a duplicate row", async () => {
    // migrations/0006_indexes.sql (idx_alerts_one_open) refuses a second open row per (device, kind)
    const opened = (await audits("alert_opened")).length;
    // the other run inserts between this run's SELECT and its INSERT
    const restore = hookInsert(/INSERT OR IGNORE INTO alerts/, (sql, p) => query("INSERT INTO alerts (device_id, kind, opened_at) VALUES (?, ?, ?)", ...p));
    let res;
    try {
      res = await run(NOW, { camera_error: "no cam" });
    } finally {
      restore();
    }
    expect(res).toEqual({ opened: 0, closed: 0, repeated: 0, sent: [], errors: [] });
    expect((await rows()).map((a) => [a.device_id, a.kind])).toEqual([[lobby.id, "camera-error"]]);
    expect((await audits("alert_opened")).length).toBe(opened);
    await run(later(5), { camera_error: null });
    await query("DELETE FROM alerts");
  });
});

describe("channels", () => {
  it("digest lists opened / recovered / still open with one subject line", () => {
    const e = (kind, name = "Lobby") => ({ device: { name, device_id: name.toLowerCase() }, kind, opened_at: "2026-09-16 09:00:00" });
    const d = alerts.digest({ opened: [e("offline")], closed: [e("sync-error", "Hall")], repeated: [e("camera-error")] });
    expect(d.subject).toBe("Projection5000: 1 opened, 1 recovered, 1 still open");
    expect(d.text.split("\n")).toEqual([
      "ALERT 1", "Lobby (lobby): offline (no sync) since 2026-09-16 09:00 UTC",
      "RECOVERED 1", "Hall (hall): sync error since 2026-09-16 09:00 UTC",
      "STILL OPEN 1", "Lobby (lobby): camera error since 2026-09-16 09:00 UTC",
    ]);
    expect(alerts.digest({ opened: [e("offline")] }).subject).toBe("Projection5000: 1 opened");
  });

  it("email: one raw message per address through the binding; absent binding or address is a soft error", async () => {
    const sent = [];
    const fakeEnv = { ...env, ALERT_MAIL: { send: async (m) => sent.push(m) } };
    const s = { ...SETTINGS, alert_email: "a@example.com, b@example.org" };
    expect(await alerts.send(fakeEnv, s, "email", MSG)).toBeNull();
    expect(sent.length).toBe(2);
    expect(sent.map((m) => m.to)).toEqual(["a@example.com", "b@example.org"]);
    expect(sent[0].from).toBe("alerts@photogen5000.com");
    const raw = alerts.rawEmail("alerts@photogen5000.com", "a@example.com", "Projection5000: ünïcode", "line1\nline2", new Date("2026-09-16T10:00:00Z"));
    expect(raw).toContain("From: Projection5000 alerts <alerts@photogen5000.com>\r\nTo: a@example.com\r\n");
    expect(raw).toContain("Subject: =?utf-8?B?");
    expect(raw).toContain("Date: Wed, 16 Sep 2026 10:00:00 GMT\r\nMessage-ID: <");
    expect(raw).toContain("@photogen5000.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n");
    expect(raw.endsWith("\r\n\r\nline1\r\nline2\r\n")).toBe(true);
    expect(alerts.rawEmail("a@b.c", "d@e.f", "plain", "x")).toContain("Subject: plain\r\n");
    expect(await alerts.send({ ...env, ALERT_MAIL: undefined }, s, "email", MSG)).toBe("ALERT_MAIL send_email binding is not configured");
    expect(await alerts.send(fakeEnv, SETTINGS, "email", MSG)).toBe("no alert email address set");
    expect(await alerts.send({ ...env, ALERT_MAIL: { send: async () => { throw new Error("rejected by routing"); } } }, s, "email", MSG)).toBe("rejected by routing");
  });

  it("webhook: JSON POST with text / content / message / title; non-2xx and a bad URL are errors", async () => {
    let calls = stubFetch(200);
    const s = { ...SETTINGS, alert_webhook_url: "https://hooks.example.com/x/y" };
    expect(await alerts.send(env, s, "webhook", MSG)).toBeNull();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://hooks.example.com/x/y");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body)).toEqual({
      site: "Projection5000", title: MSG.subject, text: `${MSG.subject}\n${MSG.text}`, content: `${MSG.subject}\n${MSG.text}`, message: MSG.text,
    });
    calls = stubFetch(500);
    expect(await alerts.send(env, s, "webhook", MSG)).toBe("webhook answered 500");
    expect(await alerts.send(env, { ...SETTINGS, alert_webhook_url: "http://plain.example.com/" }, "webhook", MSG)).toBe("no valid https webhook URL set");
    expect(calls.length).toBe(1);
    vi.stubGlobal("fetch", async () => { throw new TypeError("connect failed"); });
    expect(await alerts.send(env, s, "webhook", MSG)).toBe("connect failed");
  });

  it("sms: Twilio Messages.json with basic auth and From/To/Body; error text from the JSON answer", async () => {
    expect(await alerts.send(env, SETTINGS, "sms", MSG)).toBe("Twilio account sid, auth token, from and to must all be set");
    for (const [n, v] of [["twilio_account_sid", "AC123"], ["twilio_auth_token", "tok"], ["twilio_from", "+15550001111"], ["twilio_to", "+15550002222"]]) await secrets.set(env, n, v);
    let calls = stubFetch(201, '{"sid":"SM1"}');
    expect(await alerts.send(env, SETTINGS, "sms", MSG)).toBeNull();
    expect(calls[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(calls[0].init.headers.authorization).toBe(`Basic ${btoa("AC123:tok")}`);
    expect(calls[0].body).toEqual({ From: "+15550001111", To: "+15550002222", Body: `${MSG.subject}\n${MSG.text}` });
    calls = stubFetch(401, '{"code":20003,"message":"Authenticate"}');
    expect(await alerts.send(env, SETTINGS, "sms", MSG)).toBe("Twilio answered 401: Authenticate");
    // the To / From numbers are secrets: Twilio's validation text must not leak them
    calls = stubFetch(400, JSON.stringify({ code: 21211, message: "The 'To' number +15550002222 is not a valid phone number." }));
    expect(await alerts.send(env, SETTINGS, "sms", MSG)).toBe("Twilio answered 400: The 'To' number (number hidden) is not a valid phone number.");
    expect(alerts.smsBody({ subject: "s", text: "x".repeat(1000) }).length).toBe(600);
    for (const n of alerts.TWILIO_NAMES) await secrets.set(env, n, "");
  });

  it("evaluate sends one digest per configured channel, records failures without retrying, unknown channel", async () => {
    await query("INSERT INTO settings (key, value) VALUES ('alert_webhook_url', 'https://hooks.example.com/a')");
    const calls = stubFetch(503);
    const res = await run(NOW, { projector_error: "no ir" });
    expect(res).toEqual({ opened: 1, closed: 0, repeated: 0, sent: [], errors: ["webhook: webhook answered 503"] });
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].body).text).toContain("Lobby (lobby): projector error since 2026-09-16 10:00 UTC");
    expect((await audits("alert_notify_failed"))[0]).toMatchObject({ target_type: "settings", target_id: "webhook", details: '{"error": "webhook answered 503"}' });
    expect((await rows())[0].notified_at).toBe(nowUtc(NOW)); // stamped: no retry storm
    expect(await run(later(5))).toEqual({ opened: 0, closed: 0, repeated: 0, sent: [], errors: [] });
    expect(calls.length).toBe(1);
    stubFetch(200);
    expect(await run(later(10), { projector_error: null })).toEqual({ opened: 0, closed: 1, repeated: 0, sent: ["webhook"], errors: [] });
    expect(await alerts.send(env, SETTINGS, "pigeon", MSG)).toBe("unknown channel pigeon");
    await query("DELETE FROM settings WHERE key = 'alert_webhook_url'");
    await query("DELETE FROM alerts");
  });
});

describe("settings panel", () => {
  const GOOD = { alert_offline_minutes: "15", alert_repeat_minutes: "60", alert_email: "ops@example.com", alert_webhook_url: "https://hooks.example.com/z" };
  const alertRows = () => query("SELECT key, value FROM settings WHERE key LIKE 'alert_%' ORDER BY key");

  it("admin only; page shows the defaults and the not-configured badges", async () => {
    await roleMatrix(r, "GET", "/settings", { minRole: "admin" });
    await roleMatrix(r, "POST", "/settings/alerts", { minRole: "admin", fields: GOOD });
    await roleMatrix(r, "POST", "/settings/alerts/test", { minRole: "admin", fields: { channel: "nope" }, ok: 400 });
    await roleMatrix(r, "POST", "/settings/alerts/twilio/clear", { minRole: "admin" });
    await query("DELETE FROM settings WHERE key LIKE 'alert_%'");
    const page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('name="alert_offline_minutes" value="10"');
    expect(page).toContain('name="alert_repeat_minutes" value="240"');
    expect(page).toContain('name="alert_email" value=""');
    expect(page).toContain('name="alert_webhook_url" value=""');
    expect(page).toContain('<button type="submit" class="small" disabled>Send test email</button>');
    expect(page).toContain('<button type="submit" class="small" disabled>Send test webhook</button>');
    expect(page).toContain('<button type="submit" class="small" disabled>Send test sms</button>');
    expect(page).not.toContain("Clear Twilio");
    expect(page).toContain('href="/alerts"');
  });

  it("validation 400s; nothing saved", async () => {
    for (const [fields, msg] of [
      [{ ...GOOD, alert_offline_minutes: "0" }, "Offline after must be a whole number of minutes, 1-1440"],
      [{ ...GOOD, alert_offline_minutes: "x" }, "Offline after must be a whole number"],
      [{ ...GOOD, alert_offline_minutes: "" }, "Offline after must be a whole number of minutes, 1-1440"],
      [{ ...GOOD, alert_repeat_minutes: "-1" }, "Repeat while open must be a whole number of minutes, 0-10080"],
      [{ ...GOOD, alert_repeat_minutes: "10081" }, "Repeat while open must be a whole number of minutes, 0-10080"],
      [{ ...GOOD, alert_email: "not-an-address" }, "Enter one or more email addresses, separated by commas"],
      [{ ...GOOD, alert_email: "a@b.co, junk" }, "Enter one or more email addresses, separated by commas"],
      [{ ...GOOD, alert_webhook_url: "http://hooks.example.com/z" }, "The webhook must be an https:// address"],
      [{ ...GOOD, alert_webhook_url: "https://user:pw@hooks.example.com/z" }, "The webhook must be an https:// address"],
      [{ ...GOOD, alert_webhook_url: "javascript:alert(1)" }, "The webhook must be an https:// address"],
      [{ ...GOOD, twilio_auth_token: "bad\x01" }, "Twilio auth token must be at most 200 printable characters"],
    ]) {
      expect(await detail(await post(r.admin, "/settings/alerts", fields), 400), JSON.stringify(fields)).toBe(msg);
    }
    expect(await alertRows()).toEqual([]);
  });

  it("saves and audits (credentials as 'set'), shows configured badges + enabled test buttons, keeps or clears Twilio", async () => {
    const res = await post(r.admin, "/settings/alerts", { ...GOOD, twilio_account_sid: "AC9", twilio_auth_token: "secret-tok", twilio_from: "+1555", twilio_to: "+1666" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
    expect(await alertRows()).toEqual([
      { key: "alert_email", value: "ops@example.com" }, { key: "alert_offline_minutes", value: "15" },
      { key: "alert_repeat_minutes", value: "60" }, { key: "alert_webhook_url", value: "https://hooks.example.com/z" },
    ]);
    expect(await secrets.get(env, "twilio_auth_token")).toBe("secret-tok");
    const a = (await audits("alert_settings_update"))[0];
    expect(a.details).toBe('{"alert_offline_minutes": 15, "alert_repeat_minutes": 60, "alert_email": "ops@example.com", "alert_webhook_url": "set", "twilio_account_sid": "set", "twilio_auth_token": "set", "twilio_from": "set", "twilio_to": "set"}');
    let page = await (await r.admin.get("/settings")).text();
    expect(page).not.toContain("secret-tok");
    expect(page).not.toContain("AC9");
    expect(page).toContain('name="alert_email" value="ops@example.com"');
    expect(page).toContain('<button type="submit" class="small">Send test email</button>');
    expect(page).toContain('<button type="submit" class="small">Send test webhook</button>');
    expect(page).toContain('<button type="submit" class="small">Send test sms</button>');
    expect(page).toContain("Clear Twilio");
    expect((page.match(/badge-active" title="Twilio credential">set</g) || []).length).toBe(4);
    // empty Twilio fields keep the secrets; an empty address / URL turns the channel off
    expect((await post(r.admin, "/settings/alerts", { ...GOOD, alert_email: "", alert_webhook_url: "" })).status).toBe(303);
    expect(await secrets.get(env, "twilio_auth_token")).toBe("secret-tok");
    expect((await alertRows()).map((x) => x.key)).toEqual(["alert_offline_minutes", "alert_repeat_minutes"]);
    page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('<button type="submit" class="small" disabled>Send test email</button>');
    expect((await post(r.admin, "/settings/alerts/twilio/clear")).status).toBe(303);
    expect(await secrets.names(env)).toEqual(new Set());
    expect(await (await r.admin.get("/settings")).text()).not.toContain("Clear Twilio");
    await query("DELETE FROM settings WHERE key LIKE 'alert_%'");
  });

  it("Send test: unknown channel 400; unconfigured channel -> failure banner; webhook success banner; audited", async () => {
    expect(await detail(await post(r.admin, "/settings/alerts/test", { channel: "carrier-pigeon" }), 400)).toBe("Pick a channel to test");
    let res = await post(r.admin, "/settings/alerts/test", { channel: "email" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
    let page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('<div class="alert error" role="alert">Test alert failed: email: no alert email address set</div>');
    expect(await (await r.admin.get("/settings")).text()).not.toContain("Test alert failed"); // shown once
    await query("INSERT INTO settings (key, value) VALUES ('alert_webhook_url', 'https://hooks.example.com/t')");
    const calls = stubFetch(200);
    res = await post(r.admin, "/settings/alerts/test", { channel: "webhook" });
    expect(res.headers.get("location")).toBe("/settings");
    expect(calls.length).toBe(1);
    expect(JSON.parse(calls[0].body).text).toContain("requested by admin");
    page = await (await r.admin.get("/settings")).text();
    expect(page).toContain('<div class="alert ok" role="alert">Test webhook alert sent.</div>');
    const t = await audits("alert_test_sent");
    expect(t.map((x) => [x.target_id, x.details])).toEqual([["webhook", null], ["email", '{"error": "no alert email address set"}']]);
    // the banner is never driven by the query string (a link cannot put words in the red box)
    page = await (await r.admin.get("/settings?test_error=" + encodeURIComponent("<b>x") + "&tested=webhook")).text();
    expect(page).not.toContain("Test alert failed");
    expect(page).not.toContain("alert sent");
    await query("DELETE FROM settings WHERE key LIKE 'alert_%'");
  });
});

describe("/alerts page + dashboard badge", () => {
  it("any role reads it; lists open and recovered rows; nav link; dashboard card counts open alerts", async () => {
    await roleMatrix(r, "GET", "/alerts");
    let page = await (await r.editor.get("/alerts")).text();
    expect(page).toContain('href="/alerts" class="active"');
    expect(page).toContain("ALL CLEAR");
    expect(page).toContain("Nothing recovered yet.");
    expect(page).not.toContain('href="/settings"'); // viewer: no settings hint
    await query("INSERT INTO alerts (device_id, kind, opened_at, closed_at, notified_at) VALUES (?, 'offline', '2026-09-16 09:00:00', NULL, '2026-09-16 09:00:00')", lobby.id);
    await query("INSERT INTO alerts (device_id, kind, opened_at, closed_at, notified_at) VALUES (?, 'camera-error', '2026-09-15 09:00:00', '2026-09-15 10:30:00', '2026-09-15 10:30:00')", hall.id);
    page = await (await r.admin.get("/alerts")).text();
    expect(page).toContain("<strong>1 open</strong>");
    expect(page).toContain("Open · 1");
    expect(page).toContain("Recently recovered · 1");
    expect(page).toContain('Lobby <code class="muted small">lobby</code>');
    expect(page).toContain('<span class="badge badge-stale">offline (no sync)</span>');
    expect(page).toContain('<span class="badge badge-stale">camera error</span>');
    expect(page).toContain("2026-09-15 10:30 UTC");
    expect(page).toContain('href="/settings">Settings</a>');
    const dash = await (await r.editor.get("/dashboard")).text();
    expect(dash).toContain('<a class="card" href="/alerts" id="alerts-card">');
    expect(dash).toContain('<span class="card-value">1</span>');
    expect(dash).toContain('<span class="badge badge-stale">1 open</span>');
    await query("DELETE FROM alerts");
    expect(await (await r.editor.get("/dashboard")).text()).toContain("all clear · checked every 5 min");
  });

  it("deleting a device drops its alerts", async () => {
    const gone = await device("gone", "Gone");
    await query("INSERT INTO alerts (device_id, kind) VALUES (?, 'offline')", gone.id);
    expect((await post(r.admin, `/devices/${gone.id}/delete`)).status).toBe(303);
    expect(await one("SELECT id FROM alerts WHERE device_id = ?", gone.id)).toBeNull();
  });
});
