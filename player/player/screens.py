"""Status screens: 1920x1080 stills the daemon loads into mpv whenever there
is nothing to play (boot, pairing, waiting, syncing, offline, error), plus
the NOW PLAYING lower-third overlay shown for a few seconds after a playlist
change.

layout() is the testable contract: it returns every text item with its
position and ink extent, and render() draws exactly that list (plus the
non-text decorations: scanlines, brackets, rule, pill, keycap, progress bar).
"""
import functools
import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

log = logging.getLogger("piplayer.screens")

WIDTH, HEIGHT = 1920, 1080
SAFE_X, SAFE_Y = 96, 54
SAFE_W = WIDTH - 2 * SAFE_X
RIGHT = WIDTH - SAFE_X
BOTTOM = HEIGHT - SAFE_Y

FONT_DIR = Path(__file__).parent / "fonts"
FONT_FILES = {
    "display": "Silkscreen-Regular.ttf",
    "display-bold": "Silkscreen-Bold.ttf",
    "mono": "IBMPlexMono-Regular.ttf",
    "mono-medium": "IBMPlexMono-Medium.ttf",
    "mono-semibold": "IBMPlexMono-SemiBold.ttf",
    "sans": "SpaceGrotesk[wght].ttf",
}

# Monochrome palette: every grey is white at some alpha over true black.
BLACK = (0, 0, 0)
PHOSPHOR = (255, 255, 255)
INK = (230, 230, 230)
BODY = (201, 201, 201)
MUTED = (122, 122, 122)
DIM = (74, 74, 74)
RULE = (36, 36, 36)          # 14%
SCANLINE = (10, 10, 10)      # 4%
HATCH = (51, 51, 51)         # 20%
EDGE_HOLD = (115, 115, 115)  # 45%
EDGE_IDLE = (56, 56, 56)     # 22%

ROLE_COLORS = {
    "phosphor": PHOSPHOR, "ink": INK, "body": BODY, "muted": MUTED, "dim": DIM,
    "keycap": BLACK,          # black text on the white 5000 box
    "pill-solid": BLACK,      # black text on a solid (ok) pill
    "pill": PHOSPHOR,         # white text on an outlined pill
}

PILLS = {   # kind -> (edge style, label)
    "boot": ("idle", "starting"),
    "pairing": ("idle", "no playlist"),
    "waiting": ("idle", "idle"),
    "syncing": ("ok", "syncing"),
    "offline": ("offline", "offline"),
}

HEADLINES = {
    "boot": "BOOTING",
    "pairing": "NOT ASSIGNED",
    "waiting": "STANDING BY",
    "syncing": "SYNCING",
    "offline": "OFFLINE",
}
ERROR_HEADLINES = {"token": "TOKEN REJECTED", "player": "PLAYER FAULT", "storage": "STORAGE FULL"}

ELLIPSIS = "…"
DOT = " · "


@dataclass
class ScreenState:
    kind: str                       # boot | pairing | waiting | syncing | offline | error | nowplaying
    device_id: str = ""
    device_name: str = ""
    console_url: str = ""
    version: str = ""
    playlist_name: str | None = None
    item_count: int = 0
    source: str | None = None       # manifest playlist.source, e.g. "device-default", "schedule:Night"
    next_rule: dict | None = None   # {"name", "playlist", "starts_at" iso}
    progress_done: int = 0          # current item, 1-based (syncing)
    progress_total: int = 0
    current_file: str = ""
    phase: str = "downloading"      # downloading | verifying
    bytes_done: int | None = None
    bytes_total: int | None = None
    cached: bool = False            # offline: cached content available
    last_contact: str = ""          # offline: "4 min ago" / "never"
    reason: str = ""                # error: token | player | storage | other
    message: str = ""
    clock: str = ""                 # already formatted HH:MM:SS (renderer reads the clock only when empty)


@functools.lru_cache(maxsize=None)
def _font(family: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_DIR / FONT_FILES[family]), size)


def _width(text: str, font: ImageFont.FreeTypeFont, tracking: int = 0) -> int:
    if tracking:
        return int(sum(font.getlength(ch) for ch in text) + tracking * (len(text) - 1))
    return int(font.getbbox(text)[2])


def _fit(text: str, font: ImageFont.FreeTypeFont, max_width: int) -> str:
    """Shorten text with a middle ellipsis until it fits max_width."""
    if not text or font.getlength(text) <= max_width:
        return text
    per_char = font.getlength(text) / len(text)
    keep = min(len(text) - 1, int(max_width / per_char))
    while keep > 1:
        head = keep // 2
        cand = text[:head] + ELLIPSIS + text[len(text) - (keep - head):]
        if font.getlength(cand) <= max_width:
            return cand
        keep -= 1
    return ELLIPSIS


