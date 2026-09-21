// Audit fixes owned by the css-app-audit package: H7 (/audit ?action= filter and ?before= cursor
// keep a human row reachable past the 1000-row cap), L17 (plain-English reorder alerts in
// app.js), L31 (keyboard-driven auto-submit selects), and the style.css numbers behind M19, M20,
// M22, L26 and L34 (the stylesheet is served as-is, so the rules are asserted as text).
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { detail, ins, roles } from "./pages_common.js";

let r;

beforeAll(async () => {
  r = await roles();
});

describe("audit filter and paging (H7)", () => {
  it("an old human row is reachable through ?action= and the older link; params are validated", async () => {
    await query("DELETE FROM audit_log");
    const oldest = await ins("INSERT INTO audit_log (username, action, target_type, target_id) VALUES ('admin', 'user_delete', 'user', 'garret')");
    await query(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1199)
                 INSERT INTO audit_log (username, action) SELECT 'lobby', 'device_update_reported' FROM n`);

    // the cap alone still hides it (that is the bug the filter and cursor fix)
    let page = await (await r.viewer.get("/audit?limit=1000")).text();
    expect(page).not.toContain("user_delete</code>");
    expect(page).toContain("tail -n 1000 audit.log");
    // the older link carries the current limit and the id of the last row shown
    const older = /<a href="\/audit\?limit=1000&amp;before=(\d+)">older<\/a>|<a href="\/audit\?limit=1000&before=(\d+)">older<\/a>/.exec(page);
    expect(older).not.toBeNull();
    const before = older[1] || older[2];
    expect(Number(before)).toBe(oldest + 200);

    page = await (await r.viewer.get(`/audit?limit=1000&before=${before}`)).text();
    expect(page).toContain("user_delete</code>");
    expect(page).toContain("last 200 entries");
    expect(page).not.toContain(">older</a>");
    expect(page).toContain('<a href="/audit?limit=1000">newest</a>');

    // the action filter finds it on the first page
    page = await (await r.viewer.get("/audit?action=user_delete")).text();
    expect(page).toContain("user_delete</code>");
    expect(page).toContain("last 1 entry");
    expect(page).toContain("tail -n 200 audit.log | grep user_delete");
    expect(page).toContain('<option value="user_delete" selected>user_delete</option>');
    expect(page).toContain('<option value="device_update_reported">device_update_reported</option>');
    expect(page).toContain('<option value="">all actions</option>');
    expect(page).toContain('<form method="get" action="/audit"');
    expect(page).toContain('<input type="hidden" name="limit" value="200">');

    // filter + cursor combine, and the older link keeps the filter
    page = await (await r.viewer.get("/audit?limit=100&action=device_update_reported")).text();
    expect(page).toContain(`<a href="/audit?limit=100&action=device_update_reported&before=${oldest + 1100}">older</a>`);
    page = await (await r.viewer.get(`/audit?limit=100&action=device_update_reported&before=${oldest + 2}`)).text();
    expect(page).toContain("last 1 entry");
    expect(page).not.toContain("user_delete</code>");

    // an unknown action is just an empty tail, not an error; bad values are refused
    page = await (await r.viewer.get("/audit?action=nothing_here")).text();
    expect(page).toContain("no entries yet");
    for (const bad of ["abc", "-1", "1.5"]) {
      expect(await detail(await r.viewer.get(`/audit?before=${bad}`), 400), bad).toContain("before");
    }
    for (const bad of ["Bad", "a b", "x-y", "1", "a".repeat(65), "%27%20OR%201=1"]) {
      expect(await detail(await r.viewer.get(`/audit?action=${bad}`), 400), bad).toContain("action");
    }
    await query("DELETE FROM audit_log");
  });
});

describe("app.js (L17, L31)", () => {
  it("reorder alerts read as plain English and keyboard changes on auto-submit selects are held", async () => {
    const js = await (await r.viewer.get("/static/app.js")).text();
    expect(js).toContain("alert('The new order was not saved. Reloading the page.')");
    expect(js).not.toContain("HTTP ' + r.status");
    expect(js).not.toContain("Reorder error");
    // the change handler skips the select the keyboard is driving; Enter and focusout commit it
    expect(js).toContain("e.target !== keyed) autosubmit(e.target)");
    expect(js).toContain("if (e.key === 'Enter') { keyed = e.target; commitKeyed(); }");
    expect(js).toContain("if (e.target === keyed) commitKeyed();");
    expect(js).toContain("el.value !== loadedValue");
  });
});

describe("style.css (M19, M20, M22, L26, L34)", () => {
  // WCAG relative-luminance contrast between two #rrggbb colours.
  const lum = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

  it("the dim token reaches 4.5:1 on the panel, field and raised grounds in both themes", async () => {
    const css = await (await r.viewer.get("/static/style.css")).text();
    const token = (block, name) => new RegExp(`--p5k-${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(block)[1];
    const dark = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: light)"));
    const light = css.slice(css.indexOf('html[data-theme="light"] {'));
    for (const block of [dark, light]) {
      const dim = token(block, "dim");
      for (const ground of ["panel", "panel-2", "field", "raised"]) {
        expect(contrast(dim, token(block, ground)), `${dim} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // the light-theme override under prefers-color-scheme carries the same value
    expect((css.match(/--p5k-dim: #666666;/g) || []).length).toBe(2);
    // the "live" chip on screenshots no longer uses the 2.6:1 grey
    expect(css).toContain(".screen-chip.tr { right: 8px; top: 8px; color: #C9C9C9;");
  });

  it("label sizes, the phone dashboard tiles, the narrow-window menu and the audit details column", async () => {
    const css = await (await r.viewer.get("/static/style.css")).text();
    expect(css).toContain("--p5k-text-label: 12px;");
    expect(css).toContain("--p5k-text-label-sm: 11px;");
    expect(css).toContain("--p5k-text-eyebrow: 11px;");
    expect(css).toMatch(/\.brand-eyebrow \{[^}]*font-size: var\(--p5k-text-eyebrow\)/);
    expect(css).not.toMatch(/font-size: [5-9]px/);
    expect(css).toContain(".cards { grid-template-columns: repeat(2, 1fr); gap: 8px; }");
    // M19: the hamburger block starts at 1000px so iPad portrait and half-screen windows get it
    expect(css).toMatch(/@media \(max-width: 1000px\) \{\n  \.topbar \{ flex-wrap: wrap;/);
    expect(css).not.toMatch(/@media \(max-width: 720px\) \{\n  \.topbar \{/);
    // L34
    expect(css).toContain(".terminal .log-d { color: var(--p5k-soft); overflow-wrap: anywhere; min-width: 14rem; }");
  });
});
