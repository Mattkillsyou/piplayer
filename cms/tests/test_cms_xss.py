"""Contract 9 / C001: no name is ever interpolated into inline JavaScript."""
import html as html_mod
import re
from pathlib import Path

import pytest

from cms_helpers import create_device, create_group, create_playlist, create_user, post, upload

PAYLOAD = "x');alert(1);//"
ESCAPED = html_mod.escape(PAYLOAD, quote=True)  # x&#x27;);alert(1);// (Jinja: x&#39;);alert(1);//)
DATA_CONFIRM_RX = re.compile(r'data-confirm="([^"]*)"')


def _assert_safe(page_html: str, expected_confirm_fragment: str):
    assert "onsubmit" not in page_html, "inline onsubmit handler still present"
    assert PAYLOAD not in page_html, "raw (unescaped) payload found in the page"
    # every occurrence of the payload text is HTML-escaped: the single quote never survives
    for m in re.finditer(r"alert\(1\)", page_html):
        window = page_html[max(0, m.start() - 40): m.start()]
        assert "x');" not in window, f"unescaped quote next to payload: {window!r}"
    confirms = DATA_CONFIRM_RX.findall(page_html)
    assert confirms, "no data-confirm attribute rendered for the destructive form"
    matching = [c for c in confirms if "alert(1)" in c]
    assert matching, f"payload not carried in a data-confirm attribute; got {confirms}"
    for c in matching:
        assert expected_confirm_fragment in c, c
        assert "'" not in c and "<" not in c and ">" not in c and '"' not in c
    # the payload appears nowhere inside a <script> block
    for script in re.findall(r"<script\b[^>]*>(.*?)</script>", page_html, re.S):
        assert "alert(1)" not in script


def test_playlist_name_is_escaped_in_confirm(admin, tok):
    name = PAYLOAD  # intentionally the exact audit payload
    pid = create_playlist(admin, name + tok)
    page = admin.get("/playlists").text
    _assert_safe(page, "alert(1);//" + tok)
    # both Jinja's &#39; and html.escape's &#x27; are acceptable escapings of the quote
    assert re.search(r'data-confirm="Delete playlist x&#(39|x27);\);alert\(1\);//' + tok + r'\?"', page), \
        "data-confirm should be 'Delete playlist <escaped name>?'"
    page = admin.get(f"/playlists/{pid}").text
    assert "onsubmit" not in page
    assert PAYLOAD not in page


def test_device_name_is_escaped_in_confirm(admin, tok):
    create_device(admin, f"xss-{tok}", PAYLOAD + tok)
    page = admin.get("/devices").text
    _assert_safe(page, "alert(1);//" + tok)


def test_group_name_is_escaped_in_confirm(admin, tok):
    create_group(admin, PAYLOAD + tok)
    page = admin.get("/groups").text
    _assert_safe(page, "alert(1);//" + tok)


def test_user_name_is_escaped_in_confirm(admin, tok):
    create_user(admin, PAYLOAD + tok, "pw123456", "viewer")
    page = admin.get("/users").text
    _assert_safe(page, "alert(1);//" + tok)


def test_media_name_is_escaped_in_confirm(admin, make_media, tok):
    upload(admin, make_media("png"), original_name=PAYLOAD + tok + ".png")
    page = admin.get("/library").text
    _assert_safe(page, "alert(1);//" + tok)


def test_schedule_rule_name_is_escaped_in_confirm(admin, tok):
    pid = create_playlist(admin, f"xss-sched-{tok}")
    dev = create_device(admin, f"xss-sched-{tok}")
    r = post(admin, f"/devices/{dev['id']}/schedule", {"name": PAYLOAD + tok, "playlist_id": str(pid), "priority": "1"})
    assert r.status_code == 303, r.text[:300]
    page = admin.get(f"/devices/{dev['id']}/schedule").text
    _assert_safe(page, "alert(1);//" + tok)


def test_templates_have_no_inline_onsubmit_and_base_has_delegated_listener(cms):
    tpl_dir = Path(cms.root) / "app" / "templates"
    inline = re.compile(r"\son(submit|change|click|load|input|keyup|keydown)\s*=", re.I)
    offenders = [p.name for p in tpl_dir.glob("*.html") if inline.search(p.read_text(encoding="utf-8"))]
    assert offenders == [], f"templates still using inline event handlers: {offenders}"
    base = (tpl_dir / "base.html").read_text(encoding="utf-8")
    assert "/static/app.js" in base, "base.html does not load app.js"
    app_js = (Path(cms.root) / "app" / "static" / "app.js").read_text(encoding="utf-8")
    assert "dataset.confirm" in app_js, "app.js lacks the delegated data-confirm submit listener"
    assert "preventDefault" in app_js
    assert "select[data-autosubmit]" in app_js, "app.js lacks the select auto-submit listener"
    # every destructive form carries data-confirm instead
    with_confirm = [p.name for p in tpl_dir.glob("*.html") if "data-confirm=" in p.read_text(encoding="utf-8")]
    for expected in ("playlists.html", "devices.html", "groups.html", "users.html", "library.html", "device_schedule.html"):
        assert expected in with_confirm, f"{expected} has no data-confirm form"
