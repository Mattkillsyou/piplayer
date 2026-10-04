// /audit: ?limit validated 1..1000 (default 200), ORDER BY created_at DESC, id DESC, the reader's
// zone. Each account reads the rows about itself (audit_log.owner_id, migration 0016) and its own
// actions; an admin also the rows about no account, never another account's.
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { detail, device, ins, post, roleMatrix, roles, setting, XSS } from "./pages_common.js";

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
      await ins("INSERT INTO audit_log (username, action, target_type, target_id, details, ip, created_at, owner_id) VALUES ('t', 'tie', 'x', ?, ?, '1.2.3.4', '2030-01-01 00:00:00', ?)", i, `tie-${i}`, r.ids.editor);
    }
    await ins("INSERT INTO audit_log (username, action, details, owner_id) VALUES (?, 'xss', ?, ?)", XSS + "user", `{"name":"${XSS}"}`, r.ids.editor);
    let page = await (await r.editor.get("/audit?limit=1000")).text();
    const at = (s) => page.indexOf(s);
    expect(at("tie-2")).toBeLessThan(at("tie-1"));
    expect(at("tie-1")).toBeLessThan(at("tie-0"));
    expect(at("tie-0")).toBeLessThan(at("<code>create_playlist</code>")); // the filter select lists it first
    const names = [4, 3, 2, 1, 0].map((i) => at(`audit-${i}`));
    expect(names).toEqual([...names].sort((a, b) => a - b));
    expect(page).not.toContain(XSS);
    expect(page).toContain("x&#39;);alert(1);//user");
    expect(page).toContain("<code>2030-01-01 00:00 UTC</code>");
    expect(page).toContain('<span class="muted small">x</span> 1');
    expect(page).toContain("1.2.3.4");
    expect(page).toContain("times in UTC</span>");
    expect(page).toContain(`<span class="badge badge-editor">editor</span>`);

    page = await (await r.editor.get("/audit?limit=2")).text();
    expect(page).toContain("last 2 entries");
    expect(page).toContain("tail -n 2 audit.log");
    expect(page).toContain("tie-2");
    expect(page).toContain("tie-1");
    expect(page).not.toContain("tie-0");
    expect((page.match(/<tr>/g) || []).length).toBe(3); // header + 2 rows
  });

  it("renders in the reader's own timezone", async () => {
    await setting(r.ids.editor, "timezone", "Asia/Tokyo");
    const page = await (await r.editor.get("/audit")).text();
    expect(page).toContain("<code>2030-01-01 09:00 GMT+9</code>");
    expect(page).toContain("times in GMT+9");
    await query("DELETE FROM account_settings WHERE key = 'timezone'");
  });

  it("each account reads only the rows about itself and its own actions; an admin also the site's rows; the action list is scoped the same way", async () => {
    await ins("INSERT INTO audit_log (username, action, details, owner_id) VALUES ('vw', 'viewer_thing', 'viewer-row', ?)", r.ids.viewer);
    await ins("INSERT INTO audit_log (username, action, details, owner_id) VALUES (NULL, 'site_thing', 'site-row', NULL)");
    const vw = await (await r.viewer.get("/audit?limit=1000")).text();
    expect(vw).toContain("viewer-row");
    for (const other of ["tie-0", "audit-0", "site-row", "<code>create_playlist</code>"]) expect(vw).not.toContain(other);
    expect(vw).not.toContain('<option value="create_playlist"');
    expect(vw).toContain('<option value="viewer_thing"');
    const ed = await (await r.editor.get("/audit?limit=1000")).text();
    for (const other of ["viewer-row", "site-row"]) expect(ed).not.toContain(other);
    expect(ed).not.toContain('<option value="viewer_thing"');
    // a filter or a cursor cannot widen it
    expect(await (await r.editor.get("/audit?action=viewer_thing")).text()).not.toContain("viewer-row");
    // an admin: its own rows and the rows about no account, never another account's
    let ad = await (await r.admin.get("/audit?limit=1000")).text();
    expect(ad).toContain("site-row");
    for (const other of ["viewer-row", "tie-0", "audit-0"]) expect(ad).not.toContain(other);
    expect(ad).toContain('<option value="site_thing"');
    expect(ad).not.toContain('<option value="viewer_thing"');
    // an admin's own action on another account's projector is about that account, and the admin's own
    const dev = await device("audit-dev", "Audit dev");
    expect((await post(r.admin, `/devices/${dev.id}/rename`, { name: "Renamed by admin" })).status).toBe(303);
    for (const c of [r.editor, r.admin]) expect(await (await c.get("/audit?action=device_rename")).text()).toContain(`<span class="muted small">device</span> ${dev.id}`);
    expect(await (await r.viewer.get("/audit?action=device_rename")).text()).toContain("no entries yet");
  });
});