def _item(text: str, x: int, y: int, family: str, size: int, role: str,
          tracking: int = 0, max_width: int | None = None) -> dict:
    font = _font(family, size)
    if max_width is not None:
        text = _fit(text, font, max_width)
    bbox = font.getbbox(text) if text else (0, 0, 0, 0)
    return {
        "text": text, "x": int(x), "y": int(y), "font": family, "size": size, "role": role,
        "tracking": tracking, "w": _width(text, font, tracking), "h": int(bbox[3]), "top": int(bbox[1]),
    }


def _right(text: str, right: int, y: int, family: str, size: int, role: str, max_width: int) -> dict:
    it = _item(text, 0, y, family, size, role, max_width=max_width)
    it["x"] = right - it["w"]
    return it


def headline(state: ScreenState) -> str:
    """The big word for a kind (and reason, for errors)."""
    if state.kind == "error":
        return ERROR_HEADLINES.get(state.reason, "ERROR")
    return HEADLINES.get(state.kind, state.kind.upper())


def _next_rule_text(rule: dict) -> str:
    when = str(rule.get("starts_at") or "")
    try:
        at = datetime.fromisoformat(when)
        when = at.strftime("%H:%M") if at.date() == datetime.now(at.tzinfo).date() else at.strftime("%a %H:%M")
    except ValueError:
        pass
    return f"next: {rule.get('name') or '?'}{DOT}{rule.get('playlist') or '?'} at {when}"


def _mb(n: int) -> str:
    return f"{n / 1048576:.1f} MB"


def _details(state: ScreenState) -> tuple[list[str], str]:
    """Detail lines and the optional help line for a full screen."""
    k, url = state.kind, state.console_url
    if k == "boot":
        return [f"waiting for the console at {url}", f"device {state.device_id}"], ""
    if k == "pairing":
        return ([f"{state.device_name}{DOT}{state.device_id}", "assign a playlist to this device in the console", url],
                "Devices page: pick a default playlist, a group, or add a schedule rule.")
    if k == "waiting":
        lines = [f"playlist {state.playlist_name} has no items" if state.playlist_name else "no schedule rule is active"]
        if state.next_rule:
            lines.append(_next_rule_text(state.next_rule))
        return lines, ""
    if k == "syncing":
        lines = [f"{state.phase} {state.progress_done} of {state.progress_total}", state.current_file]
        if state.bytes_done is not None and state.bytes_total:
            lines.append(f"{_mb(state.bytes_done)} / {_mb(state.bytes_total)}")
        return lines, ""
    if k == "offline":
        return ([f"console unreachable: {url}", f"last contact {state.last_contact or 'never'}",
                 "playing cached content" if state.cached else "no cached content"],
                "Check network, the console address and that the console is running.")
    if k == "error":
        if state.reason == "token":
            return ["the console refused this device's token", state.device_id,
                    "regenerate the token on the Devices page and re-run the installer"], ""
        if state.reason == "player":
            return [state.message, "restart mpv from the console or reboot"], ""
        if state.reason == "storage":
            return [state.message, "free space on the SD card or shrink the playlist"], ""
        return [state.message], ""
    return [], ""


