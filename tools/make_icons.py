"""
Generates the PWA icons from the same crystal mark used in the app.

The mark lives as SVG paths in reserve/index.html (#i-flake). This redraws that
geometry with Pillow so the launcher icons and the in-app logo never drift
apart. Re-run it after changing the mark, or when a real logo shows up:

    python tools/make_icons.py

Writes into icons/ at the project root.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"

# Drawn at 4x and downsampled — Pillow has no antialiasing of its own.
SS = 4

# Sidebar gradient, top to bottom.
BG_TOP = (16, 35, 63)
BG_BOTTOM = (27, 58, 99)
INK = (219, 234, 255)

# The #i-flake geometry, in its native 24-unit space.
HEX = [(12, 2.6), (20.1, 7.3), (20.1, 16.7), (12, 21.4), (3.9, 16.7), (3.9, 7.3)]
SPOKES = [
    ((12, 7.6), (12, 16.4)),
    ((8.2, 9.8), (15.8, 14.2)),
    ((15.8, 9.8), (8.2, 14.2)),
]
STROKE = 1.9          # in 24-unit space
VIEWBOX = 24


def gradient(size: int) -> Image.Image:
    """Vertical BG_TOP -> BG_BOTTOM."""
    img = Image.new("RGB", (1, size))
    px = img.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        px[0, y] = tuple(
            round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)
        )
    return img.resize((size, size), Image.NEAREST)


def draw_mark(img: Image.Image, scale: float, cx: float, cy: float) -> None:
    """Stroke the crystal centred on (cx, cy). `scale` is px per unit."""
    d = ImageDraw.Draw(img)
    w = max(round(STROKE * scale), 1)
    r = w / 2

    def pt(p):
        return (cx + (p[0] - VIEWBOX / 2) * scale,
                cy + (p[1] - VIEWBOX / 2) * scale)

    # Hexagon: joint="curve" rounds the corners the way stroke-linejoin does.
    # Carry on past the closing point to the second one, otherwise the very
    # first vertex is the one join Pillow never rounds and it shows as a notch.
    ring = [pt(p) for p in HEX]
    d.line(ring + [ring[0], ring[1]], fill=INK, width=w, joint="curve")

    for a, b in SPOKES:
        pa, pb = pt(a), pt(b)
        d.line([pa, pb], fill=INK, width=w)
        # Pillow has no round line caps; add them by hand so the spokes
        # match the SVG's stroke-linecap="round".
        for x, y in (pa, pb):
            d.ellipse([x - r, y - r, x + r, y + r], fill=INK)


def build(size: int, name: str, *, maskable: bool = False) -> Path:
    """maskable icons go full-bleed and shrink the mark into the safe zone."""
    px = size * SS
    img = gradient(px)

    if not maskable:
        # Rounded square: mask the gradient into a squircle-ish tile.
        radius = round(px * 0.22)
        mask = Image.new("L", (px, px), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, px - 1, px - 1],
                                               radius=radius, fill=255)
        tile = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        tile.paste(img, (0, 0), mask)
        img = tile
    else:
        img = img.convert("RGBA")

    # Maskable icons can be cropped to a circle of ~80% width, so the mark
    # has to sit well inside that. Non-maskable can breathe closer to the edge.
    coverage = 0.52 if maskable else 0.66
    scale = (px * coverage) / VIEWBOX
    draw_mark(img, scale, px / 2, px / 2)

    img = img.resize((size, size), Image.LANCZOS)
    OUT.mkdir(exist_ok=True)
    path = OUT / name
    img.save(path, "PNG")
    return path


if __name__ == "__main__":
    made = [
        build(192, "icon-192.png"),
        build(512, "icon-512.png"),
        build(512, "icon-maskable-512.png", maskable=True),
        # iOS applies its own mask and ignores transparency, so ship it
        # full-bleed rather than as a rounded tile on a black square.
        build(180, "apple-touch-icon.png", maskable=True),
    ]
    for p in made:
        print(f"{p.relative_to(OUT.parent)}  {p.stat().st_size:,} bytes")
