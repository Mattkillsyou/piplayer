// /audit: ?limit validated 1..1000 (default 200), ORDER BY created_at DESC, id DESC, site zone.
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { detail, ins, post, roleMatrix, roles, XSS } from "./pages_common.js";

let r;

beforeAll(async () => {
  r = await roles();
});

describe("audit page", () => {
  it("every role may read it; limit is validated", async () => {
    await roleMatrix(r, "GET", "/audit");
    for (const bad of ["0", "5000", "abc", "-1", "1.5"]) {
      expect(await detail(await r.viewer.get(`/audit?limit=${bad}`), 400), bad).toContain("limit");
    }
    expect((await r.viewer.get("/audit?limit=1")).status).toBe(200);
    expect((await r.viewer.get("/audit?limit=1000")).status).toBe(200);
    expect((await r.viewer.get("/audit?limit=")).status).toBe(200);
  });

  it("newest first with id as the tie-break inside one second; limit applied; details escaped", async () => {
    await query("DELETE FROM audit_log");
    for (let i = 0; i < 5; i++) {
      expect((await post(r.editor, "/playlists", { name: `audit-${i}` })).status).toBe(303);
    }
    // three rows sharing one created_at, ids ascending: the page must still show 2, 1, 0
    for (let i = 0; i < 3; i++) {
      await ins("INSERT INTO audit_log (username, action, target_type, target_id, details, ip, created_at) VALUES ('t', 'tie', 'x', ?, ?, '1.2.3.4', '2030-01-01 00:00:00')", i, `tie-${i}`);
    }
    await ins("INSERT INTO audit_log (username, action, details) VALUES (?, 'xss', ?)", XSS + "user", `{"name":"${XSS}"}`);
    let page = await (await r.viewer.get("/audit?limit=1000")).text();
    const at = (s) => page.indexOf(s);
    expect(at("tie-2")).toBeLessThan(at("tie-1"));
    expect(at("tie-1")).toBeLessThan(at("tie-0"));
    expect(at("tie-0")).toBeLessThan(at("create_playlist"));
    const names = [4, 3, 2, 1, 0].map((i) => at(`audit-${i}`));
    expect(names).toEqual([...names].sort((a, b) => a - b));
    expect(page).not.toContain(XSS);
    expect(page).toContain("x&#39;);alert(1);//user");
    expect(page).toContain("<code>2030-01-01 00:00 UTC</code>");
    expect(page).toContain('<span class="muted small">x</span> 1');
    expect(page).toContain("1.2.3.4");
    expect(page).toContain("Times are shown in the site's zone (UTC)");
    expect(page).toContain(`<span class="badge badge-viewer">viewer</span>`);

    page = await (await r.viewer.get("/audit?limit=2")).text();
    expect(page).toContain("Last 2 entries.");
    expect(page).toContain("tie-2");
    expect(page).toContain("tie-1");
    expect(page).not.toContain("tie-0");
    expect((page.match(/<tr>/g) || []).length).toBe(3); // header + 2 rows
  });

  it("renders in the site timezone", async () => {
    await query("INSERT INTO settings (key, value) VALUES ('timezone', 'Asia/Tokyo')");
    const page = await (await r.viewer.get("/audit")).text();
    expect(page).toContain("<code>2030-01-01 09:00 GMT+9</code>");
    expect(page).toContain("zone (GMT+9)");
    await query("DELETE FROM settings");
  });
});
