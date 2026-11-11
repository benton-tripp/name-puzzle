import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { generatePuzzle, normalizeName } from '../src/engine.js';
import { GLYPHS } from '../src/glyphs.js';
import { GLYPHS_V2 } from '../src/glyphs-v2.js';
import { FONT_V3 } from '../src/glyphs-v3.js';
import { createWordTargets } from '../src/lettering.js';

const cellKey = ([x, y]) => `${x},${y}`;

function assertIntegerPoint(point, label) {
  assert.ok(Array.isArray(point) && point.length === 2, `${label}: two coordinates`);
  assert.ok(point.every(Number.isSafeInteger), `${label}: integer coordinates`);
}

function assertUniqueCells(cells, label) {
  assert.ok(Array.isArray(cells) && cells.length > 0, `${label}: nonempty cells`);
  cells.forEach((point) => assertIntegerPoint(point, label));
  const keys = new Set(cells.map(cellKey));
  assert.equal(keys.size, cells.length, `${label}: no duplicate cells`);
  return keys;
}

function assertConnected(cells, label) {
  const remaining = new Set(cells.map(cellKey));
  const pending = [cells[0]];
  remaining.delete(cellKey(cells[0]));
  while (pending.length > 0) {
    const [x, y] = pending.pop();
    for (const next of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (remaining.delete(cellKey(next))) pending.push(next);
    }
  }
  assert.equal(remaining.size, 0, `${label}: connected through shared edges`);
}

function unpackGlyph([width, height, hex]) {
  const bytes = Buffer.from(hex, 'hex');
  const cells = [];
  for (let index = 0; index < width * height; index += 1) {
    if (bytes[index >> 3] & (1 << (index & 7))) cells.push([index % width, Math.floor(index / width)]);
  }
  return cells;
}

function countGlyphCounters(record) {
  const [width, height] = record;
  const ink = new Set(unpackGlyph(record).map(cellKey));
  const remaining = new Set();
  for (let y = -1; y <= height; y += 1) {
    for (let x = -1; x <= width; x += 1) {
      const key = cellKey([x, y]);
      if (!ink.has(key)) remaining.add(key);
    }
  }

  let counters = 0;
  while (remaining.size > 0) {
    const first = remaining.values().next().value;
    const pending = [first.split(',').map(Number)];
    remaining.delete(first);
    let exterior = false;
    while (pending.length > 0) {
      const [x, y] = pending.pop();
      if (x === -1 || x === width || y === -1 || y === height) exterior = true;
      // Eight-neighbor background connectivity complements edge-connected ink.
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const next = [x + dx, y + dy];
          if (remaining.delete(cellKey(next))) pending.push(next);
        }
      }
    }
    if (!exterior) counters += 1;
  }
  return counters;
}

function countIsolatedBoundaryDefects(record) {
  const [width, height] = record;
  const ink = new Set(unpackGlyph(record).map(cellKey));
  let defects = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
        .filter((cell) => ink.has(cellKey(cell))).length;
      if (ink.has(cellKey([x, y])) ? neighbors === 1 : neighbors >= 3) defects += 1;
    }
  }
  return defects;
}

function normalizedCellSet(cells) {
  const minX = Math.min(...cells.map(([x]) => x));
  const minY = Math.min(...cells.map(([, y]) => y));
  return new Set(cells.map(([x, y]) => cellKey([x - minX, y - minY])));
}

