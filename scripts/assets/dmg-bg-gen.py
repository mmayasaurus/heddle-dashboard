#!/usr/bin/env python3
"""Generate heddle's dark branded DMG background (scripts/assets/dmg-background.png).

The logical window is 660×400; this image is rendered at 2× (1320×800) for Retina displays.
The layout places the heddle wordmark and tagline at the top, an arrow from the app icon on the
left to Applications on the right, and installation guidance at the bottom. create-dmg overlays the
icons on this background; see publish.sh. Edit this file and rerun it to change the design:
python3 scripts/assets/dmg-bg-gen.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT_DIR = os.path.join(HERE, "..", "..", "src", "assets", "fonts")
BOLD = os.path.join(FONT_DIR, "NotoSansSC-Bold.ttf")
REG = os.path.join(FONT_DIR, "NotoSansSC-Regular.ttf")
OUT = os.path.join(HERE, "dmg-background.png")

W, H = 1320, 800  # 2× of the 660×400 dmg window

TOP = (42, 47, 55)      # #2A2F37 top
BOT = (24, 27, 32)      # #181B20 bottom
WHITE = (244, 246, 249)
DIM = (138, 148, 162)
ACCENT = (79, 195, 176)  # Brand teal

img = Image.new("RGB", (W, H), BOT)
d = ImageDraw.Draw(img)

# Vertical gradient, drawn row by row for speed.
for y in range(H):
    t = y / (H - 1)
    c = tuple(round(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3))
    d.line([(0, y), (W, y)], fill=c)


def center(text, font, y, fill):
    bbox = d.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    d.text(((W - w) / 2 - bbox[0], y), text, font=font, fill=fill)


title_f = ImageFont.truetype(BOLD, 76)
tag_f = ImageFont.truetype(REG, 30)
hint_f = ImageFont.truetype(REG, 30)

center("heddle", title_f, 78, WHITE)
center("terminal · agents", tag_f, 188, DIM)

# Arrow: app icon center x≈330, Applications center x≈990 (logical 165/495 ×2), y=500.
ay = 500
x0, x1 = 500, 820
d.line([(x0, ay), (x1, ay)], fill=ACCENT, width=10)
hs = 26
d.polygon([(x1 + 20, ay), (x1 - hs, ay - hs), (x1 - hs, ay + hs)], fill=ACCENT)
d.ellipse([x0 - 6, ay - 6, x0 + 6, ay + 6], fill=ACCENT)

center("Drag to Applications to install", hint_f, 690, DIM)

img.save(OUT)
print("wrote", OUT, img.size)
