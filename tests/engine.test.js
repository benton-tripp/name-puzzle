import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePuzzle, normalizeName } from '../src/engine.js';

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

function assertPuzzle(puzzle, input) {
  assert.equal(puzzle.version, 1);
  assert.equal(puzzle.first, normalizeName(input.first));
  assert.equal(puzzle.second, normalizeName(input.second));
  assert.ok(Number.isInteger(puzzle.seed) && puzzle.seed >= 0 && puzzle.seed <= 0xffffffff);
  assert.ok(Array.isArray(puzzle.pieces) && puzzle.pieces.length > 0);
  assert.equal(new Set(puzzle.pieces.map(({ id }) => id)).size, puzzle.pieces.length,
    'piece IDs are unique');

  const targetSets = {};
  for (const side of ['a', 'b']) {
    const target = puzzle.targets[side];
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
      }
    }
  }

  assert.equal(totalArea, targetSets.a.size, 'piece area equals target area');
  assert.deepEqual(occupied.a, targetSets.a, 'first target is covered exactly');
  assert.deepEqual(occupied.b, targetSets.b, 'second target is covered exactly');
  assert.equal(puzzle.metrics.pieceCount, puzzle.pieces.length);
  assert.equal(puzzle.metrics.singletons, puzzle.pieces.filter(({ size }) => size === 1).length);
}

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
