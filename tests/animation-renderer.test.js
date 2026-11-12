import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnimation } from '../scripts/lib/animation-renderer.mjs';

const tolerance = 1e-8;
const clone = value => JSON.parse(JSON.stringify(value));

function rotateCell([x, y], turn) {
  return [[x, y], [-y - 1, x], [-x - 1, -y - 1], [y, -x - 1]][turn];
}

function rotateCorner([x, y], angle) {
  const radians = angle * Math.PI / 180;
  return [x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians)];
}

function makePuzzle(sourcePieces, names = ['FIRST', 'SECOND']) {
  const pieces = clone(sourcePieces);
  const targets = {};
  for (const side of ['a', 'b']) {
    const rawCells = pieces.flatMap(piece => piece.cells.map(cell => {
      const [x, y] = rotateCell(cell, piece[side].turn);
      return [x + piece[side].x, y + piece[side].y];
    }));
    const shiftX = 1 - Math.min(...rawCells.map(([x]) => x));
    const shiftY = 1 - Math.min(...rawCells.map(([, y]) => y));
    for (const piece of pieces) { piece[side].x += shiftX; piece[side].y += shiftY; }
    const cells = rawCells.map(([x, y]) => [x + shiftX, y + shiftY]);
    targets[side] = { width: Math.max(...cells.map(([x]) => x)) + 2, height: Math.max(...cells.map(([, y]) => y)) + 2, cells };
  }
  return { version: 4, first: names[0], second: names[1], seed: 19, targets, pieces };
}

function example(aTurn = 0, bTurn = 1) {
  return makePuzzle([
    { id: 0, cells: [[0, 0], [1, 0], [0, 1]], a: { x: 1, y: 1, turn: aTurn }, b: { x: 6, y: 2, turn: bTurn } },
    { id: 1, cells: [[0, 0], [1, 0], [2, 0]], a: { x: 10, y: 6, turn: 0 }, b: { x: 12, y: 7, turn: 3 } },
  ]);
}

function close(actual, expected, message = '') {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
}

test('both endpoint arrangements preserve every piece corner under all quarter turns', () => {
  for (let aTurn = 0; aTurn < 4; aTurn++) for (let bTurn = 0; bTurn < 4; bTurn++) {
    const puzzle = example(aTurn, bTurn);
    const before = clone(puzzle);
    const animation = createAnimation(puzzle);
    close(animation.layout.centerX, animation.width / 2, 'horizontal canvas center');
    close(animation.layout.centerY, animation.height / 2, 'vertical canvas center');
    const endpoints = { a: animation.getFrame(0), b: animation.getFrame(animation.settings.holdFrames + animation.settings.transitionFrames) };
    for (const side of ['a', 'b']) for (const [index, piece] of puzzle.pieces.entries()) {
      const actual = endpoints[side].pieces[index];
      for (const [x, y] of piece.cells) for (const offset of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const corner = [x + offset[0], y + offset[1]];
        const source = rotateCorner(corner, piece[side].turn * 90);
        const rendered = rotateCorner(corner, actual.angle);
        close(actual.x + rendered[0], piece[side].x + source[0] + animation.targetOffsets[side].x, `${side} x`);
        close(actual.y + rendered[1], piece[side].y + source[1] + animation.targetOffsets[side].y, `${side} y`);
      }
    }
    assert.deepEqual(puzzle, before, 'render preparation must not change generator output');
  }
});

