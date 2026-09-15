// Port of cms/app/schedules.py (same function names). Library module, no routes.
//
// Schedule evaluation: pick the active playlist for a device given "now".
//
// Rules:
// - All schedules for the device that match "now" are candidates.
// - A schedule matches if: (start_date <= day <= end_date) AND
//                         (day.weekday() in days_of_week) AND
//                         (now_time is in [start_time, end_time))
//   Any field that is NULL is unconstrained.
// - Among candidates, the one with the highest priority wins (ties: highest id).
// - If no schedule matches, the device's fallback playlist_id (or its group's) is used.
//
// Time semantics:
// - start_time/end_time are wall-clock time in the SITE timezone (settings), "HH:MM".
//   `now` is a util.wallClock() object: {year, month, day, hour, minute, second, weekday}
//   with weekday 0=Mon..6=Sun, exactly like Python's datetime.weekday().
// - If end_time < start_time, the window wraps midnight (e.g., 22:00-02:00). Such a window
//   is anchored to the day it STARTS: after midnight (now < end_time) the days_of_week and
//   start_date/end_date constraints are checked against the previous calendar day, so
//   "Fri 22:00-02:00" runs until Saturday 02:00.
// - start_time == end_time is rejected at create time; leave both empty for all day.
// - A row whose stored values cannot be parsed is logged once and treated as never matching,
//   so one bad row can never break the devices page or a device's sync.
import { isoDate, normalizeHhmm } from "./util.js";

export const WEEKDAY_CODES = "0123456"; // 0 = Mon, 6 = Sun

const badRowsLogged = new Set();

export const normalize_hhmm = normalizeHhmm;

class BadRow extends Error {}

// 'HH:MM' -> minutes since midnight; anything normalize_hhmm rejects is a bad row.
function parseHhmm(s) {
  const norm = normalizeHhmm(s);
  if (norm === null) throw new BadRow(`not HH:MM: ${JSON.stringify(s)}`);
  return parseInt(norm.slice(0, 2), 10) * 60 + parseInt(norm.slice(3), 10);
}

function parseDate(s) {
  const d = isoDate(s);
  if (d === null) throw new BadRow(`not YYYY-MM-DD: ${JSON.stringify(s)}`);
  return d;
}

const pad2 = (n) => String(n).padStart(2, "0");

// Calendar date + weekday of the wall-clock `now`, shifted by `days`.
function dayOf(now, days = 0) {
  const d = new Date(Date.UTC(now.year, now.month - 1, now.day) + days * 86400000);
  return {
    date: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    weekday: (d.getUTCDay() + 6) % 7,
  };
}

function inTimeWindow(nowMin, start, end) {
  if (start === null && end === null) return true;
  if (start !== null && end === null) return nowMin >= start;
  if (start === null && end !== null) return nowMin < end;
  if (start <= end) return start <= nowMin && nowMin < end;
  // wraps midnight
  return nowMin >= start || nowMin < end;
}

function scheduleMatchesStrict(schedule, now) {
  const startT = schedule.start_time ? parseHhmm(schedule.start_time) : null;
  const endT = schedule.end_time ? parseHhmm(schedule.end_time) : null;
  const startD = schedule.start_date ? parseDate(schedule.start_date) : null;
  const endD = schedule.end_date ? parseDate(schedule.end_date) : null;
  const nowMin = now.hour * 60 + now.minute;

  // A wrap-midnight window is anchored to the day it started: in its after-midnight
  // tail, evaluate the day/date constraints against yesterday.
  const anchor = (startT !== null && endT !== null && endT <= startT && nowMin < endT) ? dayOf(now, -1) : dayOf(now);

  if (startD && anchor.date < startD) return false;
  if (endD && anchor.date > endD) return false;

  const days = schedule.days_of_week;
  if (days) {
    if (typeof days !== "string") throw new BadRow("days_of_week is not a string");
    if (!days.includes(String(anchor.weekday))) return false;
  }
  return inTimeWindow(nowMin, startT, endT);
}

export function schedule_matches(schedule, now) {
  try {
    return scheduleMatchesStrict(schedule, now);
  } catch (e) {
    if (!(e instanceof BadRow) && !(e instanceof TypeError)) throw e;
    const key = schedule.id;
    if (!badRowsLogged.has(key)) {
      badRowsLogged.add(key);
      console.error(`schedule rule ${key} (${JSON.stringify(schedule.name ?? null)}) has an unparsable value and is ignored: ${e.message}`);
    }
    return false;
  }
}

export function pick_active(schedules, now) {
  const matching = Array.from(schedules).filter((s) => schedule_matches(s, now));
  if (!matching.length) return null;
  matching.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (b.id ?? 0) - (a.id ?? 0));
  return matching[0];
}

// A wallClock-shaped object (no zone) for a naive local minute given as a UTC-epoch ms
// value built with Date.UTC(year, month - 1, day, hour, minute).
function wallFromMs(ms) {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: 0, weekday: (d.getUTCDay() + 6) % 7,
  };
}

// Port of next_start: the rule that will start matching soonest after `now` (a
// util.wallClock() object), as [rule, wallClockOfThatMinute], or null when nothing starts
// within the horizon. A rule that already matches is not a future start; a rule a
// higher-priority rule covers at that minute would not play, so it is skipped too.
export function next_start(rules, now, horizonDays = 7) {
  const list = Array.from(rules);
  const baseMs = Date.UTC(now.year, now.month - 1, now.day, now.hour, now.minute);
  let best = null;
  for (const s of list) {
    let startMin;
    try {
      startMin = s.start_time ? parseHhmm(s.start_time) : 0;
    } catch {
      continue;
    }
    for (let offset = 0; offset <= horizonDays; offset++) {
      const ms = Date.UTC(now.year, now.month - 1, now.day + offset, Math.floor(startMin / 60), startMin % 60);
      if (ms <= baseMs) continue;
      const candidate = wallFromMs(ms);
      if (!schedule_matches(s, candidate)) continue;
      if (pick_active(list, candidate) !== s) continue;
      if (best === null || ms < best[2]) best = [s, candidate, ms];
      break;
    }
  }
  return best ? [best[0], best[1]] : null;
}

// Human-readable summary of a schedule row, for the UI.
export function describe(schedule) {
  const parts = [];
  if (schedule.start_time || schedule.end_time) {
    parts.push(`${schedule.start_time || "00:00"}–${schedule.end_time || "24:00"}`);
  }
  if (schedule.days_of_week) {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const days = Array.from(String(schedule.days_of_week)).filter((c) => WEEKDAY_CODES.includes(c)).map((c) => names[+c]);
    parts.push(days.join(","));
  }
  if (schedule.start_date && schedule.end_date) parts.push(`${schedule.start_date}–${schedule.end_date}`);
  else if (schedule.start_date) parts.push(`from ${schedule.start_date}`);
  else if (schedule.end_date) parts.push(`until ${schedule.end_date}`);
  return parts.length ? parts.join(" · ") : "always";
}

// camelCase aliases for callers that prefer them.
export const scheduleMatches = schedule_matches;
export const pickActive = pick_active;
export const nextStart = next_start;

export function register(router) {
  void router; // library module: nothing to register
}