function assertFontTarget(target, name) {
  assert.ok(target.font && Number.isSafeInteger(target.font.size), `${name}: font provenance`);
  const family = FONT_V3[target.font.size];
  assert.ok(family, `${name}: supported font family`);
  assert.equal(target.height, family.height + 2, `${name}: stored font height plus padding`);
  assert.equal(target.font.capHeight, family.capHeight);
  assert.ok(target.font.capHeight >= 15, `${name}: readable cap height`);
  assert.equal(target.font.baseline, family.baseline + 1,
    `${name}: stored baseline is translated with the font`);
  assert.equal(target.glyphs.length, name.length);
  assert.ok(target.cells.length >= 400 && target.cells.length <= 1800, `${name}: bounded word area`);
  const occupied = new Set();
  const repeated = new Map();
  let nextX = 1;

  for (const [index, glyph] of target.glyphs.entries()) {
    const label = `${name}: ${glyph.character} at ${index}`;
    assert.equal(glyph.index, index);
    assert.equal(glyph.character, name[index]);
    const options = family.glyphs[glyph.character];
    assert.ok(Number.isInteger(glyph.variantIndex) && glyph.variantIndex >= 0
      && glyph.variantIndex < options.length, `${label}: valid fixed variant`);
    const [width, area, cost, hex] = options[glyph.variantIndex];
    assert.ok(Number.isSafeInteger(cost) && cost >= 0, `${label}: integer variant cost`);
    assert.equal(glyph.width, width);
    assert.equal(glyph.area, area);
    assert.equal(glyph.cells.length, area);
    assert.equal(glyph.x, nextX, `${label}: regular inter-letter spacing`);
    assert.equal(glyph.y, 1, `${label}: common font origin`);
    const source = unpackGlyph([width, family.height, hex]);
    const expected = new Set(source.map(([x, y]) => cellKey([x + glyph.x, y + glyph.y])));
    const actual = assertUniqueCells(glyph.cells, label);
    assert.deepEqual(actual, expected, `${label}: exact translated source mask, without cell edits`);
    assertConnected(glyph.cells, label);
    for (const key of actual) {
      assert.ok(!occupied.has(key), `${label}: no overlap between glyphs`);
      occupied.add(key);
    }
    const previous = repeated.get(glyph.character);
    if (previous) {
      assert.equal(glyph.variantIndex, previous.variantIndex, `${label}: repeated variant is consistent`);
      assert.deepEqual(normalizedCellSet(glyph.cells), normalizedCellSet(previous.cells),
        `${label}: repeated shape is consistent`);
    } else repeated.set(glyph.character, glyph);
    nextX += width + 2;
  }
  assert.equal(target.width, nextX - 1, `${name}: complete word width`);
  assert.deepEqual(occupied, new Set(target.cells.map(cellKey)), `${name}: glyphs cover the target`);
}

function assertStraightLetter(glyph, label) {
  const minX = Math.min(...glyph.cells.map(([x]) => x));
  const minY = Math.min(...glyph.cells.map(([, y]) => y));
  const maxX = Math.max(...glyph.cells.map(([x]) => x));
  const maxY = Math.max(...glyph.cells.map(([, y]) => y));
  const width = maxX - minX + 1;
  const rows = Array.from({ length: maxY - minY + 1 }, () => []);
  for (const [x, y] of glyph.cells) rows[y - minY].push(x - minX);
  const groups = [];
  for (const row of rows) {
    row.sort((a, b) => a - b);
    assert.ok(row.length > 0, `${label}: continuous vertical stroke`);
    assert.deepEqual(row, Array.from({ length: row.length }, (_, x) => row[0] + x),
      `${label}: each stroke row is contiguous`);
    const previous = groups.at(-1);
    if (previous && previous.left === row[0] && previous.width === row.length) previous.rows += 1;
    else groups.push({ left: row[0], width: row.length, rows: 1 });
  }

  if (glyph.character === 'L') {
    assert.equal(groups.length, 2, `${label}: straight stem and foot, without nodules`);
    assert.ok(groups.every(group => group.left === 0));
    assert.ok(groups[0].width < width);
    assert.equal(groups[1].width, width);
  } else if (glyph.character === 'I') {
    assert.equal(groups.length, 3, `${label}: complete caps and straight stem, without stepped shoulders`);
    assert.equal(groups[0].left, 0);
    assert.equal(groups[2].left, 0);
    assert.equal(groups[0].width, width);
    assert.equal(groups[2].width, width);
    assert.equal(groups[0].rows, groups[2].rows, `${label}: matching cap thickness`);
    const stem = groups[1];
    assert.ok(stem.left > 0 && stem.left + stem.width < width, `${label}: caps project on both sides`);
    assert.ok(Math.abs(stem.left - (width - stem.left - stem.width)) <= 1,
      `${label}: centered stem`);
  } else if (glyph.character === 'E') {
    assert.equal(groups.length, 5, `${label}: three regular bars and two openings`);
    assert.ok(groups.every(group => group.left === 0), `${label}: straight outer stem`);
    assert.equal(groups[0].width, width);
    assert.equal(groups[4].width, width);
    assert.equal(groups[1].width, groups[3].width, `${label}: consistent vertical stem`);
    assert.ok(groups[2].width > groups[1].width && groups[2].width <= width);
    assert.equal(groups[0].rows, groups[2].rows, `${label}: consistent top and middle bar thickness`);
    assert.equal(groups[2].rows, groups[4].rows, `${label}: consistent middle and bottom bar thickness`);
  }
}

