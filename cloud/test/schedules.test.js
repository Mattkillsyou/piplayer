// Port of the schedule semantics asserted by cms/tests/test_cms_validation.py (contract 16).
import { describe, expect, it } from "vitest";
import * as schedules from "../src/schedules.js";
import { wallClock } from "../src/util.js";

const sm = schedules.schedule_matches;
// Naive local datetime -> wallClock shape (what api/pages hand to the evaluator).
const at = (y, mo, d, h, mi) => wallClock("UTC", new Date(Date.UTC(y, mo - 1, d, h, mi)));

describe("schedule_matches", () => {
  it("anchors a wrap-midnight window to the day it starts", () => {
    // Monday 2026-09-14. Rule: Mon 22:00 -> 02:00
    const rule = { start_time: "22:00", end_time: "02:00", days_of_week: "0" };
    expect(sm(rule, at(2026, 9, 14, 23, 0))).toBe(true);
    expect(sm(rule, at(2026, 9, 15, 1, 0))).toBe(true);
    expect(sm(rule, at(2026, 9, 14, 1, 0))).toBe(false);
    expect(sm(rule, at(2026, 9, 15, 23, 0))).toBe(false);
    const dated = { start_time: "22:00", end_time: "02:00", start_date: "2026-09-14", end_date: "2026-09-14" };
    expect(sm(dated, at(2026, 9, 14, 23, 0))).toBe(true);
    expect(sm(dated, at(2026, 9, 15, 1, 0))).toBe(true);
    expect(sm(dated, at(2026, 9, 16, 1, 0))).toBe(false);
    expect(sm(dated, at(2026, 9, 14, 1, 0))).toBe(false);
    const plain = { start_time: "09:00", end_time: "17:00", days_of_week: "0" };
    expect(sm(plain, at(2026, 9, 14, 12, 0))).toBe(true);
    expect(sm(plain, at(2026, 9, 15, 12, 0))).toBe(false);
    expect(sm(plain, at(2026, 9, 14, 17, 0))).toBe(false); // half-open
  });

  it("handles one-sided windows, unconstrained rows and non-zero-padded times", () => {
    const now = at(2026, 9, 14, 12, 0);
    expect(sm({}, now)).toBe(true);
    expect(sm({ start_time: "7:00" }, now)).toBe(true);
    expect(sm({ start_time: "13:00" }, now)).toBe(false);
    expect(sm({ end_time: "12:00" }, now)).toBe(false);
    expect(sm({ end_time: "12:01" }, now)).toBe(true);
    expect(sm({ start_date: "2026-09-15" }, now)).toBe(false);
    expect(sm({ end_date: "2026-09-13" }, now)).toBe(false);
    expect(sm({ days_of_week: "" }, now)).toBe(true);
  });

  it("treats malformed stored rows as non-matching instead of throwing", () => {
    const now = at(2026, 9, 14, 12, 0);
    for (const bad of [{ start_time: "junk" }, { end_time: "25:99" }, { start_time: "7" },
      { start_time: "07:00:00" }, { start_date: "notadate" }, { days_of_week: "x" },
      { start_time: "", end_time: "abc" }, { days_of_week: 3 }, { start_time: 7 }]) {
      expect(sm(bad, now), JSON.stringify(bad)).toBe(false);
    }
    expect(schedules.pick_active([{ id: 1, priority: 5, start_time: "junk" }], now)).toBeNull();
  });

  it("evaluates in the site timezone", () => {
    // 2026-09-14 23:30 UTC is 16:30 PDT (Monday) but 08:30 Tuesday in Tokyo.
    const instant = new Date(Date.UTC(2026, 9 - 1, 14, 23, 30));
    const rule = { start_time: "16:00", end_time: "17:00", days_of_week: "0" };
    expect(sm(rule, wallClock("America/Los_Angeles", instant))).toBe(true);
    expect(sm(rule, wallClock("Asia/Tokyo", instant))).toBe(false);
    expect(sm({ days_of_week: "1" }, wallClock("Asia/Tokyo", instant))).toBe(true);
  });
});

