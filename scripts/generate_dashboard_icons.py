#!/usr/bin/env python3
"""Generate the monochrome pixel sprites used by the dashboard mockup.

The drawings use a 24x24 logical pixel grid and are exported at 2x with nearest
neighbour scaling. PNGs have a transparent outer background and only black /
white artwork, so Pebble can convert them cleanly for its monochrome displays.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources" / "images"
S = 24
SCALE = 1
BLACK = (0, 0, 0, 255)
WHITE = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


class Canvas:
    def __init__(self) -> None:
        self.pixels = [[TRANSPARENT for _ in range(S)] for _ in range(S)]

    def point(self, x: int, y: int, color=BLACK) -> None:
        if 0 <= x < S and 0 <= y < S:
            self.pixels[y][x] = color

    def rect(self, x: int, y: int, w: int, h: int, color=BLACK) -> None:
        for py in range(y, y + h):
            for px in range(x, x + w):
                self.point(px, py, color)

    def ellipse(self, x: int, y: int, w: int, h: int, color=BLACK) -> None:
        # Pixel-center ellipse fill, with stepped edges at this native resolution.
        cx, cy = x + (w - 1) / 2, y + (h - 1) / 2
        rx, ry = max(w / 2, 0.5), max(h / 2, 0.5)
        for py in range(y, y + h):
            for px in range(x, x + w):
                if ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1.0:
                    self.point(px, py, color)

    def ring(self, x: int, y: int, w: int, h: int, thickness: int = 2) -> None:
        self.ellipse(x, y, w, h, BLACK)
        self.ellipse(x + thickness, y + thickness, w - 2 * thickness,
                     h - 2 * thickness, WHITE)

    def scaled(self) -> list[list[tuple[int, int, int, int]]]:
        output = []
        for row in self.pixels:
            scaled_row = []
            for color in row:
                scaled_row.extend([color] * SCALE)
            output.extend([scaled_row] * SCALE)
        return output


def calendar() -> Canvas:
    c = Canvas()
    # Heavy frame with stepped corners and a dark header, like the reference.
    c.rect(3, 5, 18, 17)
    c.rect(5, 3, 14, 2)
    c.rect(3, 7, 18, 2, WHITE)
    c.rect(5, 9, 14, 11, WHITE)
    c.rect(6, 2, 2, 6)
    c.rect(16, 2, 2, 6)
    for yy in (11, 14, 17):
        for xx in (7, 11, 15):
            c.rect(xx, yy, 2, 2, BLACK)
    return c


def weather() -> Canvas:
    c = Canvas()
    # Sun and square rays behind a large, outlined cloud.
    c.rect(5, 5, 2, 2)
    c.rect(9, 3, 2, 2)
    c.rect(13, 5, 2, 2)
    c.rect(3, 9, 2, 2)
    c.rect(7, 7, 7, 7, BLACK)
    c.rect(9, 9, 3, 3, WHITE)
    # Stepped cloud silhouette with white center and a heavy lower edge.
    spans = ((11, 4), (9, 8), (7, 12), (6, 14), (5, 16),
             (4, 18), (4, 18), (5, 16), (7, 12))
    for y, (x, width) in enumerate(spans, start=12):
        c.rect(x, y, width, 1)
    c.rect(11, 14, 4, 1, WHITE)
    c.rect(9, 15, 8, 1, WHITE)
    c.rect(7, 16, 12, 3, WHITE)
    c.rect(7, 19, 12, 1, WHITE)
    return c


def robot() -> Canvas:
    c = Canvas()
    c.rect(11, 2, 2, 3)
    c.rect(9, 1, 6, 2)
    # Stepped head with ears.
    c.rect(5, 7, 14, 12)
    c.rect(7, 5, 10, 2)
    c.rect(3, 10, 2, 6)
    c.rect(19, 10, 2, 6)
    c.rect(7, 7, 10, 10, WHITE)
    c.rect(9, 10, 2, 3, BLACK)
    c.rect(13, 10, 2, 3, BLACK)
    c.rect(10, 15, 4, 1, BLACK)
    c.rect(8, 19, 8, 2, BLACK)
    return c


def chat() -> Canvas:
    c = Canvas()
    c.rect(3, 5, 18, 12)
    c.rect(5, 3, 14, 2)
    c.rect(5, 7, 14, 8, WHITE)
    c.rect(5, 17, 5, 2)
    c.rect(5, 19, 3, 2)
    for x in (8, 11, 14):
        c.rect(x, 10, 2, 2, BLACK)
    return c


def todo() -> Canvas:
    c = Canvas()
    # Luna pattern: full outlined box and bold stepped check.
    for y, x1, x2 in ((2, 3, 20), (3, 3, 20), (20, 3, 20), (21, 3, 20)):
        c.rect(x1, y, x2 - x1 + 1, 1)
    for y in range(4, 20):
        c.rect(2, y, 2, 1)
        c.rect(20, y, 2, 1)
    c.rect(4, 4, 16, 16, WHITE)
    for x, y, w, h in ((6, 11, 2, 4), (8, 13, 2, 4), (10, 15, 2, 3),
                       (12, 13, 2, 3), (14, 11, 2, 3), (16, 9, 2, 3)):
        c.rect(x, y, w, h)
    return c


def timer() -> Canvas:
    c = Canvas()
    # Luna raster pattern, drawn as inclusive row spans.
    c.rect(10, 2, 4, 2)
    c.rect(10, 4, 4, 2)
    outer = {6:(10,13), 7:(8,15), 8:(6,17), 9:(5,18),
             **{y:(4,19) for y in range(10,17)},
             17:(5,18), 18:(6,17), 19:(8,15), 20:(10,13)}
    for y, (x1, x2) in outer.items():
        c.rect(x1, y, x2 - x1 + 1, 1)
    inner = {8:(8,15), 9:(7,16), **{y:(6,17) for y in range(10,17)},
             17:(7,16), 18:(8,15), 19:(10,13)}
    for y, (x1, x2) in inner.items():
        c.rect(x1, y, x2 - x1 + 1, 1, WHITE)
    c.rect(11, 10, 2, 4)
    c.rect(12, 12, 5, 2)
    return c


def alarm() -> Canvas:
    c = Canvas()
    # Luna pattern: bells behind a stepped clock face.
    bells = {2:((5,8),(15,18)), 3:((4,9),(14,19)),
             4:((3,10),(13,20)), 5:((3,10),(13,20)),
             6:((4,9),(14,19)), 7:((6,8),(15,17))}
    for y, spans in bells.items():
        for x1, x2 in spans:
            c.rect(x1, y, x2 - x1 + 1, 1)
    for y in (4, 5):
        c.rect(5, y, 4, 1, WHITE)
        c.rect(15, y, 4, 1, WHITE)
    c.rect(6, 6, 3, 1, WHITE)
    c.rect(15, 6, 3, 1, WHITE)
    outer = {7:(10,13), 8:(8,15), 9:(6,17), 10:(5,18),
             **{y:(4,19) for y in range(11,18)},
             18:(5,18), 19:(7,16), 20:(10,13)}
    for y, (x1, x2) in outer.items():
        c.rect(x1, y, x2 - x1 + 1, 1)
    inner = {9:(8,15), 10:(7,16), **{y:(6,17) for y in range(11,18)},
             18:(7,16), 19:(9,14)}
    for y, (x1, x2) in inner.items():
        c.rect(x1, y, x2 - x1 + 1, 1, WHITE)
    c.rect(11, 11, 2, 4)
    c.rect(12, 13, 4, 2)
    c.rect(6, 20, 4, 2)
    c.rect(14, 20, 4, 2)
    return c


def bell() -> Canvas:
    c = Canvas()
    # Luna pattern: symmetric bell silhouette with stepped white inset.
    outer = {3:(10,13), 4:(9,14), 5:(7,16), 6:(7,16),
             **{y:(5,18) for y in range(7,13)},
             13:(4,19), 14:(3,20), 15:(3,20), 16:(4,19),
             17:(6,17), 18:(9,14), 19:(10,13)}
    for y, (x1, x2) in outer.items():
        c.rect(x1, y, x2 - x1 + 1, 1)
    inner = {5:(9,14), 6:(9,14), **{y:(7,16) for y in range(7,13)},
             13:(5,18), 14:(5,18), 15:(5,18), 16:(6,17), 17:(8,15)}
    for y, (x1, x2) in inner.items():
        c.rect(x1, y, x2 - x1 + 1, 1, WHITE)
    # Notification side rays.
    c.rect(3, 7, 2, 3)
    c.rect(19, 7, 2, 3)
    return c


ICONS = {
    "icon_calendar": calendar,
    "icon_weather": weather,
    "icon_robot": robot,
    "icon_chat": chat,
    "icon_todos": todo,
    "icon_timer": timer,
    "icon_alarm": alarm,
    "icon_bell": bell,
}

# Five-column, seven-row glyphs. Rows are read left-to-right; the leftmost
# pixel is bit 4. Character order is exported alongside the C table.
FONT_CHARS = "0123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ-."
FONT_ROWS = {
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11110", "00001", "00001", "01110", "00001", "00001", "11110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "10000", "11110", "00001", "00001", "11110"),
    "6": ("01110", "10000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00001", "01110"),
    ":": ("00000", "00100", "00100", "00000", "00100", "00100", "00000"),
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01111", "10000", "10000", "10000", "10000", "10000", "01111"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01111", "10000", "10000", "10111", "10001", "10001", "01111"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("01110", "00100", "00100", "00100", "00100", "00100", "01110"),
    "J": ("00111", "00010", "00010", "00010", "00010", "10010", "01100"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "10101", "01010"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    ".": ("00000", "00000", "00000", "00000", "00000", "00110", "00110"),
}


def png_chunk(kind: bytes, data: bytes) -> bytes:
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def write_png(path: Path, pixels: list[list[tuple[int, int, int, int]]]) -> None:
    height, width = len(pixels), len(pixels[0])
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # PNG filter: none
        for rgba in row:
            raw.extend(rgba)
    png = (b"\x89PNG\r\n\x1a\n"
           + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
           + png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + png_chunk(b"IEND", b""))
    path.write_bytes(png)


def montage(items: list[tuple[str, list[list[tuple[int, int, int, int]]]]]) -> list[list[tuple[int, int, int, int]]]:
    # 4 columns, transparent sprite panels on a checkerless white canvas.
    cell_w, cell_h = 64, 76
    cols = 4
    rows = math.ceil(len(items) / cols)
    canvas = [[(245, 245, 245, 255) for _ in range(cell_w * cols)]
              for _ in range(cell_h * rows)]
    for index, (_, sprite) in enumerate(items):
        ox = (index % cols) * cell_w + 8
        oy = (index // cols) * cell_h + 8
        preview_scale = 2
        for y, row in enumerate(sprite):
            for x, px in enumerate(row):
                if px[3]:
                    for dy in range(preview_scale):
                        for dx in range(preview_scale):
                            canvas[oy + y * preview_scale + dy][ox + x * preview_scale + dx] = px
        label = {
            "icon_calendar": "CAL",
            "icon_weather": "WX",
            "icon_robot": "ROBOT",
            "icon_chat": "CHAT",
            "icon_todos": "TODOS",
            "icon_timer": "TIMER",
            "icon_alarm": "ALARM",
            "icon_bell": "BELL",
        }[items[index][0]]
        text_w = len(label) * 6 - 1
        label_x = (index % cols) * cell_w + max(2, (cell_w - text_w) // 2)
        label_y = (index // cols) * cell_h + 61
        for char_index, char in enumerate(label):
            for gy, bits in enumerate(FONT_ROWS[char]):
                for gx, bit in enumerate(bits):
                    if bit == "1":
                        canvas[label_y + gy][label_x + char_index * 6 + gx] = BLACK
    return canvas


def write_font_header(path: Path) -> None:
    rows = []
    for char in FONT_CHARS:
        rows.append("    {" + ", ".join(
            str(int(row, 2)) for row in FONT_ROWS[char]) + "},")
    lines = [
        "/* Generated by scripts/generate_dashboard_icons.py. */",
        "#ifndef DASHBOARD_PIXEL_FONT_5X7_H",
        "#define DASHBOARD_PIXEL_FONT_5X7_H",
        "#include <stdint.h>",
        f'#define DASH_PIXEL_FONT_CHARS "{FONT_CHARS}" /* row-major glyph map; each row uses bit 4 as the leftmost pixel */',
        "#define DASH_PIXEL_FONT_COUNT (sizeof(DASH_PIXEL_FONT_CHARS) - 1)",
        "#define DASH_PIXEL_FONT_WIDTH 5",
        "#define DASH_PIXEL_FONT_HEIGHT 7",
        "static const uint8_t DASH_PIXEL_FONT_5X7[][7] = {",
        *rows,
        "};",
        "#endif",
        "",
    ]
    path.write_text("\n".join(lines), encoding="ascii")


def font_atlas() -> list[list[tuple[int, int, int, int]]]:
    cell_w, cell_h = 7, 9
    cols = 10
    rows = math.ceil(len(FONT_CHARS) / cols)
    atlas = [[TRANSPARENT for _ in range(cols * cell_w)]
             for _ in range(rows * cell_h)]
    for index, char in enumerate(FONT_CHARS):
        ox = (index % cols) * cell_w
        oy = (index // cols) * cell_h
        for y, row in enumerate(FONT_ROWS[char]):
            for x, pixel in enumerate(row):
                if pixel == "1":
                    atlas[oy + y][ox + x] = BLACK
    return atlas


def crop_transparent_margin(pixels: list[list[tuple[int, int, int, int]]], margin: int = 2) -> list[list[tuple[int, int, int, int]]]:
    """Remove a fully transparent inset while preserving the source pixels."""
    return [row[margin:-margin] for row in pixels[margin:-margin]]


def smiley() -> Canvas:
    c = Canvas()
    c.ring(2, 2, 20, 20, 2)
    c.rect(7, 7, 2, 4)
    c.rect(15, 7, 2, 4)
    c.rect(6, 13, 2, 3)
    c.rect(16, 13, 2, 3)
    c.rect(8, 15, 2, 2)
    c.rect(14, 15, 2, 2)
    c.rect(10, 17, 4, 2)
    return c


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    write_png(OUT / "menu_smiley.png", smiley().scaled())
    rendered = []
    for name, draw in ICONS.items():
        pixels = draw().scaled()
        write_png(OUT / f"{name}.png", pixels)
        rendered.append((name, pixels))
        if name in {"icon_timer", "icon_alarm", "icon_bell", "icon_todos"}:
            small = crop_transparent_margin(pixels, 2)
            write_png(OUT / f"{name}_small.png", small)
    write_png(OUT / "dashboard-icons-preview.png", montage(rendered))
    write_png(OUT / "pixel-font-5x7-atlas.png", font_atlas())
    write_font_header(OUT / "pixel-font-5x7.h")
    print(f"Generated {len(rendered)} 24x24 dashboard sprites, font atlas, and preview in {OUT}")


if __name__ == "__main__":
    main()