// Transform the four vertices, then recover the cell's top-left corner.
// This checks the pose convention independently of cell-placement formulas.
function placeCell([x, y], pose) {
  const matrices = [
    [[1, 0], [0, 1]],
    [[0, -1], [1, 0]],
    [[-1, 0], [0, -1]],
    [[0, 1], [-1, 0]],
  ];
  const matrix = matrices[pose.turn];
  const corners = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]
    .map(([vx, vy]) => [
      matrix[0][0] * vx + matrix[0][1] * vy + pose.x,
      matrix[1][0] * vx + matrix[1][1] * vy + pose.y,
    ]);
  const xs = corners.map(([vx]) => vx);
  const ys = corners.map(([, vy]) => vy);
  assert.equal(Math.max(...xs) - Math.min(...xs), 1, 'rotation preserves cell width');
  assert.equal(Math.max(...ys) - Math.min(...ys), 1, 'rotation preserves cell height');
  return [Math.min(...xs), Math.min(...ys)];
}

function assertGlyphOwnership(puzzle, owners) {
  const shared = new Set([...puzzle.first].filter((character) => puzzle.second.includes(character)));
  let sharedOccurrences = 0;

  for (const [side, name] of [['a', puzzle.first], ['b', puzzle.second]]) {
    const target = puzzle.targets[side];
    // Empty columns separate letters. Infer their cells from the target itself,
    // independently of the generator's glyph table and occurrence metadata.
    const columns = [...new Set(target.cells.map(([x]) => x))].sort((a, b) => a - b);
    const regions = [];
    for (const x of columns) {
      const previous = regions.at(-1);
      if (!previous || x > previous.end + 1) regions.push({ start: x, end: x });
      else previous.end = x;
    }
    assert.equal(regions.length, name.length, `${side}: one separated region per letter`);
    assert.ok(Array.isArray(target.glyphs), `${side}: glyph metadata is present`);
    assert.equal(target.glyphs.length, name.length, `${side}: one record per occurrence`);

    for (const [index, { start, end }] of regions.entries()) {
      const character = name[index];
      const label = `${side}: ${character} at ${index}`;
      const cells = target.cells.filter(([x]) => x >= start && x <= end);
      const metadata = target.glyphs[index];
      assertConnected(cells, label);
      assert.equal(metadata.index, index, `${label}: occurrence index`);
      assert.equal(metadata.character, character, `${label}: occurrence character`);
      assert.deepEqual(assertUniqueCells(metadata.cells, label), new Set(cells.map(cellKey)),
        `${label}: metadata matches independently inferred cells`);

      if (shared.has(character)) {
        sharedOccurrences += 1;
        const pieceOwners = new Set(cells.map((cell) => owners[side].get(cellKey(cell))));
        assert.ok(!pieceOwners.has(undefined), `${label}: every cell has an owner`);
        if (puzzle.splitSharedLetters) {
          assert.ok(pieceOwners.size >= 2, `${label}: shared letter uses at least two pieces`);
        }
      }
    }
    if (puzzle.version === 3) assertFontTarget(target, name);
  }

  assert.equal(puzzle.metrics.sharedGlyphOccurrences, sharedOccurrences);
  assert.ok(Number.isSafeInteger(puzzle.metrics.sharedLetterSplits)
    && puzzle.metrics.sharedLetterSplits >= 0);
  if (!puzzle.splitSharedLetters) assert.equal(puzzle.metrics.sharedLetterSplits, 0);
}

