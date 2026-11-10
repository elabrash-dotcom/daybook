#!/usr/bin/env python3
"""Pop-poster scoreboard: Poppins ExtraBold, black outlines, hard shadows. Usage: render.py spec.json out.png"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
INK = (17, 17, 17)
BG = (255, 246, 230)
THEME = {"mobiletek": (255, 217, 61), "mcc": (74, 214, 255), "combined": (255, 255, 255)}
CHIP = {"ahead": (47, 191, 113), "behind": (240, 72, 60), "even": (255, 255, 255)}
# Poppins ExtraBold (SIL Open Font License) comes from the @fontsource/poppins npm package, cached in /tmp.
FONT_PKG = "https://registry.npmjs.org/@fontsource/poppins/-/poppins-5.2.7.tgz"
FONT_MEMBER = "package/files/poppins-latin-800-normal.woff"
FONT = "/tmp/poppins-extrabold.woff"


def ensure_font():
    if os.path.exists(FONT):
        return True
    try:
        import io, tarfile, urllib.request
        data = urllib.request.urlopen(FONT_PKG, timeout=30).read()
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            with open(FONT, "wb") as out:
                out.write(tf.extractfile(FONT_MEMBER).read())
        return True
    except Exception as e:  # fall back to Pillow's built-in font rather than failing the card
        print("font download failed, using default font:", e, file=sys.stderr)
        return False


HAVE_FONT = ensure_font()


def font(size):
    return ImageFont.truetype(FONT, size) if HAVE_FONT else ImageFont.load_default(size)


def fit(draw, text, max_w, start, min_size=28):
    size = start
    while size > min_size and draw.textlength(text, font=font(size)) > max_w:
        size -= 2
    f = font(size)
    if draw.textlength(text, font=f) > max_w:  # still too long: trim with an ellipsis
        while text and draw.textlength(text + "…", font=f) > max_w:
            text = text[:-1]
        text += "…"
    return text, f


def box(draw, xy, fill, radius=36, shadow=14, outline=7):
    x0, y0, x1, y1 = xy
    draw.rounded_rectangle((x0 + shadow, y0 + shadow, x1 + shadow, y1 + shadow), radius, fill=INK)
    draw.rounded_rectangle(xy, radius, fill=fill, outline=INK, width=outline)


def stroke_text(draw, xy, text, f, fill=(255, 255, 255), stroke=6, anchor="la"):
    x, y = xy
    draw.text((x + 6, y + 6), text, font=f, fill=INK, anchor=anchor, stroke_width=stroke, stroke_fill=INK)
    draw.text((x, y), text, font=f, fill=fill, anchor=anchor, stroke_width=stroke, stroke_fill=INK)


def main(spec_path, out_path):
    spec = json.load(open(spec_path))
    shops = (spec.get("shops") or [])[:3]
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # dotted pop background
    for yy in range(0, H, 48):
        for xx in range(0 if (yy // 48) % 2 else 24, W, 48):
            d.ellipse((xx, yy, xx + 8, yy + 8), fill=(246, 228, 200))

    title, tf = fit(d, spec.get("title", "Scoreboard"), W - 120, 110)
    stroke_text(d, (60, 70), title, tf, fill=(255, 217, 61), stroke=8)
    sub = spec.get("subtitle", "")
    if sub:
        sub, sf = fit(d, sub, W - 120, 44)
        d.text((62, 210), sub, font=sf, fill=INK)

    top, bottom = 290, H - 130
    gap = 40
    n = max(1, len(shops))
    card_h = (bottom - top - gap * (n - 1)) // n
    for i, s in enumerate(shops):
        y0 = top + i * (card_h + gap)
        y1 = y0 + card_h - 14
        fill = THEME.get(s.get("theme", "combined"), THEME["combined"])
        box(d, (40, y0, W - 54, y1), fill)
        name, nf = fit(d, s.get("name", ""), 560, 58)
        d.text((80, y0 + 34), name, font=nf, fill=INK)
        chip = s.get("chip", "")
        if chip:
            cf = font(52)
            cw = int(d.textlength(chip, font=cf)) + 60
            cx1 = W - 94
            cx0 = cx1 - cw
            box(d, (cx0, y0 + 26, cx1, y0 + 116), CHIP.get(s.get("status", "even"), CHIP["even"]), radius=45, shadow=8, outline=6)
            d.text(((cx0 + cx1) // 2, y0 + 71), chip, font=cf, fill=INK, anchor="mm")
        rows = (s.get("rows") or [])[:4]
        rows_h = len(rows) * 58
        label = s.get("label", "")
        label_h = 56 if label else 0
        big_top = y0 + 128
        room = (y1 - 34 - rows_h) - big_top - label_h - 12
        size = 190
        big = s.get("big", "")
        while True:
            big_t, bf = fit(d, big, W - 200, size)
            bb = d.textbbox((80, big_top), big_t, font=bf, stroke_width=7)
            if bb[3] - big_top + 6 <= room or size <= 56:
                break
            size -= 6
        stroke_text(d, (80, big_top), big_t, bf, fill=(255, 255, 255), stroke=7)
        ly = bb[3] + 14
        if label:
            label, lf = fit(d, label, W - 200, 40)
            d.text((84, ly), label, font=lf, fill=INK)
        ry = max(ly + label_h + 4, y1 - 34 - rows_h)
        for k, v in rows:
            kf = font(38)
            d.text((84, ry), str(k), font=kf, fill=INK)
            d.text((W - 110, ry), str(v), font=kf, fill=INK, anchor="ra")
            ry += 58

    foot = spec.get("footer", "")
    if foot:
        foot, ff = fit(d, foot, W - 120, 34)
        d.text((W // 2, H - 70), foot, font=ff, fill=INK, anchor="mm")
    img.save(out_path, "PNG", optimize=True)
    print(out_path)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