def _compose_full(state: ScreenState) -> tuple[list[dict], dict]:
    items: list[dict] = []
    extras: dict = {}

    # header, left: wordmark
    eyebrow = _item("MATT BROWN'S", SAFE_X, SAFE_Y, "sans", 22, "muted", tracking=6)
    word = _item("PROJECTION", SAFE_X, SAFE_Y + 34, "display", 44, "phosphor")
    cap = _item("5000", SAFE_X + word["w"] + 20, word["y"], "display", 44, "keycap")
    extras["keycap"] = (cap["x"] - 4, cap["y"] + cap["top"] - 4, cap["x"] + cap["w"] + 4, cap["y"] + cap["h"] + 4)
    items += [eyebrow, word, cap]

    # header, right: device name, id, status pill
    half = SAFE_W // 2 - 40
    name = _right((state.device_name or state.device_id or "").upper(), RIGHT, SAFE_Y, "display", 44, "phosphor", half)
    dev = _right(state.device_id, RIGHT, SAFE_Y + 62, "mono", 30, "muted", half)
    style, label = PILLS.get(state.kind, ("fault", state.reason or "error"))
    pill = _right(label.upper(), RIGHT - 14, SAFE_Y + 112, "mono", 26, "pill-solid" if style == "ok" else "pill", half)
    extras["pill"] = ((pill["x"] - 14, pill["y"] + pill["top"] - 8, RIGHT, pill["y"] + pill["h"] + 8), style)
    items += [name, dev, pill]

    rule_y = SAFE_Y + 172
    extras["rule"] = rule_y

    # footer
    foot_font = _font("mono", 28)
    foot_y = BOTTOM - foot_font.getbbox("Xg")[3] - 2
    right = _right(f"player v{state.version}{DOT}{state.clock or datetime.now().strftime('%H:%M:%S')}",
                   RIGHT, foot_y, "mono", 28, "dim", half)
    left = _item(f"console {state.console_url}", SAFE_X, foot_y, "mono", 28, "muted", max_width=RIGHT - 40 - right["w"] - SAFE_X)
    items += [left, right]

    # middle band: headline, detail lines, optional bar, optional help line
    word_text = headline(state)
    size = 160
    while size > 100 and _width(word_text, _font("display", size)) > SAFE_W:
        size -= 10
    head = _item(word_text, SAFE_X, 0, "display", size, "phosphor", max_width=SAFE_W)
    details, help_line = _details(state)
    bar = state.kind == "syncing"
    height = head["h"] + 36 + len(details) * 58 + (46 if bar else 0) + (58 if help_line else 0)
    top = rule_y + 1
    y = top + (foot_y - 24 - top - height) // 2
    head["y"] = y
    items.append(head)
    y += head["h"] + 36
    for i, line in enumerate(details):
        items.append(_item(line, SAFE_X, y, "mono", 42, "ink" if i == 0 else "body", max_width=SAFE_W))
        y += 58
        if bar and i == 1:
            frac = 0.0
            if state.bytes_total:
                frac = min(1.0, (state.bytes_done or 0) / state.bytes_total)
            pct = ((state.progress_done - 1) + frac) / state.progress_total if state.progress_total else 0.0
            extras["bar"] = ((SAFE_X, y, RIGHT, y + 22), max(0.0, min(1.0, pct)), state.phase)
            y += 46
    if help_line:
        items.append(_item(help_line, SAFE_X, y + 6, "sans", 34, "muted", max_width=SAFE_W))
    return items, extras


def _compose_overlay(state: ScreenState) -> tuple[list[dict], dict]:
    pad_x, pad_y = 32, 24
    max_w = SAFE_W - 2 * pad_x
    label = _item("NOW PLAYING", 0, 0, "mono", 26, "muted", tracking=4)
    name = _item(state.playlist_name or "", 0, 0, "display", 56, "phosphor", max_width=max_w)
    sub = _item(f"{state.item_count} items{DOT}via {state.source or 'console'}", 0, 0, "mono", 30, "body", max_width=max_w)
    width = max(640, max(label["w"], name["w"], sub["w"]) + 2 * pad_x)
    height = pad_y + label["h"] + 16 + name["h"] + 14 + sub["h"] + pad_y
    x0, y0 = SAFE_X, BOTTOM - height
    y = y0 + pad_y
    for it in (label, name, sub):
        it["x"], it["y"] = x0 + pad_x, y
        y += it["h"] + (16 if it is label else 14)
    return [label, name, sub], {"bar": (x0, y0, x0 + width, BOTTOM)}


def _compose(state: ScreenState) -> tuple[list[dict], dict]:
    if state.kind == "nowplaying":
        return _compose_overlay(state)
    return _compose_full(state)


def layout(state: ScreenState) -> list[dict]:
    """Every text item render() draws: text, x, y, font, size, role, w, h."""
    return _compose(state)[0]


# ------------------------------------------------------------ drawing ---

def _rgba(color: tuple, alpha: bool) -> tuple:
    return color + (255,) if alpha else color


def _draw_items(d: ImageDraw.ImageDraw, items: list[dict], alpha: bool = False) -> None:
    for it in items:
        font = _font(it["font"], it["size"])
        fill = _rgba(ROLE_COLORS[it["role"]], alpha)
        if it["tracking"]:
            x = it["x"]
            for ch in it["text"]:
                d.text((x, it["y"]), ch, font=font, fill=fill)
                x += font.getlength(ch) + it["tracking"]
        else:
            d.text((it["x"], it["y"]), it["text"], font=font, fill=fill)


def _hatch(d: ImageDraw.ImageDraw, box: tuple, step: int = 8, alpha: float = 0.2) -> None:
    """45-degree hatch (4 on / 4 off at step 8) clipped to box."""
    x0, y0, x1, y1 = box
    v = round(255 * alpha)
    h = y1 - y0
    for o in range(-h, x1 - x0, step):
        t_lo, t_hi = max(0, -o), min(h, x1 - x0 - o)
        if t_lo <= t_hi:
            d.line([(x0 + o + t_lo, y0 + t_lo), (x0 + o + t_hi, y0 + t_hi)], fill=(v, v, v), width=1)


