"""Alerts e2e (feature F) against `wrangler dev --local --test-scheduled` (local D1): the
*/5 cron opens an alert for a device that stopped syncing, the pages show it, a sync closes
it, and the Settings channel form + Send test buttons answer with banners, never a 500.

Usage: python e2e/run_alerts_e2e.py [--port 9100] [--persist-to DIR]

What it asserts, in order:
  1. admin created through /setup; POST /settings/alerts validates (400 for http webhook /
     bad address) and stores the thresholds + a webhook URL (only that channel: the digests
     below go to an unreachable https host and nowhere else).
  2. a device whose last sync is 20 minutes old: GET /__scheduled?cron=*/5 * * * * opens one
     `offline` alert (dedupe: a second run adds nothing), audit alert_opened, /alerts lists it,
     the dashboard card counts 1; the daily cron leaves alerts alone.
  3. the device syncs again -> the next cron run closes it (audit alert_closed), /alerts shows
     it under recovered, the dashboard says all clear; the webhook send failed (unreachable
     host) and was audited as alert_notify_failed, not retried.
  4. Send test: unknown channel 400; email without an address -> test_error banner; the
     webhook against an unreachable https host -> test_error banner; audit alert_test_sent.
  5. the Twilio fields land in `secrets` encrypted (never the plaintext, never on the page),
     the audit row says "set", the SMS test button is enabled; Clear Twilio empties them.
"""
import argparse
import os
import shutil
import sys
import tempfile
import urllib.parse

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import e2e_common as ec  # noqa: E402

ALERT_CRON = "*/5 * * * *"
DAILY_CRON = "0 3 * * *"
WEBHOOK = "https://alerts-e2e.invalid/hook"
GOOD = {"alert_offline_minutes": "10", "alert_repeat_minutes": "60", "alert_email": "", "alert_webhook_url": WEBHOOK}


def audit_count(persist, action):
    return ec.d1_one(persist, "SELECT COUNT(*) AS n FROM audit_log WHERE action = %s" % ec.sql_str(action))["n"]


def cron(base, expr):
    r = requests.get(base + "/__scheduled", params={"cron": expr}, timeout=60)
    assert r.status_code == 200, (r.status_code, r.text[:300])


def alerts(persist):
    return ec.d1(persist, "SELECT device_id, kind, closed_at, notified_at FROM alerts ORDER BY id")