function assertPuzzle(puzzle, input) {
  const version = input.version ?? (input.splitSharedLetters === true ? 2 : 1);
  assert.equal(puzzle.version, version);
  if (version >= 2) {
    assert.equal(puzzle.splitSharedLetters, input.splitSharedLetters ?? false);
  } else {
    assert.ok(!Object.hasOwn(puzzle, 'splitSharedLetters'));
    assert.ok(!Object.hasOwn(puzzle.metrics, 'sharedLetterSplits'));
    assert.ok(!Object.hasOwn(puzzle.metrics, 'sharedGlyphOccurrences'));
  }
  assert.equal(puzzle.first, normalizeName(input.first));
  assert.equal(puzzle.second, normalizeName(input.second));
  assert.ok(Number.isInteger(puzzle.seed) && puzzle.seed >= 0 && puzzle.seed <= 0xffffffff);
  assert.ok(Array.isArray(puzzle.pieces) && puzzle.pieces.length > 0);
  assert.equal(new Set(puzzle.pieces.map(({ id }) => id)).size, puzzle.pieces.length,
    'piece IDs are unique');

  const targetSets = {};
  for (const side of ['a', 'b']) {
    const target = puzzle.targets[side];
    if (version === 1) assert.ok(!Object.hasOwn(target, 'glyphs'));
    assert.ok(Number.isSafeInteger(target.width) && target.width > 0);
    assert.ok(Number.isSafeInteger(target.height) && target.height > 0);
    targetSets[side] = assertUniqueCells(target.cells, `target ${side}`);
    for (const [x, y] of target.cells) {
      assert.ok(x >= 0 && x < target.width, `target ${side}: horizontal bounds`);
      assert.ok(y >= 0 && y < target.height, `target ${side}: vertical bounds`);
    }
  }
  assert.equal(targetSets.a.size, targetSets.b.size, 'targets have equal area');

  const occupied = { a: new Set(), b: new Set() };
  const owners = { a: new Map(), b: new Map() };
  let totalArea = 0;
  for (const piece of puzzle.pieces) {
    const label = `piece ${piece.id}`;
    assert.ok(typeof piece.id === 'string' || Number.isSafeInteger(piece.id),
      `${label}: stable identifier`);
    assertUniqueCells(piece.cells, label);
    assertConnected(piece.cells, label);
    assert.equal(piece.size, piece.cells.length, `${label}: reported area`);
    totalArea += piece.cells.length;

    for (const side of ['a', 'b']) {
      const pose = piece[side];
      assert.ok(Number.isSafeInteger(pose.x) && Number.isSafeInteger(pose.y),
        `${label}/${side}: integer translation`);
      assert.ok(Number.isInteger(pose.turn) && pose.turn >= 0 && pose.turn <= 3,
        `${label}/${side}: quarter-turn rotation`);
      if (side === 'a') assert.equal(pose.turn, 0, 'first target uses local orientation');

      const placedCells = piece.cells.map((cell) => placeCell(cell, pose));
      assertUniqueCells(placedCells, `${label}/${side}`);
      assertConnected(placedCells, `${label}/${side}`);
      for (const cell of placedCells) {
        const key = cellKey(cell);
        assert.ok(targetSets[side].has(key), `${label}/${side}: cell is inside target`);
        assert.ok(!occupied[side].has(key), `${label}/${side}: no overlap`);
        occupied[side].add(key);
        owners[side].set(key, piece.id);
      }
    }
  }

  assert.equal(totalArea, targetSets.a.size, 'piece area equals target area');
  assert.deepEqual(occupied.a, targetSets.a, 'first target is covered exactly');
  assert.deepEqual(occupied.b, targetSets.b, 'second target is covered exactly');
  assert.equal(puzzle.metrics.pieceCount, puzzle.pieces.length);
  assert.equal(puzzle.metrics.singletons, puzzle.pieces.filter(({ size }) => size === 1).length);
  assert.equal(puzzle.metrics.area, totalArea);
  assert.equal(puzzle.metrics.smallestPiece, Math.min(...puzzle.pieces.map(({ size }) => size)));
  assert.equal(puzzle.metrics.largestPiece, Math.max(...puzzle.pieces.map(({ size }) => size)));
  if (version >= 2) assertGlyphOwnership(puzzle, owners);
}

// Complete JSON outputs captured before the version 2 changes, from engine SHA-256
// 30c8c2320c1f3ee1460532de7e223bfedfd2e1d51ba77a5714ffc999e0886d97.
const version1Baselines = [
  [{ first: 'LOVE', second: 'HOME', seed: 1 },
    '4b1d87043e6bdfa59f79d4fe3f241de7387a4ee2740d0a2bea3195cc58293876'],
  [{ first: 'LOVE', second: 'HOME', seed: 7 },
    'ade576423456ea1d5d2295070c985f7824b702190600a6be8fad5c1bce5f8d8b'],
  [{ first: 'BENTON', second: 'TRIPP', seed: 42 },
    '5e88dd2ef25f81b768627bb53f08ed336df12d2f1587b619cdf30a16f77cbef0'],
  [{ first: 'MAYA', second: 'MAYA', seed: 9 },
    '6d5130e4d8be900e118e6613837fdf8d317103bafb6e34539570cbc610a471ab'],
  [{ first: 'ANNA', second: 'NANA', seed: 17 },
    'b4bbb4dde0f5f414057f17dc3183c647adb260cc302ac32e73861556ce858694'],
  [{ first: 'AL', second: 'JO', seed: 0 },
    '45c88cba196978ba096efd38b80b1d66210c05c37faa65bac66777c4a088a157'],
];

