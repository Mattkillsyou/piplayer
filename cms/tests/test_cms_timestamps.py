"""Contract 14: UTC in the DB, local time with zone in templates, server_time with offset."""
import datetime as dt
import re

from cms_helpers import bearer, create_device, one, sync


def _local_filter(cms):
    candidates = [getattr(cms.web_routes, "templates", None), getattr(cms.app.state, "templates", None),
                  getattr(cms.main, "templates", None)]
    for t in candidates:
        env = getattr(t, "env", None)
        if env is not None and "local" in env.filters:
            return env.filters["local"]
    raise AssertionError("Jinja filter 'local' is not registered on the templates environment")


def test_local_filter_renders_utc_db_timestamps_in_server_local_zone(cms):
    local = _local_filter(cms)
    utc_str = "2026-01-05 12:00:00"  # exactly what sqlite datetime('now') writes
    expected_dt = dt.datetime(2026, 1, 5, 12, 0, tzinfo=dt.timezone.utc).astimezone()
    out = local(utc_str)
    assert isinstance(out, str)
    assert out.startswith(expected_dt.strftime("%Y-%m-%d %H:%M")), out
    assert expected_dt.tzname() in out, f"zone name missing: {out!r}"
    assert re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S", out), out
    # summer date too (DST-aware)
    expected_summer = dt.datetime(2026, 7, 5, 12, 0, tzinfo=dt.timezone.utc).astimezone()
    out = local("2026-07-05 12:00:00")
    assert out.startswith(expected_summer.strftime("%Y-%m-%d %H:%M")), out


def test_local_filter_tolerates_empty_and_junk(cms):
    local = _local_filter(cms)
    for v in (None, "", "junk"):
        out = local(v)
        assert isinstance(out, str)


def test_db_timestamps_stay_utc(admin, client, tok):
    dev = create_device(admin, f"ts-{tok}")
    before = dt.datetime.now(dt.timezone.utc).replace(microsecond=0) - dt.timedelta(seconds=5)
    sync(client, dev)
    row = one("SELECT last_seen_at FROM devices WHERE id = ?", (dev["id"],))
    seen = dt.datetime.strptime(row["last_seen_at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)
    after = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=5)
    assert before <= seen <= after, f"last_seen_at is not UTC: {row['last_seen_at']}"


def test_pages_render_last_seen_in_local_time(admin, client, tok):
    dev = create_device(admin, f"ts2-{tok}", f"TS Dev {tok}")
    sync(client, dev)
    row = one("SELECT last_seen_at FROM devices WHERE id = ?", (dev["id"],))
    utc = dt.datetime.strptime(row["last_seen_at"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)
    local = utc.astimezone()
    for page in ("/dashboard", "/devices"):
        html = admin.get(page).text
        assert local.strftime("%Y-%m-%d %H:%M") in html, f"{page} does not show last_seen in local time"
        assert local.tzname() in html, f"{page} does not label the zone"


def test_manifest_server_time_carries_utc_offset(admin, client, tok):
    dev = create_device(admin, f"ts3-{tok}")
    r = sync(client, dev)
    server_time = r.json()["server_time"]
    parsed = dt.datetime.fromisoformat(server_time)
    assert parsed.tzinfo is not None and parsed.utcoffset() is not None, server_time
    assert parsed.utcoffset() == dt.datetime.now().astimezone().utcoffset()
    assert abs((parsed - dt.datetime.now().astimezone()).total_seconds()) < 60


def test_schedule_page_names_zone_and_explains_local_time(admin, tok):
    dev = create_device(admin, f"ts4-{tok}")
    html = admin.get(f"/devices/{dev['id']}/schedule").text
    assert dt.datetime.now().astimezone().tzname() in html, "schedule page does not show the zone name"
    assert re.search(r"controller'?s? local(\s+\S+)? time", html, re.I), "no note that rules use the controller's local time"
