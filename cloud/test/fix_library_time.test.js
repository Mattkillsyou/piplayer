// localTime keeps its answer per zone and UTC minute (the Library formats a time per card, and
// formatToParts was about a third of its render), and the answers stay those of formatToParts
// across offset changes, those off the quarter hour included.
import { afterEach, describe, expect, it, vi } from "vitest";
import { localTime, nowUtc, wallClock } from "../src/util.js";

const pad2 = (n) => String(n).padStart(2, "0");
// What localTime answered before it kept anything: formatToParts every time.
const fresh = (ms, tz) => {
  const w = wallClock(tz, new Date(ms));
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)} ${pad2(w.hour)}:${pad2(w.minute)} ${w.zone}`;
};

afterEach(() => vi.restoreAllMocks());

describe("localTime", () => {
  it("formats one minute of one zone once, however many rows show it", () => {
    const base = Date.UTC(2026, 10, 17, 9, 51, 0);
    const want = fresh(base, "Australia/Adelaide");
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    const said = new Set();
    for (let i = 0; i < 60; i++) said.add(localTime(nowUtc(new Date(base + i * 1000)), "Australia/Adelaide"));
    expect([...said]).toEqual([want]);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("answers as formatToParts does around offset changes, on and off the quarter hour, zone by zone", () => {
    const changes = [
      ["Antarctica/Casey", Date.UTC(2021, 9, 2, 16, 1)], // +8 to +11 at 16:01 UTC
      ["America/St_Johns", Date.UTC(2010, 2, 14, 3, 31)], // at 03:31 UTC
      ["America/St_Johns", Date.UTC(2026, 10, 1, 4, 30)],
      ["Australia/Lord_Howe", Date.UTC(2026, 9, 3, 15, 30)], // half an hour forward
      ["Australia/Adelaide", Date.UTC(2026, 9, 3, 16, 30)],
      ["Pacific/Chatham", Date.UTC(2026, 8, 26, 14, 0)],
      ["America/Los_Angeles", Date.UTC(2026, 2, 8, 10, 0)],
      ["America/Los_Angeles", Date.UTC(2026, 10, 1, 9, 0)],
      ["Asia/Kathmandu", Date.UTC(2026, 10, 1, 9, 0)],
      ["UTC", Date.UTC(2026, 10, 1, 9, 0)],
    ];
    for (const [tz, at] of changes) {
      const steps = Array.from({ length: 19 }, (_, i) => at - 180000 + i * 20000);
      for (const t of [...steps, ...steps.reverse()]) {
        expect(localTime(nowUtc(new Date(t)), tz), `${tz} ${new Date(t).toISOString()}`).toBe(fresh(t, tz));
      }
    }
    // the same minute in two zones
    const t = Date.UTC(2026, 10, 17, 9, 51, 30);
    expect(localTime(nowUtc(new Date(t)), "UTC")).toBe("2026-11-17 09:51 UTC");
    expect(localTime(nowUtc(new Date(t)), "America/Los_Angeles")).toBe("2026-11-17 01:51 PST");
    expect(localTime(nowUtc(new Date(t)), "UTC")).toBe("2026-11-17 09:51 UTC");
  });

  it("still gives back what it cannot read, and nothing for nothing", () => {
    expect(localTime("not a time", "UTC")).toBe("not a time");
    expect(localTime(null, "UTC")).toBe("");
    expect(localTime("2026-11-17 09:51:07.5", "UTC")).toBe("2026-11-17 09:51 UTC");
  });
});