// Complete version 2 outputs captured before the version 3 changes.
// Engine SHA-256: 0b074ebdb50812d16e1a9d5362b8a2672bed9cbcc593e7d9cd7b6fdbe507ba5d.
const version2Baselines = [
  [{ first: 'LOVE', second: 'HOME', seed: 1, version: 2, splitSharedLetters: false },
    '60d6dedfc372ea7be9f2dfe689746ee406f1e9fbe4d4b6a2dafd672ae15c7c28'],
  [{ first: 'LOVE', second: 'HOME', seed: 1, version: 2, splitSharedLetters: true },
    '123a06b4935b8eb94a4306ba02c7b121d0c2a7105f470da221220fd140a16119'],
  [{ first: 'LILY', second: 'ELLA', seed: 7, version: 2, splitSharedLetters: false },
    'a6e64dfea3274a4e7a8184823137a1299b343942316efcc8069987916705639e'],
  [{ first: 'LILY', second: 'ELLA', seed: 7, version: 2, splitSharedLetters: true },
    '56b024121c2fa568433862a51d0bfdfec56f2fdc981d851ec2d47df8b09d509b'],
];

const jsonHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

for (const [input, expected] of version1Baselines) {
  test(`version 1 remains byte-for-byte stable: ${input.first} / ${input.second}, seed ${input.seed}`,
    () => assert.equal(jsonHash(generatePuzzle(input)), expected));
}

for (const [input, expected] of version2Baselines) {
  test(`version 2 remains byte-for-byte stable: ${input.first} / ${input.second}, split ${input.splitSharedLetters}`,
    () => assert.equal(jsonHash(generatePuzzle(input)), expected));
}

test('explicit legacy options retain the historical output', () => {
  const [input, expected] = version1Baselines[1];
  assert.equal(jsonHash(generatePuzzle({ ...input, splitSharedLetters: false })), expected);
  assert.equal(jsonHash(generatePuzzle({ ...input, version: 1, splitSharedLetters: false })), expected);
});

