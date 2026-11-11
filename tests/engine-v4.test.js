import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePuzzle } from '../src/engine.js';
import { createTextTargets } from '../src/lettering-v4.js';
import { FONT_V3 } from '../src/glyphs-v3.js';
import { FONT_V4_EXTRA } from '../src/glyphs-v4-extra.js';

const key = ([x, y]) => `${x},${y}`;
const localCells = glyph => new Set(glyph.cells.map(([x, y]) => key([x - glyph.x, y - glyph.y])));

function uniqueCells(cells, label) {
  assert.ok(Array.isArray(cells) && cells.length > 0, `${label}: nonempty cells`);
  for (const point of cells) {
    assert.ok(Array.isArray(point) && point.length === 2 && point.every(Number.isSafeInteger),
      `${label}: integer coordinates`);
  }
  const result = new Set(cells.map(key));
  assert.equal(result.size, cells.length, `${label}: no duplicate cells`);
  return result;
}

function connected(cells, label) {
  const remaining = new Set(cells.map(key));
  const pending = [cells[0]];
  remaining.delete(key(cells[0]));
  while (pending.length) {
    const [x, y] = pending.pop();
    for (const point of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (remaining.delete(key(point))) pending.push(point);
    }
  }
  assert.equal(remaining.size, 0, `${label}: edge-connected ink`);
}

function sourceCells(record, height) {
  const [width, area, cost, hex] = record;
  assert.ok(Number.isSafeInteger(cost) && cost >= 0);
  assert.match(hex, /^(?:[0-9a-f]{2})+$/i);
  const bytes = Buffer.from(hex, 'hex');
  assert.equal(bytes.length, Math.ceil(width * height / 8));
  const cells = [];
  for (let index = 0; index < width * height; index += 1) {
    if ((bytes[index >> 3] >> (index & 7)) & 1) cells.push([index % width, Math.floor(index / width)]);
  }
  assert.equal(cells.length, area, 'stored area matches the fixed mask');
  return cells;
}

function counters(cells, width, height) {
  const ink = new Set(cells.map(key));
  const empty = new Set();
  for (let y = -1; y <= height; y += 1) {
    for (let x = -1; x <= width; x += 1) {
      if (!ink.has(key([x, y]))) empty.add(key([x, y]));
    }
  }
  let enclosed = 0;
  while (empty.size) {
    const start = empty.values().next().value;
    empty.delete(start);
    const pending = [start.split(',').map(Number)];
    let exterior = false;
    while (pending.length) {
      const [x, y] = pending.pop();
      exterior ||= x === -1 || y === -1 || x === width || y === height;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const point = [x + dx, y + dy];
          if (empty.delete(key(point))) pending.push(point);
        }
      }
    }
    if (!exterior) enclosed += 1;
  }
  return enclosed;
}

