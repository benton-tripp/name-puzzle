#!/usr/bin/env python3
"""Build fixed digits and symbols for version 4.

Letters retain the version 3 catalogue. The undotted zero comes from DejaVu
Sans Bold; the other additions use DejaVu Sans Mono Bold. All use the stored
Mono font height and baseline. No boundary cells are edited to match area.
"""

from collections import Counter
from fractions import Fraction
from pathlib import Path
import argparse
import base64
import hashlib
import importlib.util
import json
import re
import time

import PIL
from PIL import Image, ImageDraw, ImageFont, features


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('font_builder_v3', ROOT / 'scripts/build-glyphs.py')
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)
ZERO_FONT_PATH = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
ZERO_FONT_SHA256 = 'a4c5bc453ca281d90ea079e596da7ae0dfeb5777497c29ec254e76d97ff6f890'
CHARACTERS = '0123456789-+&'
COUNTERS = {'0': 1, '4': 1, '6': 1, '8': 2, '9': 1, '&': 1}


def topology_valid(cells, width, height, character):
    if not cells or BASE.component_count(cells, BASE.FOUR) != 1:
        return False
    empty = {(x, y) for y in range(-1, height + 1)
             for x in range(-1, width + 1)} - cells
    return BASE.component_count(empty, BASE.EIGHT) - 1 == COUNTERS.get(character, 0)


def build_families(font_path, zero_font_path):
    table = {}
    provenance = {}
    stats = Counter()
    started = time.perf_counter()
    for size in BASE.FONT_SIZES:
        mono = ImageFont.truetype(str(font_path), size)
        zero = ImageFont.truetype(str(zero_font_path), size)
        boxes = {letter: mono.getbbox(letter, anchor='ls') for letter in BASE.LETTERS}
        top = min(box[1] for box in boxes.values())
        bottom = max(box[3] for box in boxes.values())
        height = bottom - top
        family = {'height': height, 'capHeight': boxes['H'][3] - boxes['H'][1],
                  'baseline': -top, 'glyphs': {}}
        provenance[size] = {}
        for character in CHARACTERS:
            font = zero if character == '0' else mono
            box = font.getbbox(character, anchor='ls')
            if box[1] < top or box[3] > bottom:
                raise ValueError(f'{character} exceeds the stored font canvas at size {size}.')
            original = Image.new('L', (box[2] - box[0], height))
            ImageDraw.Draw(original).text((-box[0], -top), character, anchor='ls', font=font, fill=255)
            ink = original.getbbox()
            source = original.crop((ink[0], 0, ink[2], height))
            normal_width = source.width
            widths = sorted({round(normal_width * factor) for factor in BASE.WIDTH_FACTORS})
            best = {}
            for resampled_width in widths:
                if abs(Fraction(resampled_width, normal_width) - 1) > Fraction(1, 10):
                    continue
                pixels = list(source.resize((resampled_width, height),
                                            Image.Resampling.LANCZOS).get_flattened_data())
                for threshold in BASE.THRESHOLDS:
                    stats['rawCandidates'] += 1
                    cells = {(index % resampled_width, index // resampled_width)
                             for index, value in enumerate(pixels) if value >= threshold}
                    if not topology_valid(cells, resampled_width, height, character):
                        stats['rejectedTopology'] += 1
                        continue
                    if BASE.straight_boundary_breaks(cells):
                        stats['rejectedContour'] += 1
                        continue
                    stats['cleanCandidates'] += 1
                    area = len(cells)
                    cost = Fraction(100 * (resampled_width - normal_width) ** 2, normal_width ** 2)
                    cost += Fraction((threshold - 128) ** 2, 10240)
                    key = (cost, abs(threshold - 128), resampled_width, threshold)
                    if area in best and key >= best[area][0]:
                        continue
                    width, packed = BASE.trim_and_pack(cells, height)
                    record = [width, area, round(cost * BASE.COST_SCALE), packed]
                    detail = {'font': 'sans-bold' if character == '0' else 'sans-mono-bold',
                              'sourceWidth': normal_width, 'resampledWidth': resampled_width,
                              'threshold': threshold, 'trimmedWidth': width, 'area': area}
                    best[area] = key, record, detail
            if not best:
                raise ValueError(f'No valid variants for {character} at font size {size}.')
            selected = sorted(best.values(), key=lambda item: (item[0], item[1][1]))
            family['glyphs'][character] = [item[1] for item in selected]
            provenance[size][character] = [item[2] for item in selected]
            stats['packedVariants'] += len(selected)
        table[size] = family
        if size % 10 == 0:
            print(f'Built through font size {size} in {time.perf_counter() - started:.1f}s.', flush=True)
    return table, provenance, dict(stats)


def javascript_module(raw):
    source = (ROOT / 'src/glyphs-v3.js').read_text()
    header = source[:source.index('*/') + 2]
    header = header.replace('derived from DejaVu Sans Mono Bold.',
                            'derived from DejaVu Sans Mono Bold and DejaVu Sans Bold.')
    header = re.sub(r'^Glyph name:.*$', 'Glyph name: Word Puzzle Symbols.', header, flags=re.MULTILINE)
    encoded = base64.b64encode(BASE.compressed_data(raw)).decode('ascii')
    loader = """

// Generated by scripts/build-glyphs-v4.py. Costs use a scale of 10000.
// Digits and symbols extend the frozen version 3 letter catalogue.
// Zero uses the companion Sans Bold outline without a detached center dot.
async function decodeFont(data) {
  const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

export const FONT_V4_EXTRA = await decodeFont('"""
    return header + loader + encoded + "');\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font', type=Path, default=BASE.FONT_PATH)
    parser.add_argument('--zero-font', type=Path, default=ZERO_FONT_PATH)
    parser.add_argument('--out', type=Path, default=ROOT / 'src/glyphs-v4-extra.js')
    parser.add_argument('--report-dir', type=Path)
    args = parser.parse_args()
    for path, expected in [(args.font, BASE.FONT_SHA256), (args.zero_font, ZERO_FONT_SHA256)]:
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            parser.error(f'The font file differs from the pinned source: {path.name}.')
    if PIL.__version__ != BASE.PILLOW_VERSION or features.version('freetype2') != BASE.FREETYPE_VERSION:
        parser.error(f'Regeneration requires Pillow {BASE.PILLOW_VERSION} with FreeType {BASE.FREETYPE_VERSION}.')
    table, provenance, stats = build_families(args.font, args.zero_font)
    raw = json.dumps(table, separators=(',', ':')).encode()
    output = javascript_module(raw)
    args.out.write_text(output)
    summary = {'monoFontSHA256': BASE.FONT_SHA256, 'zeroFontSHA256': ZERO_FONT_SHA256,
               'pillow': BASE.PILLOW_VERSION, 'freeType': BASE.FREETYPE_VERSION,
               'characters': CHARACTERS, 'fontSizes': [min(BASE.FONT_SIZES), max(BASE.FONT_SIZES)],
               **stats, 'jsonBytes': len(raw), 'moduleBytes': len(output.encode()),
               'jsonSHA256': hashlib.sha256(raw).hexdigest(),
               'moduleSHA256': hashlib.sha256(output.encode()).hexdigest()}
    if args.report_dir:
        args.report_dir.mkdir(parents=True, exist_ok=True)
        (args.report_dir / 'font-v4-provenance.json').write_text(json.dumps(provenance, separators=(',', ':')))
        (args.report_dir / 'font-v4-build.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == '__main__':
    main()