test('the centroid path remains rigid and its continuous-motion bounds contain all sampled corners', () => {
  const cases = [
    example(),
    makePuzzle([{ cells: Array.from({ length: 45 }, (_, x) => [x, 0]), a: { x: 0, y: 0, turn: 0 }, b: { x: 2, y: 1, turn: 1 } }]),
    makePuzzle([{ cells: Array.from({ length: 12 }, (_, index) => [index % 4, Math.floor(index / 4)]), a: { x: 0, y: 0, turn: 3 }, b: { x: 2, y: 1, turn: 1 } }]),
  ];
  for (const puzzle of cases) for (const [width, height] of [[1080, 1080], [1920, 320], [320, 1920]]) {
    const animation = createAnimation(puzzle, { width, height, fps: 15, holdSeconds: 0.2, transitionSeconds: 0.6 });
    const { layout } = animation;
    for (let frameIndex = 0; frameIndex < animation.frameCount; frameIndex++) {
      const frame = animation.getFrame(frameIndex);
      for (const [index, piece] of animation.pieces.entries()) {
        const pose = frame.pieces[index];
        close(pose.centerX, piece.a.centerX + (piece.b.centerX - piece.a.centerX) * frame.progress, 'centroid x');
        close(pose.centerY, piece.a.centerY + (piece.b.centerY - piece.a.centerY) * frame.progress, 'centroid y');
        for (const [x, y] of piece.cells) for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          const corner = [x + dx, y + dy];
          const rotated = rotateCorner(corner, pose.angle);
          const worldX = rotated[0] + pose.x, worldY = rotated[1] + pose.y;
          assert.ok(worldX >= layout.worldBounds.minX - tolerance && worldX <= layout.worldBounds.maxX + tolerance);
          assert.ok(worldY >= layout.worldBounds.minY - tolerance && worldY <= layout.worldBounds.maxY + tolerance);
          const pixelX = worldX * layout.scale + layout.centerX;
          const pixelY = worldY * layout.scale + layout.centerY;
          assert.ok(pixelX >= layout.margin.x - tolerance && pixelX <= width - layout.margin.x + tolerance, 'horizontal frame margin');
          assert.ok(pixelY >= layout.margin.y - tolerance && pixelY <= height - layout.margin.y + tolerance, 'vertical frame margin');
          close(Math.hypot(worldX - pose.centerX, worldY - pose.centerY), Math.hypot(corner[0] - piece.localCenter.x, corner[1] - piece.localCenter.y), 'rigid radius');
        }
      }
    }
  }
});

test('timeline uses fixed integer frames, exact endpoint holds, and no duplicated terminal frame', () => {
  const animation = createAnimation(example());
  assert.equal(animation.frameCount, 168);
  assert.equal(animation.duration, 5.6);
  assert.equal(animation.settings.holdFrames, 48);
  assert.equal(animation.settings.transitionFrames, 36);
  assert.equal(animation.getFrame(0).phase, 'hold-a');
  assert.equal(animation.getFrame(47).progress, 0);
  assert.equal(animation.getFrame(48).phase, 'a-to-b');
  assert.equal(animation.getFrame(48).progress, 0);
  assert.equal(animation.getFrame(66).progress, 0.5);
  assert.equal(animation.getFrame(84).phase, 'hold-b');
  assert.equal(animation.getFrame(84).progress, 1);
  assert.equal(animation.getFrame(131).progress, 1);
  assert.equal(animation.getFrame(132).phase, 'b-to-a');
  assert.equal(animation.getFrame(150).progress, 0.5);
  const final = animation.getFrame(167);
  assert.ok(final.progress > 0 && final.progress < 0.001);
  close(final.progress, animation.getFrame(49).progress, 'equal samples on each side of the A hold');
  close(final.timeSeconds + 1 / animation.fps, animation.duration, 'terminal sample follows one frame later');
  assert.notEqual(animation.renderFrame(167), animation.renderFrame(0));
  for (const index of [-1, 168, 1.5, NaN, Infinity]) assert.throws(() => animation.renderFrame(index), /Frame index/);
});

test('duration rounding is recorded and zero-hold loops remain well defined', () => {
  const animation = createAnimation(example(), { fps: 24, holdSeconds: 0.26, transitionSeconds: 0.34 });
  assert.equal(animation.settings.requestedHoldSeconds, 0.26);
  assert.equal(animation.settings.requestedTransitionSeconds, 0.34);
  assert.equal(animation.settings.holdFrames, 6);
  assert.equal(animation.settings.transitionFrames, 8);
  assert.equal(animation.frameCount, 28);
  assert.equal(animation.settings.holdSeconds, 6 / 24);
  assert.equal(animation.settings.transitionSeconds, 8 / 24);
  const withoutHolds = createAnimation(example(), { fps: 10, holdSeconds: 0, transitionSeconds: 0.2 });
  assert.equal(withoutHolds.frameCount, 4);
  assert.deepEqual(Array.from({ length: 4 }, (_, index) => withoutHolds.getFrame(index).progress), [0, 0.5, 1, 0.5]);
});