function checkTarget(target, text) {
  const letters = FONT_V3[target.font.size];
  const additions = FONT_V4_EXTRA[target.font.size];
  assert.ok(letters && additions, `${text}: recorded source family exists`);
  for (const field of ['height', 'capHeight', 'baseline']) {
    assert.equal(additions[field], letters[field], `${text}: aligned source ${field}`);
  }
  assert.equal(target.font.capHeight, letters.capHeight);
  assert.ok(target.font.capHeight >= 15);
  assert.ok(target.cells.length >= 400 && target.cells.length <= 1800);
  assert.ok(target.lines.length >= 1 && target.lines.length <= 2);
  assert.equal(target.lines.map(line => line.text).join(' '), text, `${text}: breaks preserve words`);
  assert.deepEqual(target.font.baselines, target.lines.map(line => line.baseline));
  assert.equal(target.font.baseline, target.lines[0].baseline);
  assert.equal(target.font.baseline, letters.baseline + 1);
  const indices = [...text].flatMap((character, index) => character === ' ' ? [] : [index]);
  assert.deepEqual(target.glyphs.map(glyph => glyph.index), indices, `${text}: spaces have no glyph metadata`);
  const occupied = new Set();
  const repeated = new Map();
  const expectedCounters = { O: 1, '0': 1, I: 0, '1': 0, '2': 0, '3': 0, '4': 1,
    '5': 0, '6': 1, '7': 0, '8': 2, '9': 1, '-': 0, '+': 0, '&': 1 };

  for (const [index, line] of target.lines.entries()) {
    assert.equal(line.baseline, line.y + letters.baseline);
    assert.ok(line.x >= 1 && line.x + line.width < target.width);
    assert.ok(line.y >= 1 && line.y + letters.height < target.height);
    if (index) assert.ok(target.lines[index - 1].y + letters.height < line.y,
      `${text}: complete source canvases are separated between lines`);
    const glyphs = target.glyphs.filter(glyph => glyph.line === index);
    assert.equal(glyphs.map(glyph => glyph.character).join(''), line.text.replace(/ /g, ''));
    assert.equal(glyphs[0].x, line.x);
    assert.equal(glyphs.at(-1).x + glyphs.at(-1).width, line.x + line.width);
    for (let position = 1; position < glyphs.length; position += 1) {
      const previous = glyphs[position - 1];
      const current = glyphs[position];
      const gap = current.x - previous.x - previous.width;
      if (current.index === previous.index + 1) assert.equal(gap, 2, 'regular letter spacing');
      else assert.ok(gap > 2, 'a preserved space creates a wider empty gap');
    }
  }

  for (const glyph of target.glyphs) {
    const label = `${text}: ${glyph.character} at ${glyph.index}`;
    assert.equal(glyph.character, text[glyph.index]);
    assert.ok(Number.isSafeInteger(glyph.line) && glyph.line >= 0 && glyph.line < target.lines.length);
    assert.equal(glyph.y, target.lines[glyph.line].y);
    const family = /^[A-Z]$/.test(glyph.character) ? letters : additions;
    const records = family.glyphs[glyph.character];
    assert.ok(Number.isSafeInteger(glyph.variantIndex) && glyph.variantIndex >= 0
      && glyph.variantIndex < records.length, `${label}: fixed variant provenance`);
    const record = records[glyph.variantIndex];
    assert.equal(glyph.width, record[0]);
    assert.equal(glyph.area, record[1]);
    assert.equal(glyph.cells.length, glyph.area);
    const source = sourceCells(record, family.height);
    assert.deepEqual(localCells(glyph), new Set(source.map(key)), `${label}: source mask is translated without edits`);
    const actual = uniqueCells(glyph.cells, label);
    connected(glyph.cells, label);
    for (const cell of actual) {
      assert.ok(!occupied.has(cell), `${label}: glyphs do not overlap`);
      occupied.add(cell);
    }
    const previous = repeated.get(glyph.character);
    if (previous) {
      assert.equal(glyph.variantIndex, previous.variantIndex, `${label}: repeated variant is consistent`);
      assert.deepEqual(localCells(glyph), localCells(previous), `${label}: repeated mask is consistent`);
    } else {
      repeated.set(glyph.character, glyph);
      if (glyph.character in expectedCounters) assert.equal(counters(source, record[0], family.height),
        expectedCounters[glyph.character], `${label}: counters remain open and enclosed as expected`);
    }
  }
  assert.deepEqual(occupied, uniqueCells(target.cells, text), `${text}: glyphs exactly cover the target`);
}

// Rotate cell corners to check poses independently of the engine's cell offsets.
function placedCell([x, y], pose) {
  const matrices = [[[1, 0], [0, 1]], [[0, -1], [1, 0]], [[-1, 0], [0, -1]], [[0, 1], [-1, 0]]];
  assert.ok(Number.isSafeInteger(pose.turn) && pose.turn >= 0 && pose.turn < 4);
  assert.ok(Number.isSafeInteger(pose.x) && Number.isSafeInteger(pose.y));
  const matrix = matrices[pose.turn];
  const corners = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].map(([xx, yy]) => [
    matrix[0][0] * xx + matrix[0][1] * yy + pose.x,
    matrix[1][0] * xx + matrix[1][1] * yy + pose.y,
  ]);
  const xs = corners.map(([xx]) => xx);
  const ys = corners.map(([, yy]) => yy);
  assert.equal(Math.max(...xs) - Math.min(...xs), 1);
  assert.equal(Math.max(...ys) - Math.min(...ys), 1);
  return [Math.min(...xs), Math.min(...ys)];
}