test('version 2 glyphs preserve exact area, connected strokes, and consistent heights', () => {
  assert.deepEqual(Object.keys(GLYPHS_V2).sort(), Object.keys(GLYPHS).sort());
  for (const [area, alphabet] of Object.entries(GLYPHS_V2)) {
    assert.deepEqual(Object.keys(alphabet).sort(), [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']);
    const heights = new Set();
    for (const [character, record] of Object.entries(alphabet)) {
      const label = `${character}, area ${area}`;
      assert.ok(Array.isArray(record) && record.length === 3, `${label}: packed record`);
      const [width, height, hex] = record;
      assert.ok(Number.isSafeInteger(width) && width > 0, `${label}: positive width`);
      assert.ok(Number.isSafeInteger(height) && height > 0, `${label}: positive height`);
      assert.match(hex, /^(?:[0-9a-f]{2})+$/i, `${label}: packed hexadecimal bytes`);
      assert.equal(hex.length, 2 * Math.ceil(width * height / 8), `${label}: packed length`);
      const cells = unpackGlyph(record);
      assert.equal(cells.length, Number(area), `${label}: exact occupied area`);
      assertConnected(cells, label);
      const xs = cells.map(([x]) => x);
      const ys = cells.map(([, y]) => y);
      assert.deepEqual([Math.min(...xs), Math.min(...ys), Math.max(...xs) + 1, Math.max(...ys) + 1],
        [0, 0, width, height], `${label}: occupied bounds match packed dimensions`);
      const columns = [...new Set(cells.map(([x]) => x))].sort((a, b) => a - b);
      assert.equal(columns.length, columns.at(-1) - columns[0] + 1,
        `${label}: no internal empty column`);
      assert.equal(countGlyphCounters(record), countGlyphCounters(GLYPHS[area][character]),
        `${label}: enclosed counters are preserved`);
      heights.add(height);
    }
    assert.equal(heights.size, 1, `area ${area}: common glyph height`);
  }
});

test('version 2 removes isolated notches and protrusions from the affected straight-stroke letters', () => {
  let legacyDefects = 0;
  let currentDefects = 0;
  for (const character of 'EFHILT') {
    const legacy = GLYPHS[105][character];
    const current = GLYPHS_V2[105][character];
    assert.equal(countGlyphCounters(legacy), 0, `${character}: legacy has no counter`);
    assert.equal(countGlyphCounters(current), 0, `${character}: no spurious counter`);
    legacyDefects += countIsolatedBoundaryDefects(legacy);
    currentDefects += countIsolatedBoundaryDefects(current);
  }
  assert.equal(currentDefects, 0, 'no isolated boundary defects in the affected letters');
  assert.ok(currentDefects < legacyDefects, 'the cleaned table improves on the legacy masks');
});

// Selected choices from the independent Python integer-DP reference.
const reviewedLettering = [
  {
    "first": "LOVE",
    "second": "HOME",
    "area": 427,
    "fontSizes": [
      23,
      22
    ],
    "variantPaths": {
      "a": [
        0,
        0,
        0,
        1
      ],
      "b": [
        0,
        0,
        0,
        1
      ]
    }
  },
  {
    "first": "BENTON",
    "second": "TRIPP",
    "area": 590,
    "fontSizes": [
      21,
      24
    ],
    "variantPaths": {
      "a": [
        0,
        0,
        3,
        0,
        0
      ],
      "b": [
        1,
        0,
        1,
        0
      ]
    }
  },
  {
    "first": "LILY",
    "second": "ELLA",
    "area": 486,
    "fontSizes": [
      28,
      26
    ],
    "variantPaths": {
      "a": [
        1,
        0,
        0
      ],
      "b": [
        0,
        0,
        0
      ]
    }
  }
];

for (const reference of reviewedLettering) {
  test(`version 3 matches reviewed fixed-font choices: ${reference.first} / ${reference.second}`, () => {
    const result = createWordTargets(reference.first, reference.second);
    assert.equal(result.area, reference.area);
    assert.deepEqual(result.metrics.fontSizes, reference.fontSizes);
    assert.equal(result.a.cells.length, result.b.cells.length, 'whole-word areas match');
    for (const [side, name] of [['a', reference.first], ['b', reference.second]]) {
      const target = result[side];
      assertFontTarget(target, name);
      assert.ok(target.mask instanceof Uint8Array, `${name}: compact occupancy mask`);
      assert.equal(target.mask.length, target.width * target.height);
      const cells = new Set(target.cells.map(cellKey));
      for (let index = 0; index < target.mask.length; index += 1) {
        const key = cellKey([index % target.width, Math.floor(index / target.width)]);
        assert.equal(target.mask[index], cells.has(key) ? 1 : 0, `${name}: mask matches cells at ${key}`);
      }
      const choices = new Map(target.glyphs.map(glyph => [glyph.character, glyph.variantIndex]));
      const variantPath = [...choices].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([, variantIndex]) => variantIndex);
      assert.deepEqual(variantPath, reference.variantPaths[side]);
      for (const glyph of target.glyphs) {
        if ('ILE'.includes(glyph.character)) assertStraightLetter(glyph, `${name}: ${glyph.character}`);
      }
    }
    if (reference.first === 'LOVE') {
      assert.ok(new Set(result.a.glyphs.map(glyph => glyph.area)).size > 1,
        'individual letters retain different natural areas');
    }
  });
}

test('version 3 lettering is deterministic for repeated letters and identical names', () => {
  const first = createWordTargets('ANNA', 'ANNA');
  const second = createWordTargets('ANNA', 'ANNA');
  assert.deepEqual(first, second);
  assertFontTarget(first.a, 'ANNA');
  assertFontTarget(first.b, 'ANNA');
  assert.deepEqual(first.a, first.b);
});

test('version 3 uses the font baseline without trimming Q descenders', () => {
  const { a, b } = createWordTargets('QQ', 'OO');
  assertFontTarget(a, 'QQ');
  assertFontTarget(b, 'OO');
  for (const glyph of a.glyphs) {
    assert.ok(Math.max(...glyph.cells.map(([, y]) => y)) >= a.font.baseline,
      'the Q tail extends below the declared font baseline');
  }
});

const sharedLetterExamples = [
  { first: 'LOVE', second: 'HOME', seed: 1 },
  { first: 'ANNA', second: 'NANA', seed: 17 },
  { first: 'Maya', second: ' MÁYA ', seed: 9 },
  { first: 'ANNA', second: 'ANA', seed: 11 },
  { first: 'MAYA', second: 'NOAH', seed: 42 },
];

for (const names of sharedLetterExamples) {
  const input = { ...names, version: 2, splitSharedLetters: true };
  test(`shared glyphs have multiple connected owners: ${input.first} / ${input.second}`, () => {
    const puzzle = generatePuzzle(input);
    assertPuzzle(puzzle, input);
    if (puzzle.first === puzzle.second) {
      assert.equal(puzzle.metrics.identicalTargets, true);
      assert.deepEqual(puzzle.targets.a, puzzle.targets.b);
    }
  });
}

test('splitting complete shared glyphs avoids tiny fragments across the alphabet', () => {
  for (const name of ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ']) {
    const input = { first: name, second: name, seed: 5, version: 2, splitSharedLetters: true };
    const puzzle = generatePuzzle(input);
    assertPuzzle(puzzle, input);
    assert.ok(puzzle.pieces.every(({ size }) => size > 4), `${name}: no 1–4-cell fragments`);
  }
});

test('version 2 without splitting has valid geometry for unequal name lengths', () => {
  const input = { first: 'AL', second: 'ALEXANDER', seed: 17, version: 2 };
  assertPuzzle(generatePuzzle(input), input);
});

test('enabling shared-letter splitting selects version 2 and remains deterministic', () => {
  const input = { first: 'LOVE', second: 'HOME', seed: 31, splitSharedLetters: true };
  const implicit = generatePuzzle(input);
  assertPuzzle(implicit, input);
  const explicit = generatePuzzle({ ...input, version: 2 });
  assert.deepEqual(implicit, explicit);
});

test('version 2 without splitting remains deterministic', () => {
  const input = { first: 'ANNA', second: 'NANA', seed: 17, version: 2, splitSharedLetters: false };
  const first = generatePuzzle(input);
  assertPuzzle(first, input);
  assert.deepEqual(generatePuzzle(input), first);
});

test('shared-letter splitting leaves geometry unchanged when names share no characters', () => {
  const input = { first: 'AL', second: 'JO', seed: 0, version: 2 };
  const disabled = generatePuzzle(input);
  const enabled = generatePuzzle({ ...input, splitSharedLetters: true });
  assertPuzzle(disabled, input);
  assertPuzzle(enabled, { ...input, splitSharedLetters: true });
  assert.equal(enabled.metrics.sharedGlyphOccurrences, 0);
  assert.equal(enabled.metrics.sharedLetterSplits, 0);
  assert.deepEqual(enabled.targets, disabled.targets);
  assert.deepEqual(enabled.pieces, disabled.pieces);
});

for (const splitSharedLetters of [false, true]) {
  test(`version 3 has valid proportional lettering with splitting ${splitSharedLetters}`, () => {
    const input = { first: 'LILY', second: 'ELLA', seed: 7, version: 3, splitSharedLetters };
    const updates = [];
    assertPuzzle(generatePuzzle(input, { onProgress: update => updates.push(update) }), input);
    assert.ok(updates.length > 0);
    let previous = 0;
    for (const update of updates) {
      assert.ok(Number.isFinite(update.progress) && update.progress >= 0 && update.progress <= 1);
      assert.ok(update.progress >= previous, 'letter preparation and piece search progress stay monotone');
      previous = update.progress;
    }
    assert.equal(updates.at(-1).progress, 1);
  });
}

test('version 3 matches unequal word lengths using fixed proportional glyphs', () => {
  const input = { first: 'AL', second: 'LILY', seed: 11, version: 3, splitSharedLetters: true };
  assertPuzzle(generatePuzzle(input), input);
});

test('version 3 uses the corrected I in BENTON / TRIPP', () => {
  const input = { first: 'BENTON', second: 'TRIPP', seed: 1, version: 3, splitSharedLetters: true };
  const puzzle = generatePuzzle(input);
  assertPuzzle(puzzle, input);
  const glyph = puzzle.targets.b.glyphs.find(({ character }) => character === 'I');
  assertStraightLetter(glyph, 'TRIPP: I');
});

test('invalid version and split combinations fail explicitly', () => {
  const names = { first: 'AL', second: 'JO' };
  for (const version of [0, 4, '2', null, NaN]) {
    assert.throws(() => generatePuzzle({ ...names, version }), { code: 'INVALID_VERSION' });
  }
  for (const splitSharedLetters of [0, 1, 'true', null, {}]) {
    assert.throws(() => generatePuzzle({ ...names, splitSharedLetters }), { code: 'INVALID_OPTION' });
  }
  assert.throws(() => generatePuzzle({ ...names, version: 1, splitSharedLetters: true }),
    { code: 'INVALID_OPTION' });
});

const examples = [
  { first: 'LOVE', second: 'HOME', seed: 1 },
  { first: 'BENTON', second: 'TRIPP', seed: 7 },
  { first: 'MAYA', second: 'NOAH', seed: 42 },
  { first: 'AL', second: 'ALEXANDER', seed: 17 },
  { first: 'José', second: 'Zoë', seed: 23 },
  { first: 'WWWWWWWWWW', second: 'IIIIIIIIII', seed: 99 },
];

for (const input of examples) {
  test(`exact connected dissection: ${input.first} / ${input.second}`, async () => {
    assertPuzzle(await generatePuzzle(input), input);
  });
}

test('identical normalized names produce a valid puzzle', async () => {
  const input = { first: 'Maya', second: ' MÁYA ', seed: 9 };
  const puzzle = await generatePuzzle(input);
  assertPuzzle(puzzle, input);
  assert.equal(puzzle.metrics.identicalTargets, true);
  assert.deepEqual(puzzle.targets.a, puzzle.targets.b);
});

test('the same input and seed reproduce geometry and piece identities', async () => {
  const input = { first: 'MAYA', second: 'NOAH', seed: 0xffffffff };
  const structure = ({ version, first, second, seed, targets, pieces }) =>
    ({ version, first, second, seed, targets, pieces });
  const first = structuredClone(structure(await generatePuzzle(input)));
  await generatePuzzle({ first: 'AL', second: 'JO', seed: 3 });
  const second = structure(await generatePuzzle(input));
  assert.deepEqual(first, second);
});

test('omitting the seed uses the same geometry as seed 1', async () => {
  const names = { first: 'AL', second: 'JO' };
  const implicit = await generatePuzzle(names);
  const explicit = await generatePuzzle({ ...names, seed: 1 });
  assert.equal(implicit.seed, 1);
  assert.deepEqual(implicit.targets, explicit.targets);
  assert.deepEqual(implicit.pieces, explicit.pieces);
});

test('finite seeds are normalized consistently to unsigned 32-bit integers', async () => {
  for (const [seed, expected] of [[0, 0], [-1, 0xffffffff], [0x100000001, 1], [3.75, 3]]) {
    const input = { first: 'AL', second: 'JO', seed };
    const puzzle = await generatePuzzle(input);
    const canonical = await generatePuzzle({ ...input, seed: expected });
    assertPuzzle(puzzle, input);
    assert.equal(puzzle.seed, expected);
    assert.deepEqual(puzzle.targets, canonical.targets);
    assert.deepEqual(puzzle.pieces, canonical.pieces);
  }
});

test('progress reports advance within the documented interval and reach completion', async () => {
  const updates = [];
  const input = { first: 'LUNA', second: 'LIAM', seed: 2 };
  const puzzle = await generatePuzzle(input, { onProgress: (update) => updates.push(update) });
  assertPuzzle(puzzle, input);
  assert.ok(updates.length > 0);
  let previous = 0;
  for (const update of updates) {
    assert.equal(typeof update.stage, 'string');
    assert.ok(Number.isFinite(update.progress));
    assert.ok(update.progress >= 0 && update.progress <= 1);
    assert.ok(update.progress >= previous, 'progress does not move backwards');
    previous = update.progress;
  }
  assert.equal(updates.at(-1).progress, 1);
});

test('normalization preserves supported Latin names without punctuation', () => {
  const examples = new Map([
    ['  Anne-Marie  ', 'ANNEMARIE'],
    ["O'Neil", 'ONEIL'],
    ['O\u2019Neil', 'ONEIL'],
    ['Jose\u0301', 'JOSE'],
    ['Zoë', 'ZOE'],
    ['straße', 'STRASSE'],
    ['Ægir', 'AEGIR'],
    ['Œdipe', 'OEDIPE'],
    ['Søren', 'SOREN'],
    ['Łukasz', 'LUKASZ'],
    ['Đorđe', 'DORDE'],
    ['Ðora', 'DORA'],
    ['Þora', 'THORA'],
  ]);
  for (const [input, expected] of examples) assert.equal(normalizeName(input), expected);
});

test('invalid names fail explicitly', async (t) => {
  const values = ['', ' ', 'A', 'ABCDEFGHIJK', 'ÞÞÞÞÞÞ', 'AL1', 'AL🙂', 'АL', null, 12, {}, []];
  for (const value of values) {
    await t.test(JSON.stringify(value), async () => {
      assert.throws(() => normalizeName(value), { code: 'INVALID_NAME' });
      await assert.rejects(async () => generatePuzzle({ first: value, second: 'NOAH' }),
        { code: 'INVALID_NAME' });
      await assert.rejects(async () => generatePuzzle({ first: 'MAYA', second: value }),
        { code: 'INVALID_NAME' });
    });
  }
});

test('nonfinite and nonnumeric seeds fail explicitly', async (t) => {
  for (const seed of [NaN, Infinity, -Infinity, '7', null, {}]) {
    await t.test(String(seed), async () => {
      await assert.rejects(async () => generatePuzzle({ first: 'MAYA', second: 'NOAH', seed }),
        { code: 'INVALID_SEED' });
    });
  }
});
