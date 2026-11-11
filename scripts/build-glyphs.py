#!/usr/bin/env python3
"""Build fixed, naturally proportioned version 3 font families.

Pillow and the pinned DejaVu Sans Mono Bold font are required only offline.
The browser receives compressed bitmap data and does not load a font file.
Candidates are rejected for topology or isolated straight-edge defects.
No boundary cells are added or removed to achieve a desired area.
"""

from collections import Counter
from fractions import Fraction
from pathlib import Path
import argparse
import base64
import gzip
import hashlib
import io
import json
import re
import string
import time

import PIL
from PIL import Image, ImageDraw, ImageFont, features


ROOT = Path(__file__).resolve().parents[1]
FONT_PATH = Path('/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf')
FONT_SHA256 = '0d3c03d1b667192f91223660a3163325cf83132662fe4d9f7d6e596bf7a995c2'
PILLOW_VERSION = '13.0.0'
FREETYPE_VERSION = '2.14.3'
FONT_SIZES = range(18, 69)
THRESHOLDS = (64, 80, 96, 112, 128, 144, 160, 176, 192)
WIDTH_FACTORS = (Fraction(93, 100), Fraction(1), Fraction(107, 100))
COST_SCALE = 10000
LETTERS = string.ascii_uppercase
EXPECTED_COUNTERS = {'A': 1, 'B': 2, 'D': 1, 'O': 1, 'P': 1, 'Q': 1, 'R': 1}
FOUR = ((1, 0), (0, 1), (-1, 0), (0, -1))
EIGHT = tuple((x, y) for x in (-1, 0, 1) for y in (-1, 0, 1) if x or y)


def component_count(cells, steps):
    remaining = set(cells)
    count = 0
    while remaining:
        count += 1
        queue = [remaining.pop()]
        for x, y in queue:
            for dx, dy in steps:
                point = x + dx, y + dy
                if point in remaining:
                    remaining.remove(point)
                    queue.append(point)
    return count


def topology_valid(cells, width, height, letter):
    if not cells or component_count(cells, FOUR) != 1:
        return False
    empty = {(x, y) for y in range(-1, height + 1)
             for x in range(-1, width + 1)} - cells
    return component_count(empty, EIGHT) - 1 == EXPECTED_COUNTERS.get(letter, 0)


def straight_boundary_breaks(cells):
    """Reject a one-cell tip/notch with two flat neighbors on each side."""
    empty_neighbors = Counter()
    tips = []
    for x, y in cells:
        occupied = []
        for dx, dy in FOUR:
            point = x + dx, y + dy
            if point in cells:
                occupied.append((dx, dy))
            else:
                empty_neighbors[point] += 1
        if len(occupied) == 1:
            tips.append((x, y, -occupied[0][0], -occupied[0][1]))
    for (x, y), count in empty_neighbors.items():
        if count != 3:
            continue
        dx, dy = next((dx, dy) for dx, dy in FOUR
                      if (x + dx, y + dy) not in cells)
        tx, ty = -dy, dx
        if all((x + step * tx, y + step * ty) in cells
               and (x + step * tx + dx, y + step * ty + dy) not in cells
               for step in (-2, -1, 1, 2)):
            return True
    for x, y, dx, dy in tips:
        tx, ty = -dy, dx
        if all((x + step * tx, y + step * ty) not in cells
               and (x + step * tx - dx, y + step * ty - dy) in cells
               for step in (-2, -1, 1, 2)):
            return True
    return False


