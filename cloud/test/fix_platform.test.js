// Platform fixes from the console-ui release check, one test per finding id: phone and tablet
// layout (long names with no spaces, the Users and Audit tables up to 1120px), focus rings, the
// 16px no-zoom rule on a phone held sideways, the top bar without scripts, two hints cut on a
// phone, and a deploy that stops while a migration is still pending. The stylesheet is served
// as-is, so its rules are asserted as text (as in platform.test.js).
import { beforeAll, describe, expect, it } from "vitest";
import { roles } from "./pages_common.js";

let r;
let css;

beforeAll(async () => {
  r = await roles();
  css = await (await r.viewer.get("/static/style.css")).text();
});

// The body of the first rule whose selector list is exactly `selector`.
const rule = (selector) => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
};
// The @media block that starts with `head`, to its closing brace on a line of its own.
const block = (head) => {
  const at = css.indexOf(head);
  expect(at, head).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("\n}", at));
};

describe("style.css", () => {
  it("phone-find-show-overflow: Find and its labels may be narrower than a long 'Only in <Default>'", () => {
    expect(rule(".media-find")).toContain("min-width: 0;");
    expect(rule(".media-find label")).toContain("min-width: 0;");
  });

  it("list-768-unspaced-name-cuts-actions: a Playlists list name breaks anywhere", () => {
    expect(rule("table.data.stack td.name > a")).toContain("overflow-wrap: anywhere;");
    // not every name cell: beside a long schedule state an ordinary word broke in two
    expect(css).not.toMatch(/\ntable\.data\.stack td\.name \{[^}]*overflow-wrap/);
  });

  it("no-preview-label-covered-88px: the 88px tile hides its badge and running time while it has no picture", () => {
    expect(css).toContain("@media (max-width: 900px) {\n  .sortable-table .media-thumb.no-preview > span, .sortable-table .media-thumb.is-making > span { display: none; }\n}");
  });

  it("viewer-editor-h1-unspaced-name-overflow: a page heading breaks anywhere", () => {
    expect(rule(".page-head h1")).toContain("overflow-wrap: anywhere;");
  });

  it("schedule-state-badge-pushes-actions-offscreen: a badge in a table wraps", () => {
    expect(rule("table.data td .badge")).toContain("white-space: normal;");
  });

  it("readonly-actions-cell-blank-band: a whitespace-only actions cell is hidden, which :empty never matched", () => {
    const stack = block("@media (max-width: 720px) {\n  table.data.stack");
    expect(stack).toContain("table.data.stack td:not([data-label]):not(.name):not(:has(*)) { display: none; }");
    expect(css).not.toContain("td:empty");
  });

  it("also-add-to-long-name-overflow: a projector name under Also add to breaks anywhere", () => {
    expect(rule(".days-fieldset .inline-check")).toContain("overflow-wrap: anywhere;");
  });

  it("ticked-box-focus-invisible: a tick box gets the 2px ring that input:focus took away", () => {
    expect(rule("input[type=checkbox]:focus-visible")).toContain("outline: 2px solid var(--p5k-rule-max); outline-offset: 3px;");
  });

  it("users-table-offscreen-768: the Users table is a card per user up to 1120px, its token tables stay tables", () => {
    const users = block("@media (max-width: 1120px) {\n  table.data.users");
    expect(users).toContain("table.data.users, table.data.users > tbody, table.data.users > tbody > tr, table.data.users > tbody > tr > td { display: block; }");
    expect(users).toContain("table.data.users > thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }");
    expect(users).toContain("table.data.users > tbody > tr > td:not([data-label]):not(.name):not(:has(*)) { display: none; }");
    expect(users).toContain("table.data.users > tbody > tr > td[data-label]::before { content: attr(data-label); display: block;");
    // and the Audit log flows as lines to the same width
    expect(css).toContain("@media (max-width: 1120px) {\n  .terminal table.data thead");
    expect(css).not.toContain("@media (max-width: 720px) {\n  .terminal table.data thead");
  });

  it("device-screen-link-focus-light: the screenshot link's ring is drawn over the picture, white edged in black", () => {
    expect(rule(".device-screen > a:focus-visible::after"))
      .toContain('content: ""; position: absolute; inset: 3px; border: 2px solid #FFFFFF; box-shadow: 0 0 0 1px #000000, inset 0 0 0 1px #000000;');
  });

  it("audit-long-username-390: an audit username breaks anywhere where entries flow as lines", () => {
    expect(block("@media (max-width: 1120px) {\n  .terminal table.data thead")).toContain(".terminal table.data td.log-u { overflow-wrap: anywhere; }");
  });

  it("drag-handle-under-44: the editor's handle fills both lines of its row", () => {
    expect(block("@media (max-width: 800px) {\n  .sortable-table thead"))
      .toContain(".sortable-table tbody td.drag-handle { align-self: stretch; display: flex; align-items: center; justify-content: center; }");
  });

  it("nojs-nav-1240: without scripts the links and Log out stay listed below 1240px", () => {
    const noScript = css.indexOf("@media (max-width: 1240px) and (scripting: none) {\n  .topbar nav, .topbar .user { display: flex; }\n  .nav-toggle { display: none; }\n}");
    expect(noScript).toBeGreaterThan(css.indexOf("@media (max-width: 1240px) {\n  .topbar { flex-wrap: wrap;"));
  });

  it("landscape-phone-zoom: the 16px box rules hold on a phone held sideways too", () => {
    expect(css).toContain("@media (max-width: 720px), (pointer: coarse) { /* a phone held sideways is wider than 720px */\n  input[type=text], input[type=password], input[type=number]");
    expect(css).toContain("@media (max-width: 720px), (pointer: coarse) {\n  .auth-card input, .duration-form input[type=number], .media-bar select { font-size: 16px; }\n}");
    expect(css).not.toMatch(/@media \(max-width: 720px\) \{\n {2}input\[type=text\]/);
  });

  it("light-add-to-label-contrast: the upload box's Add to label reaches 4.5:1 on its tint in both themes", () => {
    const lum = (rgb) => {
      const c = rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16));
    // the label's colour token (the general label rule's muted when .dropzone label sets none)
    const name = /color: var\(--p5k-([a-z-]+)\)/.exec(rule(".dropzone label"))?.[1] ?? "muted";
    const dark = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: light)"));
    const light = css.slice(css.indexOf('html[data-theme="light"] {'));
    for (const theme of [dark, light]) {
      const token = (t) => new RegExp(`--p5k-${t}:\\s*([^;]+);`).exec(theme)[1];
      // .dropzone: the tint over the page ground
      const [tr, tg, tb, ta] = /rgba\(([^)]+)\)/.exec(token("fill-tint"))[1].split(",").map(Number);
      const ground = hex(token("ground")).map((v, i) => v * (1 - ta) + [tr, tg, tb][i] * ta);
      expect(contrast(hex(token(name)), ground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("upload-queue-long-name: an upload row's file name breaks anywhere", () => {
    expect(rule(".upload-queue li")).toContain("overflow-wrap: anywhere;");
  });
});

describe("create-hint-cut-on-phones", () => {
  it("each create box's hint fits a 320px phone's box at 16px", async () => {
    const hints = [];
    for (const [c, path] of [[r.editor, "/settings"], [r.admin, "/users"]]) {
      const page = await (await c.get(path)).text();
      for (const m of page.matchAll(/<div class="row">\s*<input type="text" name="name" placeholder="([^"]*)"/g)) hints.push(m[1]);
    }
    expect(new Set(hints)).toEqual(new Set(["e.g. office laptop", "e.g. a roommate"]));
    // IBM Plex Mono is 0.6em a letter, 9.6px at 16px; at 320px the Users token box has 222px
    for (const h of hints) expect(h.length * 9.6, h).toBeLessThanOrEqual(222);
  });
});

describe("deploy-proceeds-after-declined-migration", () => {
  const files = import.meta.glob(["../package.json", "../scripts/deploy.mjs"], { query: "?raw", import: "default", eager: true });

  it("npm run deploy applies the migrations and deploys only once wrangler lists none left", () => {
    expect(JSON.parse(files["../package.json"]).scripts.deploy).toBe("node scripts/deploy.mjs");
    const js = files["../scripts/deploy.mjs"];
    const at = (s) => {
      const i = js.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    // answering n at wrangler's prompt exits 0 with nothing applied: the list is the check
    expect(at('execSync("npm run migrate:remote"')).toBeLessThan(at("npx wrangler d1 migrations list piplayer-cloud-db --remote"));
    expect(at("npx wrangler d1 migrations list piplayer-cloud-db --remote")).toBeLessThan(at('.includes("No migrations to apply")'));
    expect(at('.includes("No migrations to apply")')).toBeLessThan(at("process.exit(1)"));
    expect(at("process.exit(1)")).toBeLessThan(at('execSync("npx wrangler deploy"'));
  });
});