describe("pick_active", () => {
  it("prefers priority then id", () => {
    const now = at(2026, 9, 14, 12, 0);
    const rules = [
      { id: 1, priority: 5, playlist_id: 1 },
      { id: 2, priority: 9, playlist_id: 2 },
      { id: 3, priority: 9, playlist_id: 3 },
      { id: 4, priority: 99, playlist_id: 4, start_time: "13:00", end_time: "14:00" },
    ];
    expect(schedules.pick_active(rules, now).id).toBe(3);
    expect(schedules.pick_active([], now)).toBeNull();
  });
});

describe("describe", () => {
  it("matches the Python wording", () => {
    expect(schedules.describe({})).toBe("always");
    expect(schedules.describe({ start_time: "22:00", end_time: "02:00", days_of_week: "4" })).toBe("22:00–02:00 · Fri");
    expect(schedules.describe({ end_time: "09:00" })).toBe("00:00–09:00");
    expect(schedules.describe({ days_of_week: "0246x" })).toBe("Mon,Wed,Fri,Sun");
    expect(schedules.describe({ start_date: "2026-01-01", end_date: "2026-01-31" })).toBe("2026-01-01–2026-01-31");
    expect(schedules.describe({ start_date: "2026-01-01" })).toBe("from 2026-01-01");
    expect(schedules.describe({ end_date: "2026-01-31" })).toBe("until 2026-01-31");
  });
});

describe("next_start", () => {
  const ns = schedules.next_start;
  const when = (r) => [r[1].year, r[1].month, r[1].day, r[1].hour, r[1].minute];

  it("skips a matching rule, respects days and expiry", () => {
    const now = at(2026, 9, 15, 14, 0); // a Tuesday
    const rules = [
      { id: 1, name: "now", start_time: "13:00", end_time: "18:00" }, // already active
      { id: 2, name: "weekend", start_time: "10:00", end_time: "16:00", days_of_week: "56" },
      { id: 3, name: "tonight", start_time: "22:00", end_time: "02:00" },
      { id: 4, name: "expired", start_time: "15:00", end_time: "16:00", end_date: "2026-09-01" },
    ];
    let r = ns(rules, now);
    expect(r[0].name).toBe("tonight");
    expect(when(r)).toEqual([2026, 9, 15, 22, 0]);
    r = ns([rules[1]], now);
    expect(r[0].name).toBe("weekend");
    expect(when(r)).toEqual([2026, 9, 19, 10, 0]);
    // an active rule counts again at its next start; an expired one never
    r = ns([rules[0], rules[3]], now);
    expect(r[0].name).toBe("now");
    expect(when(r)).toEqual([2026, 9, 16, 13, 0]);
    expect(ns([rules[3]], now)).toBeNull();
    // a bad row is skipped, never thrown on
    expect(ns([{ id: 5, name: "bad", start_time: "junk" }, { id: 6, name: "bad2", start_time: 7 }], now)).toBeNull();
  });

  it("skips rules a higher-priority rule covers", () => {
    const now = at(2026, 9, 15, 14, 0);
    const always = { id: 1, name: "all day", priority: 10, start_time: "08:00", end_time: "20:00" };
    const shadowed = { id: 2, name: "shadowed", priority: 1, start_time: "15:00", end_time: "16:00" };
    const winner = { id: 3, name: "evening", priority: 20, start_time: "17:00", end_time: "18:00" };
    const r = ns([always, shadowed, winner], now);
    expect(r[0].name).toBe("evening");
    expect(when(r)).toEqual([2026, 9, 15, 17, 0]);
    expect(when(ns([winner], now))).toEqual([2026, 9, 15, 17, 0]);
    expect(schedules.nextStart).toBe(ns);
  });
});