test('piece outlines retain holes and remove shared cell edges', () => {
  const ringCells = Array.from({ length: 9 }, (_, index) => [index % 3, Math.floor(index / 3)]).filter(([x, y]) => x !== 1 || y !== 1);
  const puzzle = makePuzzle([{ cells: ringCells, a: { x: 0, y: 0, turn: 0 }, b: { x: 0, y: 0, turn: 1 } }]);
  const animation = createAnimation(puzzle);
  const path = animation.pieces[0].path;
  assert.equal((path.match(/M/g) || []).length, 2, 'outer and inner contours');
  assert.equal((path.match(/L/g) || []).length, 16, '12 outer and 4 inner unit edges, without cell interiors');
  const areas = path.split('Z').filter(Boolean).map(contour => {
    const coordinates = [...contour.matchAll(/[ML](-?\d+) (-?\d+)/g)].map(match => [Number(match[1]), Number(match[2])]);
    return coordinates.reduce((area, [x, y], index) => {
      const next = coordinates[(index + 1) % coordinates.length];
      return area + (x * next[1] - y * next[0]) / 2;
    }, 0);
  });
  assert.deepEqual(areas.map(Math.abs).sort((a, b) => a - b), [1, 9]);
  assert.equal(Math.abs(areas.reduce((sum, area) => sum + area, 0)), 8);
  assert.match(animation.renderFrame(0), /fill-rule="evenodd"/);
});

test('all themes render deterministically with self-contained colors and static decoration', () => {
  for (const theme of ['birthday', 'holidays', 'new-year', 'plain']) {
    const first = createAnimation(example(), { theme });
    const second = createAnimation(example(), { theme });
    for (const frame of [0, 66, 84, 150, 167]) assert.equal(first.renderFrame(frame), second.renderFrame(frame));
    assert.match(first.renderFrame(0), /width="1080" height="1080"/);
    assert.doesNotMatch(first.renderFrame(0), /var\(|<script|<image|<foreignObject|<text|https?:\/\/(?!www\.w3\.org)/);
    assert.equal((first.renderFrame(0).match(/data-piece-index=/g) || []).length, example().pieces.length);
    assert.equal((first.renderFrame(0).match(/aria-hidden="true"/g) || []).length, theme === 'plain' ? 0 : 1);
  }
});

test('export preparation owns its data and escapes XML text', () => {
  const names = ['A & B <script> "test"', "C 'D'\u0000"];
  const puzzle = makePuzzle(example().pieces, names);
  const colors = ['#ABCDEF'];
  const animation = createAnimation(puzzle, { colors, background: '#123ABC' });
  const before = animation.renderFrame(66);
  puzzle.pieces[0].cells[0][0] = 900;
  puzzle.pieces[0].a.x = 900;
  puzzle.first = 'CHANGED';
  colors[0] = '#000000';
  assert.equal(animation.renderFrame(66), before);
  assert.equal(animation.settings.colors[0], '#abcdef');
  assert.equal(animation.settings.background, '#123abc');
  assert.ok(Object.isFrozen(animation.settings.colors));
  assert.match(before, /A &amp; B &lt;script&gt; &quot;test&quot;/);
  assert.match(before, /C &apos;D&apos;\ufffd/);
  assert.doesNotMatch(before, /<script>|\u0000/);
});

test('invalid sizes, durations, colors, themes, and unknown options are rejected', () => {
  const cases = [
    { width: NaN }, { width: Infinity }, { width: 0 }, { width: 4097 }, { width: 1080.5 },
    { height: -2 }, { fps: 0 }, { fps: 61 }, { fps: 29.97 },
    { holdSeconds: -1 }, { holdSeconds: 16 }, { transitionSeconds: 0 }, { transitionSeconds: Infinity },
    { theme: 'christmas' }, { theme: '__proto__' }, { colors: [] }, { colors: ['red'] },
    { colors: ['#123456" onload="alert(1)'] }, { background: 'url(https://example.com)' }, { unexpected: true },
  ];
  for (const options of cases) assert.throws(() => createAnimation(example(), options));
  for (const options of [null, false, []]) assert.throws(() => createAnimation(example(), options));
});

test('invalid geometry cannot be presented as a valid animation', () => {
  const disconnected = makePuzzle([{ cells: [[0, 0], [2, 0]], a: { x: 0, y: 0, turn: 0 }, b: { x: 0, y: 0, turn: 0 } }]);
  assert.throws(() => createAnimation(disconnected), /connected/);
  const duplicate = example();
  duplicate.pieces[0].cells.push([...duplicate.pieces[0].cells[0]]);
  assert.throws(() => createAnimation(duplicate), /duplicate/);
  const wrongPose = example();
  wrongPose.pieces[0].b.x += 20;
  assert.throws(() => createAnimation(wrongPose), /cover target b/);
  const missingPiece = example();
  missingPiece.pieces.pop();
  assert.throws(() => createAnimation(missingPiece), /cover target/);
  const invalidTurn = example();
  invalidTurn.pieces[0].a.turn = 4;
  assert.throws(() => createAnimation(invalidTurn), /turn/);
});
