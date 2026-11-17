// Platform fixes from the console audit: one time formatter per zone (localTime ran a new
// Intl.DateTimeFormat per row), the Users page in a fixed number of D1 queries whatever the
// account count, a deleted account's R2 files 1000 keys a call, and the markup and stylesheet
// rules behind the focus ring, the top bar, phone buttons, tick boxes in contrast themes, the
// Users table (laptop widths and phone cards), the audit log on a phone and the Settings forms
// (the stylesheet is served as-is, so its rules are asserted as text).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index.js";
import { localTime } from "../src/util.js";
import { BASE, query } from "./helpers.js";
import { device, one, post, roles } from "./pages_common.js";

let r;

beforeAll(async () => {
  r = await roles();
});

afterEach(() => vi.restoreAllMocks());

// A request straight to the worker with some bindings swapped (SELF.fetch keeps the real ones).
const direct = (c, path, bindings, init = {}) => worker.fetch(
  new Request(BASE + path, { ...init, headers: { cookie: c.cookie, ...init.headers } }), { ...env, ...bindings }, createExecutionContext());

describe("localTime", () => {
  // What localTime printed before the cache: a fresh formatter on every call.
  const fresh = (date, timeZone) => {
    const p = {};
    for (const x of new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", timeZoneName: "short",
    }).formatToParts(date)) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day} ${String(+p.hour % 24).padStart(2, "0")}:${p.minute} ${p.timeZoneName}`;
  };

  it("prints exactly what a fresh formatter did, across DST changes, and builds one formatter per zone", () => {
    // half-hour and 45-minute offsets, a half-hour DST shift; a point every 7 h 13 min for a year
    const zones = ["Pacific/Chatham", "America/St_Johns", "Australia/Lord_Howe", "Asia/Kathmandu"];
    const start = Date.UTC(2026, 0, 1);
    for (const tz of zones) {
      for (let t = start; t < start + 365 * 86400e3; t += 433 * 60e3) {
        const d = new Date(t);
        const value = d.toISOString().slice(0, 19).replace("T", " ");
        expect(localTime(value, tz), `${value} ${tz}`).toBe(fresh(d, tz));
      }
    }
    // an unknown zone still throws, every time: nothing broken is kept
    for (let i = 0; i < 2; i++) expect(() => localTime("2026-01-01 00:00:00", "Mars/Olympus")).toThrow(RangeError);
    // every formatter built from here on, by zone (vi.spyOn's stand-in is no formatter under `new`)
    const Real = Intl.DateTimeFormat;
    const built = [];
    Intl.DateTimeFormat = function (locale, options) { built.push(options?.timeZone); return new Real(locale, options); };
    try {
      for (const tz of [...zones, "America/Adak"]) {
        for (let m = 0; m < 100; m++) localTime(`2026-07-01 ${String(10 + (m % 10)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`, tz);
      }
    } finally {
      Intl.DateTimeFormat = Real;
    }
    // 500 rows: the four zones are built already, the new one once (or never, if another test did)
    expect(built.filter((tz) => tz !== "America/Adak")).toEqual([]);
    expect(built.length).toBeLessThanOrEqual(1);
  });
});

describe("Users page", () => {
  it("costs the same D1 queries with 3 accounts or 15, tokens included", async () => {
    // every statement the request prepares, counted
    const statements = async () => {
      let n = 0;
      const DB = new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare") return (sql) => (n++, target.prepare(sql));
          const v = target[key];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const res = await direct(r.admin, "/users", { DB });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("API tokens (");
      return n;
    };
    const before = await statements();
    for (let i = 0; i < 12; i++) {
      expect((await post(r.admin, "/users", { username: `crowd${i}`, password: "pw123456", role: "editor" })).status).toBe(303);
      const { id } = await one("SELECT id FROM users WHERE username = ?", `crowd${i}`);
      expect((await post(r.admin, `/users/${id}/tokens`, { name: `laptop ${i}` })).status).toBe(200);
    }
    expect(await query("SELECT COUNT(*) AS n FROM users")).toEqual([{ n: 15 }]);
    const after = await statements();
    expect(after).toBe(before);
    expect(after).toBeLessThan(10);
    // each token is still listed under its own user (the revoke route names both)
    const page = await (await r.admin.get("/users")).text();
    const tokens = await query("SELECT t.id, t.user_id FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE u.username LIKE 'crowd%'");
    expect(tokens).toHaveLength(12);
    for (const t of tokens) expect(page).toContain(`action="/users/${t.user_id}/tokens/${t.id}/revoke"`);
    await query("DELETE FROM users WHERE username LIKE 'crowd%'");
  });

  it("an account's files and previews leave R2 at most 1000 keys a call", async () => {
    expect((await post(r.admin, "/users", { username: "hoarder", password: "pw123456", role: "editor" })).status).toBe(303);
    const { id } = await one("SELECT id FROM users WHERE username = 'hoarder'");
    await query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 501)
      INSERT INTO media (filename, original_name, media_type, size_bytes, sha256, owner_id)
      SELECT 'hoard-' || i || '.png', 'h.png', 'image', 1, printf('%064d', i), ? FROM n`, id);
    const del = vi.fn(async () => {});
    const res = await direct(r.admin, `/users/${id}/delete`, { MEDIA: { delete: del } }, {
      method: "POST", body: new URLSearchParams({ csrf_token: r.admin.token }), headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(303);
    // 501 files and 501 previews: one call of 1000 keys and one of 2, never a call per key
    expect(del.mock.calls.map(([keys]) => (Array.isArray(keys) ? keys.length : 1))).toEqual([1000, 2]);
    expect(del.mock.calls[0][0].slice(0, 2)).toEqual(["media/hoard-1.png", "thumbs/hoard-1.png.jpg"]);
    expect(await query("SELECT id FROM media WHERE owner_id = ?", id)).toEqual([]);
  });

  it("marks every cell for the phone cards, keeps the created time whole, and the token form in one row", async () => {
    const page = await (await r.admin.get("/users")).text();
    expect(page).toContain('<table class="data stack users">');
    for (const label of ["Role", "Email", "Projectors", "Created", "Change role", "Set password"]) expect(page).toContain(`<td data-label="${label}"`);
    expect(page).toMatch(/<td data-label="Created" class="muted"><span class="nowrap">\d{4}-\d{2}-\d{2}<\/span> <span class="nowrap">\d{2}:\d{2} UTC<\/span><\/td>/);
    expect(page).not.toContain('class="muted nowrap"');
    expect(page).toMatch(new RegExp(`<form method="post" action="/users/${r.ids.editor}/tokens">\\s*<input type="hidden" name="csrf_token" value="[^"]+">\\s*<div class="row">\\s*<input type="text" name="name"`));
    // the full name rides on the top bar's shortened one
    expect(page).toContain('<span class="username" title="admin">admin</span>');
  });
});