def _dashed_rect(d: ImageDraw.ImageDraw, box: tuple, on: int, off: int, color: tuple) -> None:
    x0, y0, x1, y1 = box
    for (ax, ay), (bx, by) in (((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))):
        length = abs(bx - ax) + abs(by - ay)
        sx = (bx > ax) - (bx < ax)
        sy = (by > ay) - (by < ay)
        pos = 0
        while pos < length:
            end = min(pos + on - 1, length)
            d.line([(ax + sx * pos, ay + sy * pos), (ax + sx * end, ay + sy * end)], fill=color, width=1)
            pos += on + off


def _frame(d: ImageDraw.ImageDraw, box: tuple, style: str) -> None:
    """Status edge language: ok solid, hold/idle outline, fault hatch, offline dotted, stale dashed."""
    if style == "ok":
        d.rectangle(box, fill=PHOSPHOR)
    elif style == "hold":
        d.rectangle(box, outline=EDGE_HOLD, width=1)
    elif style == "idle":
        d.rectangle(box, outline=EDGE_IDLE, width=1)
    elif style == "fault":
        _hatch(d, (box[0] + 1, box[1] + 1, box[2] - 1, box[3] - 1))
        d.rectangle(box, outline=PHOSPHOR, width=1)
    elif style == "offline":
        _dashed_rect(d, box, 1, 3, PHOSPHOR)
    elif style == "stale":
        _dashed_rect(d, box, 8, 6, PHOSPHOR)


def _decorate(d: ImageDraw.ImageDraw) -> None:
    for y in range(0, HEIGHT, 3):
        d.line([(0, y), (WIDTH, y)], fill=SCANLINE, width=1)
    # brackets sit 14px outside the safe area so they never cross header/footer ink
    leg, gap = 40, 14
    for x, dx in ((SAFE_X - gap, 1), (RIGHT + gap, -1)):
        for y, dy in ((SAFE_Y - gap, 1), (BOTTOM + gap, -1)):
            d.line([(x, y), (x + dx * leg, y)], fill=PHOSPHOR, width=1)
            d.line([(x, y), (x, y + dy * leg)], fill=PHOSPHOR, width=1)


def render(state: ScreenState) -> Image.Image:
    """RGB image for full screens, RGBA for the nowplaying overlay."""
    items, extras = _compose(state)
    if state.kind == "nowplaying":
        img = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        x0, y0, x1, y1 = extras["bar"]
        d.rectangle((x0, y0, x1, y1), fill=(0, 0, 0, 199))
        d.line([(x0, y0), (x1, y0)], fill=(255, 255, 255, 255), width=1)
        _draw_items(d, items, alpha=True)
        return img

    img = Image.new("RGB", (WIDTH, HEIGHT), BLACK)
    d = ImageDraw.Draw(img)
    _decorate(d)
    d.line([(SAFE_X, extras["rule"]), (RIGHT, extras["rule"])], fill=RULE, width=1)
    d.rectangle(extras["keycap"], fill=PHOSPHOR)
    _frame(d, *extras["pill"])
    if "bar" in extras:
        (x0, y0, x1, y1), pct, phase = extras["bar"]
        d.rectangle((x0, y0, x1, y1), outline=PHOSPHOR, width=1)
        fill_x = x0 + 2 + int((x1 - x0 - 4) * pct)
        if fill_x > x0 + 2:
            if phase == "verifying":
                _hatch(d, (x0 + 2, y0 + 2, fill_x, y1 - 2))
            else:
                d.rectangle((x0 + 2, y0 + 2, fill_x, y1 - 2), fill=PHOSPHOR)
    _draw_items(d, items)
    return img


def render_png(state: ScreenState, path: Path) -> Path:
    """Write the screen as PNG atomically (tmp + replace)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    render(state).save(tmp, "PNG", compress_level=1)
    tmp.replace(path)
    return path


def render_overlay_bgra(state: ScreenState, path: Path) -> tuple[Path, int, int]:
    """Raw premultiplied BGRA pixels for mpv's overlay-add. Returns (path, w, h)."""
    img = render(state)
    r, g, b, a = img.split()
    # premultiply: ImageChops.multiply is c * a / 255 per channel
    pre = Image.merge("RGBA", (ImageChops.multiply(b, a), ImageChops.multiply(g, a), ImageChops.multiply(r, a), a))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(pre.tobytes())
    tmp.replace(path)
    return path, img.width, img.height
