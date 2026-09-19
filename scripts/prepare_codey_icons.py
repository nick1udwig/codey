#!/usr/bin/env python3
"""Resize supplied Codey artwork for Pebble (requires Pillow)."""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

# The launcher uses the supplied blue smiling mascot, centered in a 24x24 icon.
source = Image.open(ROOT / 'assets/codey-smile-blue-144.png').convert('RGBA')
source = source.crop(source.getbbox())
source.thumbnail((24, 24), Image.Resampling.NEAREST)
menu_icon = Image.new('RGBA', (24, 24))
menu_icon.paste(source, ((24 - source.width) // 2, (24 - source.height) // 2))
menu_icon.save(ROOT / 'resources/images/menu_smiley.png')

for state in ('sleep', 'think'):
    source = Image.open(ROOT / f'assets/codey-{state}-144.png').convert('RGBA')
    source = source.crop(source.getbbox())
    for variant, bounds in [('emery', (82, 74)), ('gabbro', (74, 59)), ('small', (20, 20))]:
        sprite = source.copy()
        sprite.thumbnail(bounds, Image.Resampling.NEAREST)
        # Bound the palette so decoded sprites fit the watch heap.
        sprite = sprite.quantize(colors=8, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
        sprite.save(ROOT / f'resources/images/codey_{state}_{variant}.png')
