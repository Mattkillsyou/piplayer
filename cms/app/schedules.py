"""Schedule evaluation: pick the active playlist for a device given current time.

Rules:
- All schedules for the device that match "now" are candidates.
- A schedule matches if: (start_date <= day <= end_date) AND
                        (day.weekday() in days_of_week) AND
                        (now_time is in [start_time, end_time))
  Any field that is NULL is unconstrained.
- Among candidates, the one with the highest priority wins (ties: most recent).
- If no schedule matches, the device's fallback playlist_id (or its group's) is used.

Time semantics:
- start_time/end_time are the controller's local wall-clock time, "HH:MM".
- If end_time < start_time, the window wraps midnight (e.g., 22:00–02:00). Such a window
  is anchored to the day it STARTS: after midnight (now < end_time) the days_of_week and
  start_date/end_date constraints are checked against the previous calendar day, so
  "Fri 22:00–02:00" runs until Saturday 02:00.
- start_time == end_time is rejected at create time; leave both empty for all day.
- A row whose stored values cannot be parsed is logged once and treated as never matching,
  so one bad row can never break the devices page or a device's sync.
"""
import datetime as dt
import logging
import re
from typing import Iterable


log = logging.getLogger("piplayer.schedules")

WEEKDAY_CODES = "0123456"  # 0 = Mon, 6 = Sun  (matches Python datetime.weekday())

_bad_rows_logged: set = set()


def normalize_hhmm(value: str) -> str | None:
    """Return zero-padded 'HH:MM' for a valid time string, or None if it is not one.

    Accepts '7:05' as well as '07:05' (both become '07:05'); rejects seconds, 24:00, etc."""
    value = value.strip()
    m = re.match(r"^(\d{1,2}):(\d{2})$", value)
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 23 or mi > 59:
        return None
    return f"{h:02d}:{mi:02d}"


def _parse_hhmm(s: str) -> dt.time:
    # Rows written by older versions may be non-zero-padded ('7:05'); normalize_hhmm accepts
    # those and rejects everything else, so evaluation stays as strict as create-time validation.
    norm = normalize_hhmm(s)
    if norm is None:
        raise ValueError(f"not HH:MM: {s!r}")
    h, m = norm.split(":")
    return dt.time(int(h), int(m))


def _parse_date(s: str) -> dt.date:
    return dt.date.fromisoformat(s.strip())


def _in_time_window(now: dt.time, start: dt.time | None, end: dt.time | None) -> bool:
    if start is None and end is None:
        return True
    if start is not None and end is None:
        return now >= start
    if start is None and end is not None:
        return now < end
    assert start is not None and end is not None
    if start <= end:
        return start <= now < end
    # wraps midnight
    return now >= start or now < end


def _schedule_matches(schedule: dict, now: dt.datetime) -> bool:
    start_t = _parse_hhmm(schedule["start_time"]) if schedule.get("start_time") else None
    end_t = _parse_hhmm(schedule["end_time"]) if schedule.get("end_time") else None
    start_d = _parse_date(schedule["start_date"]) if schedule.get("start_date") else None
    end_d = _parse_date(schedule["end_date"]) if schedule.get("end_date") else None

    # A wrap-midnight window is anchored to the day it started: in its after-midnight
    # tail, evaluate the day/date constraints against yesterday.
    anchor = now
    if start_t is not None and end_t is not None and end_t <= start_t and now.time() < end_t:
        anchor = now - dt.timedelta(days=1)

    day = anchor.date()
    if start_d and day < start_d:
        return False
    if end_d and day > end_d:
        return False

    days = schedule.get("days_of_week")
    if days:
        if str(anchor.weekday()) not in days:
            return False

    return _in_time_window(now.time(), start_t, end_t)


def schedule_matches(schedule: dict, now: dt.datetime) -> bool:
    try:
        return _schedule_matches(schedule, now)
    except (ValueError, TypeError, AttributeError) as e:
        key = schedule.get("id")
        if key not in _bad_rows_logged:
            _bad_rows_logged.add(key)
            log.error("schedule rule %s (%r) has an unparsable value and is ignored: %s",
                      key, schedule.get("name"), e)
        return False


def pick_active(schedules: Iterable[dict], now: dt.datetime) -> dict | None:
    matching = [s for s in schedules if schedule_matches(s, now)]
    if not matching:
        return None
    matching.sort(key=lambda s: (s.get("priority", 0), s.get("id", 0)), reverse=True)
    return matching[0]


def describe(schedule: dict) -> str:
    """Human-readable summary of a schedule row, for the UI."""
    parts: list[str] = []
    if schedule.get("start_time") or schedule.get("end_time"):
        parts.append(f"{schedule.get('start_time') or '00:00'}–{schedule.get('end_time') or '24:00'}")
    if schedule.get("days_of_week"):
        names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        days = [names[int(c)] for c in schedule["days_of_week"] if c in WEEKDAY_CODES]
        parts.append(",".join(days))
    if schedule.get("start_date") and schedule.get("end_date"):
        parts.append(f"{schedule['start_date']}–{schedule['end_date']}")
    elif schedule.get("start_date"):
        parts.append(f"from {schedule['start_date']}")
    elif schedule.get("end_date"):
        parts.append(f"until {schedule['end_date']}")
    return " · ".join(parts) if parts else "always"
