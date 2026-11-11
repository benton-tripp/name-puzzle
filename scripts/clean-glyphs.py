#!/usr/bin/env python3
"""Build fixed, equal-area v2 glyphs without runtime font dependencies.

Rectilinear letters are fitted with complete rectangular strokes. Other
letters receive a bounded number of area-preserving boundary swaps. A swap
must preserve connected ink, open counters, bounds, and the reference shape.
Only the Python standard library is required. Optional PNG previews use PIL.
"""

from pathlib import Path
import argparse
import json
import math


ROOT = Path(__file__).resolve().parents[1]
ORTHOGONAL = 'EFHILT'
DIRECTIONS = ((1, 0), (-1, 0), (0, 1), (0, -1))


def decode(record):
    width, height, packed = record
    data = bytes.fromhex(packed)
    return {(i % width, i // width) for i in range(width * height)
            if data[i // 8] >> (i % 8) & 1}


def encode(cells, width, height):
    data = bytearray((width * height + 7) // 8)
    for x, y in cells:
        index = y * width + x
        data[index // 8] |= 1 << (index % 8)
    return [width, height, data.hex()]


def rectangle(x, y, width, height):
    return {(xx, yy) for yy in range(y, y + height) for xx in range(x, x + width)}


def components(cells, diagonal=False):
    unseen = set(cells)
    result = []
    steps = DIRECTIONS + ((1, 1), (1, -1), (-1, 1), (-1, -1)) if diagonal else DIRECTIONS
    while unseen:
        start = min(unseen, key=lambda p: (p[1], p[0]))
        unseen.remove(start)
        group = {start}
        queue = [start]
        for x, y in queue:
            for dx, dy in steps:
                point = (x + dx, y + dy)
                if point in unseen:
                    unseen.remove(point)
                    group.add(point)
                    queue.append(point)
        result.append(group)
    return result


def holes(cells, width, height):
    background = {(x, y) for y in range(-1, height + 1) for x in range(-1, width + 1)} - cells
    return [group for group in components(background, diagonal=True) if (-1, -1) not in group]


def bounds_match(cells, width, height):
    return (min(x for x, _ in cells) == 0 and max(x for x, _ in cells) == width - 1
            and min(y for _, y in cells) == 0 and max(y for _, y in cells) == height - 1)


def perimeter(cells):
    return sum((x + dx, y + dy) not in cells for x, y in cells for dx, dy in DIRECTIONS)


def defects(cells, width, height, counter_cells=None):
    """Count one-cell tips and one-cell notches, excluding counter interiors."""
    if counter_cells is None:
        counter_cells = set().union(*holes(cells, width, height)) if cells else set()
    tips = sum(sum((x + dx, y + dy) in cells for dx, dy in DIRECTIONS) == 1 for x, y in cells)
    notches = sum(sum((x + dx, y + dy) in cells for dx, dy in DIRECTIONS) >= 3
                  for y in range(height) for x in range(width)
                  if (x, y) not in cells and (x, y) not in counter_cells)
    return {'tips': tips, 'notches': notches, 'total': tips + notches}


def scaled_reference(cells, old_width, width, height):
    return {(x, y) for y in range(height) for x in range(width)
            if (min(old_width - 1, int((x + 0.5) * old_width / width)), y) in cells}


def clean_bars(letter, original, old_width, height, area):
    best = None
    width_min = max(4, math.floor(old_width * 0.72))
    width_max = max(old_width + 4, math.ceil(old_width * 1.6))
    for width in range(width_min, width_max + 1):
        reference = scaled_reference(original, old_width, width, height)

        def consider(cells, stroke_cost, description):
            nonlocal best
            if len(cells) != area or not bounds_match(cells, width, height):
                return
            mismatch = len(cells ^ reference) / area
            score = mismatch * 2 + abs(math.log(width / old_width)) * 0.9 + stroke_cost
            candidate = (score, width, description, cells)
            if best is None or candidate[:3] < best[:3]:
                best = candidate

        for stem in range(1, min(width - 2, area // height) + 1):
            if letter in 'LT':
                extra = area - stem * height
                if extra <= 0 or extra % (width - stem):
                    continue
                bar = extra // (width - stem)
                if not 2 <= bar <= height // 3:
                    continue
                stem_x = 0 if letter == 'L' else (width - stem) // 2
                bar_y = height - bar if letter == 'L' else 0
                cells = rectangle(stem_x, 0, stem, height) | rectangle(0, bar_y, width, bar)
                consider(cells, 0.06 * abs(stem - bar), f'{letter}:{stem}:{bar}')
            elif letter == 'I':
                extra = area - stem * height
                if extra <= 0 or extra % (width - stem):
                    continue
                caps = extra // (width - stem)
                top, bottom = caps // 2, caps - caps // 2
                if not (2 <= top <= height // 4 and 2 <= bottom <= height // 4 and height - caps >= height / 2):
                    continue
                stem_x = (width - stem) // 2
                cells = rectangle(stem_x, 0, stem, height) | rectangle(0, 0, width, top) | rectangle(0, height - bottom, width, bottom)
                consider(cells, 0.04 * abs(stem - (top + bottom) / 2) + 0.03 * abs(top - bottom), f'I:{stem}:{top}:{bottom}')
            elif letter == 'H':
                for right in range(max(1, stem - 1), stem + 2):
                    gap = width - stem - right
                    extra = area - (stem + right) * height
                    if gap < 2 or extra <= 0 or extra % gap:
                        continue
                    bar = extra // gap
                    if not 2 <= bar <= height * 0.4:
                        continue
                    y = (height - bar) // 2
                    cells = rectangle(0, 0, stem, height) | rectangle(width - right, 0, right, height) | rectangle(0, y, width, bar)
                    consider(cells, 0.08 * abs(stem - right) + 0.035 * abs(bar - (stem + right) / 2), f'H:{stem}:{right}:{bar}')
            else:
                for top in range(2, height // 3 + 1):
                    for middle in range(max(2, top - 1), top + 2):
                        bottoms = range(max(2, top - 1), top + 2) if letter == 'E' else (0,)
                        for bottom in bottoms:
                            extra = area - stem * height - (width - stem) * (top + bottom)
                            if extra <= 0 or extra % middle:
                                continue
                            mid_width = stem + extra // middle
                            mid_y = (height - middle) // 2
                            if not (stem + 2 <= mid_width <= width and mid_y - top >= 2 and height - bottom - mid_y - middle >= 2):
                                continue
                            cells = rectangle(0, 0, stem, height) | rectangle(0, 0, width, top) | rectangle(0, mid_y, mid_width, middle)
                            if bottom:
                                cells |= rectangle(0, height - bottom, width, bottom)
                            bar_mean = (top + middle + bottom) / (3 if bottom else 2)
                            consistency = 0.03 * abs(stem - bar_mean) + 0.035 * (abs(top - middle) + (abs(top - bottom) if bottom else 0))
                            consider(cells, consistency, f'{letter}:{stem}:{top}:{middle}:{bottom}:{mid_width}')
    if best is None:
        return original, old_width, 'unchanged'
    return best[3], best[1], best[2]


def cleanup_boundary(original, width, height, letter):
    """Conservative swaps: reduce exposed edge length, preserve each counter."""
    cells = set(original)
    original_holes = holes(original, width, height)
    protected = set().union(*original_holes)
    current_defects = defects(cells, width, height, protected)['total']
    if current_defects == 0:
        return cells
    budget = max(1, min(8, len(original) // 35))
    initial_center = (sum(x for x, _ in original), sum(y for _, y in original))
    for _ in range(budget):
        removals = []
        additions = []
        for y in range(height):
            for x in range(width):
                point = (x, y)
                count = sum((x + dx, y + dy) in cells for dx, dy in DIRECTIONS)
                if point in cells and count <= 2:
                    if count == 1 and letter in 'AKMNVWXYZ':
                        continue
                    removals.append((2 * count - 4, y, x))
                elif point not in cells and point not in protected and count >= 2:
                    if count == 3:
                        opening = next((x + dx, y + dy) for dx, dy in DIRECTIONS if (x + dx, y + dy) not in cells)
                        if sum((opening[0] + dx, opening[1] + dy) in cells for dx, dy in DIRECTIONS) >= 2:
                            continue
                    additions.append((4 - 2 * count, y, x))
        candidates = []
        for remove_cost, ry, rx in removals:
            for add_cost, ay, ax in additions:
                adjacent = abs(rx - ax) + abs(ry - ay) == 1
                edge_change = remove_cost + add_cost + 4 * adjacent
                if edge_change >= 0:
                    continue
                remove, add = (rx, ry), (ax, ay)
                difference_change = (1 if remove in original else -1) + (-1 if add in original else 1)
                distance = abs(rx - ax) + abs(ry - ay)
                score = edge_change * 5 + difference_change + distance * 0.025
                candidates.append((score, ry, rx, ay, ax))
        candidates.sort()
        changed = False
        for _, ry, rx, ay, ax in candidates[:120]:
            candidate = cells - {(rx, ry)} | {(ax, ay)}
            if not bounds_match(candidate, width, height) or len(components(candidate)) != 1:
                continue
            new_holes = holes(candidate, width, height)
            if len(new_holes) != len(original_holes) or any(not any(seed in hole for hole in new_holes) for seed in protected):
                continue
            candidate_defects = defects(candidate, width, height, set().union(*new_holes))['total']
            if candidate_defects >= current_defects:
                continue
            center = (sum(x for x, _ in candidate), sum(y for _, y in candidate))
            if abs(center[0] - initial_center[0]) > len(original) * 0.04 or abs(center[1] - initial_center[1]) > len(original) * 0.04:
                continue
            cells = candidate
            current_defects = candidate_defects
            changed = True
            break
        if not changed or current_defects == 0:
            break
    return cells


def render_comparison(before, after, destination, area=105):
    examples = ['MAYA', 'LOVE', 'HOME', 'IHEFLT', 'BCDGOPQR', 'AVWXYZ']
    cell = 8
    row_height = 220
    half_width = max(sum(table[str(area)][letter][0] + 3 for letter in word) * cell
                     for table in (before, after) for word in examples) + 56
    right_origin = half_width + 28
    width = half_width * 2
    height = 80 + row_height * len(examples)
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">', '<rect width="100%" height="100%" fill="#f8f7f2"/>', '<g font-family="sans-serif" fill="#253b33">', '<text x="28" y="32" font-size="22">105-Cell Glyphs: Legacy and Cleaned</text>', '<text x="28" y="58" font-size="14">Legacy</text>', f'<text x="{right_origin}" y="58" font-size="14">Cleaned</text>']
    for row, word in enumerate(examples):
        y = 85 + row * row_height
        for table, origin in [(before, 28), (after, right_origin)]:
            x = origin
            for letter in word:
                record = table[str(area)][letter]
                w, h, _ = record
                for cx, cy in sorted(decode(record)):
                    svg.append(f'<rect x="{x + cx * cell}" y="{y + cy * cell}" width="{cell}" height="{cell}" fill="#253b33"/>')
                x += (w + 3) * cell
            svg.append(f'<text x="{origin}" y="{y + 180}" font-size="14">{word}</text>')
    svg.extend(['</g>', '</svg>'])
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'glyphs-105-before-after.svg').write_text('\n'.join(svg) + '\n')
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return
    image = Image.new('RGB', (width, height), '#f8f7f2')
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.truetype('DejaVuSans.ttf', 18)
    except OSError:
        font = ImageFont.load_default()
    draw.text((28, 20), '105-Cell Glyphs: Legacy and Cleaned', fill='#253b33', font=font)
    draw.text((28, 52), 'Legacy', fill='#616b63', font=font)
    draw.text((right_origin, 52), 'Cleaned', fill='#616b63', font=font)
    for row, word in enumerate(examples):
        y = 85 + row * row_height
        for table, origin in [(before, 28), (after, right_origin)]:
            x = origin
            for letter in word:
                record = table[str(area)][letter]
                w, h, _ = record
                for cx, cy in decode(record):
                    draw.rectangle((x + cx * cell, y + cy * cell, x + (cx + 1) * cell - 1, y + (cy + 1) * cell - 1), fill='#253b33')
                x += (w + 3) * cell
            draw.text((origin, y + 180), word, fill='#616b63', font=font)
    image.save(destination / 'glyphs-105-before-after.png')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'src/glyphs-v2.js')
    parser.add_argument('--report-dir', type=Path)
    args = parser.parse_args()
    source = (ROOT / 'src/glyphs.js').read_text()
    before = json.loads(source.split('export const GLYPHS = ', 1)[1].strip().removesuffix(';'))
    after = {}
    records = []
    for area, alphabet in before.items():
        after[area] = {}
        for letter, record in alphabet.items():
            width, height, _ = record
            original = decode(record)
            left = min(x for x, _ in original)
            working_width = max(x for x, _ in original) - left + 1
            working = {(x - left, y) for x, y in original}
            if letter in ORTHOGONAL:
                cleaned, new_width, method = clean_bars(letter, working, working_width, height, int(area))
            else:
                cleaned = cleanup_boundary(working, working_width, height, letter)
                new_width, method = working_width, 'boundary swaps'
            assert len(cleaned) == int(area)
            assert len(components(cleaned)) == 1, (area, letter, 'disconnected')
            assert len(holes(cleaned, new_width, height)) == len(holes(original, width, height)), (area, letter, 'counter count')
            assert bounds_match(cleaned, new_width, height), (area, letter, 'bounds')
            after[area][letter] = encode(cleaned, new_width, height)
            records.append({'area': int(area), 'letter': letter, 'method': method, 'oldWidth': width, 'newWidth': new_width, 'height': height, 'before': {**defects(original, width, height), 'perimeter': perimeter(original)}, 'after': {**defects(cleaned, new_width, height), 'perimeter': perimeter(cleaned)}})
    license_header = source.split('export const GLYPHS = ', 1)[0].replace('Glyph name: Name Puzzle Grid.', 'Glyph name: Name Puzzle Grid Two.')
    args.out.write_text(license_header + '// Generated by scripts/clean-glyphs.py. Do not edit bitmap data by hand.\nexport const GLYPHS_V2 = ' + json.dumps(after, separators=(',', ':')) + ';\n')
    summary = {'glyphs': len(records), 'beforeDefects': sum(item['before']['total'] for item in records), 'afterDefects': sum(item['after']['total'] for item in records), 'beforePerimeter': sum(item['before']['perimeter'] for item in records), 'afterPerimeter': sum(item['after']['perimeter'] for item in records), 'records': records}
    if args.report_dir:
        args.report_dir.mkdir(parents=True, exist_ok=True)
        (args.report_dir / 'glyph-cleanup-metrics.json').write_text(json.dumps(summary, indent=2) + '\n')
        render_comparison(before, after, args.report_dir)
    print(json.dumps({key: value for key, value in summary.items() if key != 'records'}))
    print(json.dumps([item for item in records if item['area'] == 105], indent=2))


if __name__ == '__main__':
    main()