def trim_and_pack(cells, height):
    left = min(x for x, _ in cells)
    width = max(x for x, _ in cells) - left + 1
    packed = bytearray((width * height + 7) // 8)
    for x, y in cells:
        bit = y * width + x - left
        packed[bit // 8] |= 1 << (bit % 8)
    return width, packed.hex()


def build_families(font_path):
    table = {}
    provenance = {}
    stats = Counter()
    started = time.perf_counter()
    for size in FONT_SIZES:
        font = ImageFont.truetype(str(font_path), size)
        boxes = {letter: font.getbbox(letter, anchor='ls') for letter in LETTERS}
        top = min(box[1] for box in boxes.values())
        bottom = max(box[3] for box in boxes.values())
        height = bottom - top
        family = {'height': height, 'capHeight': boxes['H'][3] - boxes['H'][1],
                  'baseline': -top, 'glyphs': {}}
        provenance[size] = {}
        for letter, box in boxes.items():
            original = Image.new('L', (box[2] - box[0], height))
            ImageDraw.Draw(original).text((-box[0], -top), letter, anchor='ls',
                                         font=font, fill=255)
            ink = original.getbbox()
            source = original.crop((ink[0], 0, ink[2], height))
            normal_width = source.width
            widths = sorted({round(normal_width * factor) for factor in WIDTH_FACTORS})
            best = {}
            for resampled_width in widths:
                if abs(Fraction(resampled_width, normal_width) - 1) > Fraction(1, 10):
                    continue
                pixels = list(source.resize((resampled_width, height),
                                            Image.Resampling.LANCZOS).get_flattened_data())
                for threshold in THRESHOLDS:
                    stats['rawCandidates'] += 1
                    cells = {(index % resampled_width, index // resampled_width)
                             for index, value in enumerate(pixels) if value >= threshold}
                    if not topology_valid(cells, resampled_width, height, letter):
                        stats['rejectedTopology'] += 1
                        continue
                    if straight_boundary_breaks(cells):
                        stats['rejectedContour'] += 1
                        continue
                    stats['cleanCandidates'] += 1
                    area = len(cells)
                    cost = Fraction(100 * (resampled_width - normal_width) ** 2,
                                    normal_width ** 2)
                    cost += Fraction((threshold - 128) ** 2, 10240)
                    key = (cost, abs(threshold - 128), resampled_width, threshold)
                    if area in best and key >= best[area][0]:
                        continue
                    width, packed = trim_and_pack(cells, height)
                    record = [width, area, round(cost * COST_SCALE), packed]
                    detail = {'sourceWidth': normal_width, 'resampledWidth': resampled_width,
                              'threshold': threshold, 'trimmedWidth': width, 'area': area}
                    best[area] = key, record, detail
            if not best:
                raise ValueError(f'No valid variants for {letter} at font size {size}.')
            selected = sorted(best.values(), key=lambda item: (item[0], item[1][1]))
            family['glyphs'][letter] = [item[1] for item in selected]
            provenance[size][letter] = [item[2] for item in selected]
            stats['packedVariants'] += len(selected)
        table[size] = family
        if size % 10 == 0:
            print(f'Built through font size {size} in {time.perf_counter() - started:.1f}s.', flush=True)
    return table, provenance, dict(stats)


def compressed_data(raw):
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, filename='', mode='wb', compresslevel=9, mtime=0) as stream:
        stream.write(raw)
    return buffer.getvalue()


def javascript_module(raw, license_source):
    source = license_source.read_text()
    header = source[:source.index('*/') + 2]
    header = header.replace('DejaVu Sans Bold.', 'DejaVu Sans Mono Bold.')
    header = re.sub(r'^Glyph name:.*$', 'Glyph name: Name Puzzle Mono.', header, flags=re.MULTILINE)
    header = header.replace('Generated with equal occupied area per glyph; no font is loaded at runtime.',
                            'Generated from fixed font variants; no font is loaded at runtime.')
    encoded = base64.b64encode(compressed_data(raw)).decode('ascii')
    loader = """

// Generated by scripts/build-glyphs.py. Costs use a scale of 10000.
// Family: {height, capHeight, baseline, glyphs}.
// Variant: [width, occupied area, integer cost, little-endian bitmap hex].
async function decodeFont(data) {
  const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

export const FONT_V3 = await decodeFont('"""
    return header + loader + encoded + "');\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font', type=Path, default=FONT_PATH)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--json-out', type=Path)
    parser.add_argument('--report-dir', type=Path)
    parser.add_argument('--license-source', type=Path, default=ROOT / 'src/glyphs-v2.js')
    args = parser.parse_args()
    if hashlib.sha256(args.font.read_bytes()).hexdigest() != FONT_SHA256:
        parser.error('The font file differs from the pinned DejaVu Sans Mono Bold source.')
    if PIL.__version__ != PILLOW_VERSION or features.version('freetype2') != FREETYPE_VERSION:
        parser.error(f'Regeneration requires Pillow {PILLOW_VERSION} with FreeType {FREETYPE_VERSION}.')
    if not args.out and not args.json_out:
        args.out = ROOT / 'src/glyphs-v3.js'
    started = time.perf_counter()
    table, provenance, stats = build_families(args.font)
    raw = json.dumps(table, separators=(',', ':')).encode()
    compressed = compressed_data(raw)
    summary = {'fontSHA256': FONT_SHA256, 'pillow': PILLOW_VERSION, 'freeType': FREETYPE_VERSION,
               'fontSizes': [min(FONT_SIZES), max(FONT_SIZES)], 'thresholds': THRESHOLDS,
               'costScale': COST_SCALE, **stats, 'jsonBytes': len(raw), 'gzipBytes': len(compressed),
               'jsonSHA256': hashlib.sha256(raw).hexdigest()}
    if args.json_out:
        args.json_out.write_bytes(raw)
    if args.out:
        output = javascript_module(raw, args.license_source)
        args.out.write_text(output)
        summary['moduleBytes'] = len(output.encode())
        summary['moduleSHA256'] = hashlib.sha256(output.encode()).hexdigest()
    if args.report_dir:
        args.report_dir.mkdir(parents=True, exist_ok=True)
        (args.report_dir / 'font-v3-provenance.json').write_text(json.dumps(provenance, separators=(',', ':')))
        (args.report_dir / 'font-v3-build.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2), flush=True)
    print(f'Completed in {time.perf_counter() - started:.3f} seconds.', flush=True)


if __name__ == '__main__':
    main()