describe("Settings page", () => {
  it("puts each create box and its button in one row, the projectors' Save in a row, and says who verifies alert addresses", async () => {
    await device("set-row", "Set Row");
    const page = await (await r.editor.get("/settings")).text();
    for (const action of ["/settings/tokens", "/settings/links"]) {
      expect(page).toMatch(new RegExp(`<form method="post" action="${action}">\\s*<input type="hidden" name="csrf_token" value="[^"]+">\\s*<div class="row">\\s*<input type="text" name="name"[^>]*>\\s*<button type="submit" class="primary small">`));
    }
    expect(page).toMatch(/<\/fieldset>\s*<div class="row">\s*<button type="submit" class="small">Save<\/button>\s*<\/div>\s*<\/form>/);
    expect(page).toContain('<p class="help small">Email alerts reach only addresses the site owner has verified in Cloudflare Email Routing.</p>');
    expect(page).not.toContain("Each email address must be verified");
    // the token table stacks into labelled cards on a phone, here and under each user on /users
    const made = await (await post(r.editor, "/settings/tokens", { name: "card check" })).text();
    expect(made).toMatch(/<table class="data stack">\s*<caption class="sr-only">API tokens<\/caption>/);
    expect(made).toMatch(/<td class="name">card check<\/td>\s*<td data-label="Created" class="muted nowrap">[^<]+<\/td>\s*<td data-label="Last used" class="muted nowrap">never<\/td>/);
  });
});

