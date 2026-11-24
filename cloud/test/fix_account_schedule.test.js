// Schedule page fixes (account track). Save rule changes the projector's own rule only, and Also
// add to is on the Add form only: ticking a projector that held a copy from the Edit form added a
// second rule there, so that projector kept playing the old times beside the new ones.
import { beforeAll, describe, expect, it } from "vitest";
import { query } from "./helpers.js";
import { audits, device, playlist, post, roles } from "./pages_common.js";

let r;
const w = {};
const base = (d) => `/devices/${d.id}/schedule`;
const rulesOf = (d) => query("SELECT name, start_time, end_time, days_of_week FROM device_schedules WHERE device_id = ? ORDER BY id", d.id);
// A form body with repeated keys (ticked boxes), as a browser sends it.
const form = (fields, ...pairs) => [...Object.entries(fields), ...pairs];

beforeAll(async () => {
  r = await roles();
  w.pl = await playlist("Matinee loop");
  w.left = await device("stage-left", "Stage Left");
  w.right = await device("stage-right", "Stage Right");
  w.lobby = await device("lobby", "Lobby");
});

describe("Save rule", () => {
  it("changes this projector's rule only: the Edit form has no Also add to, and a projector ticked anyway gets no second rule", async () => {
    const matinee = { name: "Matinee", playlist_id: String(w.pl), start_time: "13:00", end_time: "17:00" };
    let res = await post(r.editor, base(w.left), form(matinee, ["days_of_week_chk", "5"], ["also", String(w.right.id)]));
    expect(res.status).toBe(303);
    const [{ id }] = await query("SELECT id FROM device_schedules WHERE device_id = ?", w.left.id);
    expect(await (await r.editor.get(base(w.left))).text()).toContain('name="also"'); // the Add form keeps it
    const edit = await (await r.editor.get(`${base(w.left)}?edit=${id}`)).text();
    expect(edit).toContain("<h2>Edit rule</h2>");
    expect(edit).not.toContain('name="also"');
    expect(edit).not.toContain("Also add to");
    // a page from before this fix (or a script) still sends Also add to with Save rule
    res = await post(r.editor, `${base(w.left)}/${id}`, form({ ...matinee, start_time: "14:00" },
      ["days_of_week_chk", "5"], ["also", String(w.right.id)], ["also", String(w.lobby.id)]));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(base(w.left));
    expect(await rulesOf(w.left)).toEqual([{ name: "Matinee", start_time: "14:00", end_time: "17:00", days_of_week: "5" }]);
    expect(await rulesOf(w.right)).toEqual([{ name: "Matinee", start_time: "13:00", end_time: "17:00", days_of_week: "5" }]);
    expect(await rulesOf(w.lobby)).toEqual([]);
    expect((await audits("device_schedule_create")).length).toBe(2); // the rule and its one copy, both from Add rule
    expect((await audits("device_schedule_update")).map((a) => a.target_id)).toEqual([String(id)]);
    // and no notice claims a copy was added
    expect(await (await r.editor.get(base(w.left))).text()).not.toContain('role="alert"');
  });
});

describe("the page", () => {
  it("goes back to its projector's card on the Devices page, not to the top of the list", async () => {
    for (const c of [r.editor, r.admin]) { // the admin reads another account's projector here
      expect(await (await c.get(base(w.right))).text()).toContain(`<a href="/devices#device-${w.right.id}" class="back">← Devices</a>`);
    }
    expect(await (await r.editor.get("/devices")).text()).toContain(`id="device-${w.right.id}"`);
  });
});