function checkPuzzle(puzzle) {
  assert.equal(puzzle.version, 4);
  assert.equal(puzzle.targets.a.cells.length, puzzle.targets.b.cells.length);
  assert.equal(puzzle.metrics.area, puzzle.targets.a.cells.length);
  assert.equal(puzzle.metrics.pieceCount, puzzle.pieces.length);
  for (const [index, piece] of puzzle.pieces.entries()) {
    assert.equal(piece.id, index);
    uniqueCells(piece.cells, `piece ${index}`);
    connected(piece.cells, `piece ${index}`);
    assert.equal(piece.size, piece.cells.length);
  }
  const shared = new Set([...puzzle.first].filter(character => /[A-Z0-9]/.test(character)
    && puzzle.second.includes(character)));
  let sharedOccurrences = 0;
  const ownership = {};
  for (const [side, text] of [['a', puzzle.first], ['b', puzzle.second]]) {
    const target = puzzle.targets[side];
    checkTarget(target, text);
    const expected = new Set(target.cells.map(key));
    const owners = new Map();
    for (const piece of puzzle.pieces) {
      for (const cell of piece.cells) {
        const [x, y] = placedCell(cell, piece[side]);
        const position = key([x, y]);
        assert.ok(x >= 0 && y >= 0 && x < target.width && y < target.height);
        assert.ok(expected.has(position), `${side}: piece ${piece.id} stays inside the target`);
        assert.ok(!owners.has(position), `${side}: pieces never overlap`);
        owners.set(position, piece.id);
      }
    }
    assert.deepEqual(new Set(owners.keys()), expected, `${side}: every target cell is covered exactly once`);
    ownership[side] = target.glyphs.map(glyph => new Set(glyph.cells.map(cell => owners.get(key(cell)))));
    for (const [index, glyph] of target.glyphs.entries()) {
      if (!shared.has(glyph.character)) continue;
      sharedOccurrences += 1;
      if (puzzle.splitSharedLetters) assert.ok(ownership[side][index].size >= 2,
        `${side}: shared ${glyph.character} uses at least two pieces`);
    }
  }
  assert.equal(puzzle.metrics.sharedGlyphOccurrences, sharedOccurrences);
  return ownership;
}

for (const [first, second] of [
  ['BENTON & TRIPP', 'LOVE + HOME'],
  ['ABCDEFGHIJKL', '123456789012'],
]) {
  test(`version 4 preserves fixed masks and rigid pieces: ${first} / ${second}`, () => {
    checkPuzzle(generatePuzzle({ first, second, seed: 1, version: 4, splitSharedLetters: true }));
  });
}

test('shared letters and digits split while identical punctuation remains whole', () => {
  const input = { first: 'A1 -+& A1', second: 'A1 -+& A1', seed: 7, version: 4, splitSharedLetters: true };
  const progress = [];
  const puzzle = generatePuzzle(input, { onProgress: update => progress.push(update) });
  const owners = checkPuzzle(puzzle);
  assert.equal(puzzle.metrics.sharedGlyphOccurrences, 8, 'spaces and three shared symbols are excluded');
  assert.ok(puzzle.metrics.sharedLetterSplits > 0);
  for (const side of ['a', 'b']) {
    for (const [index, glyph] of puzzle.targets[side].glyphs.entries()) {
      if ('-+&'.includes(glyph.character)) assert.equal(owners[side][index].size, 1,
        `${glyph.character}: identical punctuation is not forced to split`);
    }
  }
  assert.ok(progress.length > 2);
  assert.equal(progress[0].progress, 0);
  assert.equal(progress.at(-1).progress, 1);
  for (const [index, update] of progress.entries()) {
    assert.ok(typeof update.stage === 'string' && update.stage.length > 0);
    assert.ok(Number.isFinite(update.progress) && update.progress >= 0 && update.progress <= 1);
    if (index) assert.ok(update.progress >= progress[index - 1].progress, 'progress never regresses');
  }
  assert.deepEqual(generatePuzzle(input), puzzle, 'the complete output repeats for the same version, seed, and options');
});

test('spaces change layout without adding area or changing chosen glyphs', () => {
  for (const [first, second, lineCount] of [
    ['HELLO WORLD', 'GOODBYE ALL', 2],
    ['A B', 'C D', 1],
  ]) {
    const spaced = createTextTargets(first, second);
    const joined = createTextTargets(first.replace(/ /g, ''), second.replace(/ /g, ''));
    assert.equal(spaced.area, joined.area);
    for (const [side, text] of [['a', first], ['b', second]]) {
      checkTarget(spaced[side], text);
      checkTarget(joined[side], text.replace(/ /g, ''));
      assert.equal(spaced[side].lines.length, lineCount);
      assert.equal(joined[side].lines.length, 1, 'unspaced text remains on one line');
      assert.equal(spaced[side].font.size, joined[side].font.size);
      for (const [index, glyph] of spaced[side].glyphs.entries()) {
        const other = joined[side].glyphs[index];
        assert.equal(glyph.character, other.character);
        assert.equal(glyph.variantIndex, other.variantIndex);
        assert.deepEqual(localCells(glyph), localCells(other));
      }
    }
  }
});

test('selected O/0 and I/1 keep distinct connected source shapes', () => {
  const { a } = createTextTargets('0O1I', 'A + B');
  checkTarget(a, '0O1I');
  const glyphs = new Map(a.glyphs.map(glyph => [glyph.character, glyph]));
  assert.notDeepEqual(localCells(glyphs.get('O')), localCells(glyphs.get('0')));
  assert.notDeepEqual(localCells(glyphs.get('I')), localCells(glyphs.get('1')));
});
