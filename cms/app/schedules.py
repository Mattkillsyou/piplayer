"""Schedule evaluation: pick the active playlist for a device given current time.

Rules:
- All schedules for the device that match "now" are candidates.
- A schedule matches if: (start_date <= today <= end_date) AND
                        (today.weekday() in days_of_week) AND
                        (now_time is in [start_time, end_time))
  Any field that is NULL is unconstrained.
- Among candidates, the one with the highest priority wins (ties: most recent).
- If no schedule matches, the device's fallback playlist_id (or its group's) is used.

Time semantics:
- start_time/end_time are local server time, "HH:MM".
- If end_time <= start_time, the window wraps midnight (e.g., 22:00–02:00).
"""
import datetime as dt
from typing import Iterable


WEEKDAY_CODES = "0123456"  # 0 = Mon, 6 = Sun  (matches Python datetime.weekday())


def _parse_hhmm(s: str) -> dt.time:
    h, m = s.split(":")
    return dt.time(int(h), int(m))


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


def schedule_matches(schedule: dict, now: dt.datetime) -> bool:
    today_str = now.date().isoformat()
    if schedule.get("start_date") and today_str < schedule["start_date"]:
        return False
    if schedule.get("end_date") and today_str > schedule["end_date"]:
        return False

    days = schedule.get("days_of_week")
    if days:
        wd_code = str(now.weekday())
        if wd_code not in days:
            return False

    start_t = _parse_hhmm(schedule["start_time"]) if schedule.get("start_time") else None
    end_t = _parse_hhmm(schedule["end_time"]) if schedule.get("end_time") else None
    return _in_time_window(now.time(), start_t, end_t)


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