describe("style.css", () => {
  let css;
  beforeAll(async () => {
    css = await (await r.viewer.get("/static/style.css")).text();
  });
  // The body of the first rule whose selector list is exactly `selector`.
  const rule = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  };
  // The body of the @media block that starts with `head`, to its closing brace on a line of its own.
  const block = (head) => {
    const at = css.indexOf(head);
    expect(at, head).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("\n}", at));
  };

  it("draws a 2px focus ring: outside everything, inside the top-bar links, outside the SD Flasher pill", () => {
    expect(rule(":focus-visible")).toContain("outline: 2px solid var(--p5k-rule-max); outline-offset: 3px;");
    expect(rule(".topbar nav a:focus-visible")).toContain("outline: 2px solid var(--p5k-rule-max); outline-offset: -2px; box-shadow: none;");
    expect(rule(".topbar nav a.nav-flasher:focus-visible")).toContain("outline-offset: 3px;");
    expect(css).not.toContain("outline: 1px solid");
  });

  it("keeps the top bar on one line: the menu button up to 1240px, tight links to 1500px, a short username", () => {
    expect(css).toMatch(/@media \(max-width: 1500px\) \{\n  \.topbar \{ gap: 14px; \}/);
    expect(css).toMatch(/@media \(max-width: 1240px\) \{\n  \.topbar \{ flex-wrap: wrap;/);
    expect(css).not.toMatch(/@media \(max-width: (1000|1400)px\)/);
    expect(rule(".topbar .user .username")).toContain("max-width: 12ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;");
    // the phone menu gives the name all its room, and a longer one ends in an ellipsis there
    // instead of pushing Log out (and the page) past the right edge
    const menu = block("@media (max-width: 1240px)");
    expect(menu).toContain(".topbar .user .username { margin-right: auto; max-width: none; }");
    expect(menu).toMatch(/\.topbar \.user \{ display: none;[^}]* min-width: 0;/);
  });

  it("gives every phone button and disclosure row 44px and fades a disabled button", () => {
    const phone = block("@media (max-width: 720px), (pointer: coarse) {");
    expect(phone).toContain("button, .button, details summary { min-height: var(--p5k-touch); }");
    expect(rule("button[disabled], .button[disabled], button[disabled]:hover, button.small[disabled]")).toContain("opacity: .4;");
  });

  it("hides an unticked box's × by visibility, which contrast themes keep, and frames a ticked card there", () => {
    const box = rule("input[type=checkbox]::before");
    expect(box).toContain("visibility: hidden;");
    expect(box).not.toContain("transparent");
    expect(rule("input[type=checkbox]:checked::before")).toContain("visibility: visible;");
    expect(css).toContain("@media (forced-colors: active) { .media-card:has(input:checked) { outline: 2px solid Highlight; } }");
  });

  it("lets the Users table fit a laptop and stack into cards on a phone", () => {
    expect(rule("table.data td input[type=email], table.data td input[type=text]")).toContain("min-width: 8rem;");
    expect(rule("table.data.users td.name, table.data.users td div.small")).toContain("overflow-wrap: anywhere;");
    // below 1240px only: with room, Set stays beside its box; only the Users forms wrap, never
    // the playlist editor's duration form
    expect(css).toContain("@media (max-width: 1240px) { table.data.users .duration-form { flex-wrap: wrap; } }");
    expect(css).not.toMatch(/table\.data td \.duration-form \{[^}]*flex-wrap/);
    const stack = block("@media (max-width: 720px) {\n  table.data.stack");
    expect(stack).toContain("table.data.stack, table.data.stack tbody, table.data.stack tr, table.data.stack td { display: block; }");
    expect(stack).toContain("table.data.stack thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }");
    expect(stack).toContain("table.data.stack td[data-label]::before { content: attr(data-label); display: block;");
    expect(stack).toContain("table.data.users tr:has(+ .user-tokens) { border-bottom: 0; }");
    expect(stack).toContain("table.data.users .duration-form { display: flex; }");
  });

  it("flows each audit entry as a line on a phone, with its details under it", () => {
    const phone = block("@media (max-width: 720px) {\n  .terminal table.data thead");
    expect(phone).toContain(".terminal table.data tr { display: flex; flex-wrap: wrap; gap: 0 8px; padding: 5px 12px; }");
    expect(phone).toContain(".terminal table.data td.log-d { order: 1; flex-basis: 100%; min-width: 0; }");
  });

  it("wraps the SD Flasher's download links on a phone and keeps a create box wide enough for its hint", () => {
    expect(css).toContain("@media (max-width: 720px) { .row > .button { flex: 1 1 100%; white-space: normal; text-align: center; } }");
    expect(rule(".row > input")).toContain("flex-basis: 260px;");
  });
});
