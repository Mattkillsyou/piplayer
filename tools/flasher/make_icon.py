"""Render icon.ico / icon.png for the SD Flasher (run once, commit the results).

Original artwork in the Projection5000 monochrome style: black ground, a small projector at the
bottom left throwing a widening beam onto a bright screen, white corner brackets, and "5000" in the
Silkscreen pixel face on the larger sizes. Pillow only; fonts come from player/player/fonts.

    python make_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
FONT = HERE.parent.parent / "player" / "player" / "fonts" / "Silkscreen-Bold.ttf"
SIZES = (256, 128, 64, 48, 32, 16)


def render(size: int) -> Image.Image:
    s = size
    img = Image.new("RGBA", (s, s), (0, 0, 0, 255))
    d = ImageDraw.Draw(img, "RGBA")
    u = s / 64  # design unit: the artwork is laid out on a 64-grid

    def px(v):
        return int(round(v * u))

    # screen: bright panel top right, with a thin darker inset so it reads as a surface
    sx0, sy0, sx1, sy1 = px(34), px(10), px(58), px(36)
    d.rectangle([sx0, sy0, sx1, sy1], fill=(255, 255, 255, 255))
    if s >= 32:
        d.rectangle([sx0 + px(2), sy0 + px(2), sx1 - px(2), sy1 - px(2)], fill=(232, 232, 232, 255))

    # beam: widening trapezoid from the projector lens to the screen edge
    lens = (px(12), px(44))
    beam = [lens, (sx0, sy0 + px(1)), (sx0, sy1 - px(1))]
    d.polygon(beam, fill=(255, 255, 255, 120))
    d.line([lens, (sx0, sy0 + px(1))], fill=(255, 255, 255, 200), width=max(1, px(1)))
    d.line([lens, (sx0, sy1 - px(1))], fill=(255, 255, 255, 200), width=max(1, px(1)))

    # projector: a squat box with a lens dot
    d.rectangle([px(4), px(40), px(14), px(48)], fill=(255, 255, 255, 255))
    d.rectangle([px(13), px(42), px(15), px(46)], fill=(255, 255, 255, 255))

    # corner brackets (the console's panel frame)
    if s >= 32:
        b, w = px(7), max(1, px(1))
        d.line([(w, w), (b, w)], fill="white", width=w)
        d.line([(w, w), (w, b)], fill="white", width=w)
        d.line([(s - 1 - w, s - 1 - w), (s - 1 - b, s - 1 - w)], fill="white", width=w)
        d.line([(s - 1 - w, s - 1 - w), (s - 1 - w, s - 1 - b)], fill="white", width=w)

    # wordmark fragment "5000" along the bottom on sizes that can carry it
    if s >= 48 and FONT.exists():
        font = ImageFont.truetype(str(FONT), px(11))
        text = "5000"
        tw = d.textlength(text, font=font)
        d.text((px(4), px(51)), text, font=font, fill=(255, 255, 255, 255))
    return img


def main() -> None:
    frames = [render(n) for n in SIZES]
    frames[0].save(HERE / "icon.png")
    frames[0].save(HERE / "icon.ico", format="ICO", sizes=[(n, n) for n in SIZES],
                   append_images=frames[1:])
    print("wrote", HERE / "icon.ico", "and icon.png", SIZES)


if __name__ == "__main__":
    main()