def run(base, persist):
    admin = ec.Admin(base)
    admin.setup_admin()

    # 1. channel settings
    r = admin.post("/settings/alerts", {**GOOD, "alert_webhook_url": "http://plain.example.com/x"})
    assert r.status_code == 400, (r.status_code, r.text[:200])
    r = admin.post("/settings/alerts", {**GOOD, "alert_email": "nope"})
    assert r.status_code == 400, (r.status_code, r.text[:200])
    r = admin.post("/settings/alerts", GOOD)
    assert (r.status_code, r.headers.get("location")) == (303, "/settings?saved=1"), (r.status_code, r.text[:300])
    rows = {x["key"]: x["value"] for x in ec.d1(persist, "SELECT key, value FROM settings WHERE key LIKE 'alert_%'")}
    assert rows == {"alert_offline_minutes": "10", "alert_repeat_minutes": "60", "alert_webhook_url": WEBHOOK}, rows
    page = admin.get("/settings").text
    assert 'class="small">Send test webhook</button>' in page, "webhook test button enabled"
    assert 'class="small" disabled>Send test email</button>' in page and 'class="small" disabled>Send test sms</button>' in page
    print("1: alert settings validated and stored (webhook channel only)")

    # 2. an offline device -> the cron opens one alert
    ec.d1(persist, "INSERT INTO devices (device_id, name, token, last_seen_at, player_status) VALUES ('pi-a', 'Lobby', 'tok-a', datetime('now', '-20 minutes'), 'playing')")
    cron(base, DAILY_CRON)
    assert alerts(persist) == [], "the daily cron must not evaluate alerts"
    cron(base, ALERT_CRON)
    rows = alerts(persist)
    assert len(rows) == 1 and rows[0]["kind"] == "offline" and rows[0]["closed_at"] is None, rows
    cron(base, ALERT_CRON)
    assert len(alerts(persist)) == 1, "dedupe: one open row per device and kind"
    assert audit_count(persist, "alert_opened") == 1
    page = admin.get("/alerts").text
    assert "<strong>1 open</strong>" in page and 'Lobby <code class="muted small">pi-a</code>' in page and "offline (no sync)" in page, page[:500]
    dash = admin.get("/dashboard").text
    assert '<a class="card" href="/alerts" id="alerts-card">' in dash and '<span class="badge badge-stale">1 open</span>' in dash
    # the webhook host does not resolve: audited once, notified_at stamped, no retry on the next run
    assert audit_count(persist, "alert_notify_failed") == 1, "one failed webhook send audited"
    assert rows[0]["notified_at"] is not None
    print("2: cron opened one offline alert; pages show it; unreachable webhook audited once")

    # 3. the device syncs -> recovered
    r = requests.get(base + "/api/sync/pi-a", headers={"authorization": "Bearer tok-a"}, timeout=30)
    assert r.status_code == 200, (r.status_code, r.text[:200])
    cron(base, ALERT_CRON)
    rows = alerts(persist)
    assert len(rows) == 1 and rows[0]["closed_at"] is not None, rows
    assert audit_count(persist, "alert_closed") == 1
    assert audit_count(persist, "alert_notify_failed") == 2, "the recovery digest failed to send too (unreachable host)"
    page = admin.get("/alerts").text
    assert "<strong>0 open</strong>" in page and "Recently recovered · 1" in page, page[:500]
    assert "all clear · checked every 5 min" in admin.get("/dashboard").text
    print("3: sync recovered the alert; /alerts and the dashboard agree")

    # 4. Send test
    r = admin.post("/settings/alerts/test", {"channel": "pigeon"})
    assert r.status_code == 400, (r.status_code, r.text[:200])
    r = admin.post("/settings/alerts/test", {"channel": "email"})
    assert r.status_code == 303 and r.headers["location"].startswith("/settings?test_error="), (r.status_code, r.headers.get("location"))
    assert "no alert email address set" in urllib.parse.unquote(r.headers["location"])
    r = admin.post("/settings/alerts/test", {"channel": "webhook"})
    assert r.status_code == 303 and r.headers["location"].startswith("/settings?test_error=webhook"), (r.status_code, r.headers.get("location"))
    page = admin.get(r.headers["location"]).text
    assert "Test alert failed: webhook:" in page, page[:500]
    assert audit_count(persist, "alert_test_sent") == 2
    print("4: Send test answers with banners (400 for an unknown channel), audited")

    # 5. Twilio credentials: encrypted at rest, never echoed, cleared
    r = admin.post("/settings/alerts", {**GOOD, "twilio_account_sid": "ACe2e", "twilio_auth_token": "tok-e2e", "twilio_from": "+15550001", "twilio_to": "+15550002"})
    assert (r.status_code, r.headers.get("location")) == (303, "/settings?saved=1"), (r.status_code, r.text[:300])
    sec = ec.d1(persist, "SELECT name, value FROM secrets ORDER BY name")
    assert [x["name"] for x in sec] == ["twilio_account_sid", "twilio_auth_token", "twilio_from", "twilio_to"], sec
    assert all(x["value"].startswith("v1:") and "tok-e2e" not in x["value"] for x in sec), sec
    a = ec.d1(persist, "SELECT details FROM audit_log WHERE action = 'alert_settings_update' ORDER BY id DESC LIMIT 1")[0]
    assert '"twilio_auth_token": "set"' in a["details"] and "tok-e2e" not in a["details"], a
    page = admin.get("/settings").text
    assert "tok-e2e" not in page and "ACe2e" not in page
    assert 'class="small">Send test sms</button>' in page and "Clear Twilio" in page
    r = admin.post("/settings/alerts/twilio/clear")
    assert r.status_code == 303, (r.status_code, r.text[:200])
    assert ec.d1(persist, "SELECT name FROM secrets") == []
    assert "Clear Twilio" not in admin.get("/settings").text
    print("5: Twilio credentials encrypted, never echoed, cleared")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9100)
    ap.add_argument("--persist-to", default=None)
    args = ap.parse_args()
    persist = args.persist_to or tempfile.mkdtemp(prefix="piplayer-alerts-e2e-")
    os.makedirs(persist, exist_ok=True)
    shutil.rmtree(os.path.join(persist, "v3"), ignore_errors=True)  # fresh D1: the assertions count rows
    ec.migrate(persist)
    proc, base, log = ec.start_dev(args.port, persist, extra_args=("--test-scheduled",))
    try:
        run(base, persist)
    finally:
        ec.stop(proc)
        log.close()
    print("alerts e2e OK")


if __name__ == "__main__":
    main()
