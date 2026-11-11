import { GLYPHS } from './glyphs.js';

const VERSION = 1;
const PAIR_LIMIT = 70000000;
const SEARCH_PASSES = [
  { shifts: 24, candidates: 32, fragment: 2, singleton: 3, small: 0.5 },
  { shifts: 40, candidates: 100, fragment: 1, singleton: 2, small: 0.25 },
  { shifts: 40, candidates: 100, fragment: 2, singleton: 3, small: 0.5 },
];

function failure(message, code = 'INVALID_NAME') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeName(value) {
  if (typeof value !== 'string') throw failure('Enter a name using 2 to 10 letters.');
  const folds = { Æ: 'AE', æ: 'AE', Œ: 'OE', œ: 'OE', Ø: 'O', ø: 'O', Ł: 'L', ł: 'L', Đ: 'D', đ: 'D', Ð: 'D', ð: 'D', Þ: 'TH', þ: 'TH' };
  const name = value.replace(/[ÆæŒœØøŁłĐđÐðÞþ]/g, char => folds[char])
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[\s'\u2018\u2019\-\u2010\u2011\u2012\u2013\u2014]/gu, '').toUpperCase();
  if (/[^A-Z]/.test(name)) throw failure('Use letters A to Z. Accents, spaces, hyphens, and apostrophes are supported.');
  if (name.length < 2 || name.length > 10) throw failure('Use 2 to 10 letters after spaces and punctuation are removed.');
  return name;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function makeTarget(name, area) {
  const records = [...name].map(char => GLYPHS[area]?.[char]);
  if (records.some(record => !record)) throw failure('This name combination has no glyph data.', 'GLYPH_DATA');
  const height = records[0][1] + 2;
  const width = records.reduce((sum, record) => sum + record[0], 0) + 2 * name.length;
  const mask = new Uint8Array(width * height);
  const cells = [];
  let offset = 1;
  for (const [glyphWidth, glyphHeight, hex] of records) {
    for (let byte = 0; byte < hex.length / 2; byte++) {
      const bits = Number.parseInt(hex.slice(byte * 2, byte * 2 + 2), 16);
      for (let bit = 0; bit < 8; bit++) {
        const index = byte * 8 + bit;
        if (index >= glyphWidth * glyphHeight || !(bits & (1 << bit))) continue;
        const x = offset + index % glyphWidth;
        const y = 1 + Math.floor(index / glyphWidth);
        mask[y * width + x] = 1;
        cells.push([x, y]);
      }
    }
    offset += glyphWidth + 2;
  }
  return { width, height, mask, cells };
}

function neighbors(index, width, height, visit) {
  const x = index % width;
  const y = Math.floor(index / width);
  if (x) visit(index - 1);
  if (x + 1 < width) visit(index + 1);
  if (y) visit(index - width);
  if (y + 1 < height) visit(index + width);
}

function components(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const result = [];
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index] || seen[index]) continue;
    const queue = [index];
    seen[index] = 1;
    for (let head = 0; head < queue.length; head++) {
      neighbors(queue[head], width, height, next => {
        if (mask[next] && !seen[next]) {
          seen[next] = 1;
          queue.push(next);
        }
      });
    }
    result.push(queue);
  }
  return result;
}

function residualStats(mask, width, height) {
  const groups = components(mask, width, height);
  let singletons = 0;
  let small = 0;
  for (const group of groups) {
    if (group.length === 1) singletons++;
    if (group.length <= 4) small += group.length;
  }
  return { count: groups.length, singletons, small };
}

function rotationMaps(target) {
  return [0, 1, 2, 3].map(turn => {
    const width = turn % 2 ? target.height : target.width;
    const height = turn % 2 ? target.width : target.height;
    const toOriginal = new Int32Array(width * height).fill(-1);
    const xs = new Int32Array(target.mask.length);
    const ys = new Int32Array(target.mask.length);
    for (let y = 0; y < target.height; y++) {
      for (let x = 0; x < target.width; x++) {
        let rx = x;
        let ry = y;
        if (turn === 1) [rx, ry] = [target.height - 1 - y, x];
        if (turn === 2) [rx, ry] = [target.width - 1 - x, target.height - 1 - y];
        if (turn === 3) [rx, ry] = [y, target.width - 1 - x];
        const id = y * target.width + x;
        toOriginal[ry * width + rx] = id;
        xs[id] = rx;
        ys[id] = ry;
      }
    }
    return { width, height, toOriginal, xs, ys, turn };
  });
}

function largestShifts(aIds, bIds, a, rotation, limit) {
  const width = a.width + rotation.width - 1;
  const height = a.height + rotation.height - 1;
  const counts = new Uint16Array(width * height);
  for (const aid of aIds) {
    const x = aid % a.width + rotation.width - 1;
    const y = Math.floor(aid / a.width) + rotation.height - 1;
    for (const bid of bIds) counts[(y - rotation.ys[bid]) * width + x - rotation.xs[bid]]++;
  }
  const top = [];
  for (let index = 0; index < counts.length; index++) {
    const count = counts[index];
    if (!count || (top.length === limit && count < top[top.length - 1].count)) continue;
    const item = { count, index };
    let position = top.length;
    while (position && (top[position - 1].count < count || (top[position - 1].count === count && top[position - 1].index > index))) position--;
    top.splice(position, 0, item);
    if (top.length > limit) top.pop();
  }
  return top.map(({ index }) => ({ dx: index % width - rotation.width + 1, dy: Math.floor(index / width) - rotation.height + 1 }));
}

function overlapCandidates(aIds, bMask, a, rotation, dx, dy) {
  const overlap = new Uint8Array(a.mask.length);
  const pairing = new Int32Array(a.mask.length).fill(-1);
  for (const aid of aIds) {
    const x = aid % a.width - dx;
    const y = Math.floor(aid / a.width) - dy;
    if (x < 0 || y < 0 || x >= rotation.width || y >= rotation.height) continue;
    const bid = rotation.toOriginal[y * rotation.width + x];
    if (bid >= 0 && bMask[bid]) {
      overlap[aid] = 1;
      pairing[aid] = bid;
    }
  }
  return components(overlap, a.width, a.height)
    .sort((left, right) => right.length - left.length || left[0] - right[0])
    .slice(0, 3)
    .map(ids => ({ aIds: ids, bIds: ids.map(id => pairing[id]), turn: (4 - rotation.turn) % 4 }));
}

function rotateCell(x, y, turn) {
  if (turn === 1) return [-y - 1, x];
  if (turn === 2) return [-x - 1, -y - 1];
  if (turn === 3) return [y, -x - 1];
  return [x, y];
}

function toPiece(candidate, a, b, id) {
  const points = candidate.aIds.map(index => [index % a.width, Math.floor(index / a.width)]);
  const x = Math.min(...points.map(point => point[0]));
  const y = Math.min(...points.map(point => point[1]));
  const cells = points.map(point => [point[0] - x, point[1] - y]);
  const firstB = candidate.bIds[0];
  const rotated = rotateCell(cells[0][0], cells[0][1], candidate.turn);
  return {
    id, cells, size: cells.length,
    a: { x, y, turn: 0 },
    b: { x: firstB % b.width - rotated[0], y: Math.floor(firstB / b.width) - rotated[1], turn: candidate.turn },
  };
}

function positionedCells(piece, side) {
  return piece.cells.map(([x, y]) => {
    const [rx, ry] = rotateCell(x, y, piece[side].turn);
    return [rx + piece[side].x, ry + piece[side].y];
  });
}

function shapeForm(cells, turn = 0) {
  const points = cells.map(([x, y]) => rotateCell(x, y, turn));
  const x = Math.min(...points.map(point => point[0]));
  const y = Math.min(...points.map(point => point[1]));
  const normalized = points.map(point => [point[0] - x, point[1] - y]);
  normalized.sort((left, right) => left[1] - right[1] || left[0] - right[0]);
  return { x, y, cells: normalized, key: normalized.map(point => point.join(',')).join(';') };
}

function shapeKey(cells) {
  return [0, 1, 2, 3].map(turn => shapeForm(cells, turn).key).sort()[0];
}

function fitPose(cells, targetCells) {
  const target = shapeForm(targetCells);
  for (let turn = 0; turn < 4; turn++) {
    const source = shapeForm(cells, turn);
    if (source.key === target.key) return { x: target.x - source.x, y: target.y - source.y, turn };
  }
  throw failure('Two merged pieces did not match.', 'INVALID_GEOMETRY');
}

function adjacentPairs(pieces, side, target, types) {
  const owners = new Int32Array(target.width * target.height).fill(-1);
  const cells = pieces.map(piece => positionedCells(piece, side));
  for (let id = 0; id < cells.length; id++) {
    for (const [x, y] of cells[id]) owners[y * target.width + x] = id;
  }
  const edges = new Set();
  for (let index = 0; index < owners.length; index++) {
    const owner = owners[index];
    if (owner < 0) continue;
    for (const next of [index % target.width + 1 < target.width ? index + 1 : -1, index + target.width]) {
      const neighbor = next >= 0 && next < owners.length ? owners[next] : -1;
      if (neighbor >= 0 && owner !== neighbor) edges.add(Math.min(owner, neighbor) + ':' + Math.max(owner, neighbor));
    }
  }
  return [...edges].map(edge => {
    const ids = edge.split(':').map(Number);
    const union = [...cells[ids[0]], ...cells[ids[1]]];
    const pairType = [types[ids[0]], types[ids[1]]].sort().join('|');
    return { ids, cells: union, key: pairType + '/' + shapeKey(union) };
  });
}

function compactPieces(original, a, b) {
  let pieces = original;
  let merges = 0;
  let work = 0;
  while (pieces.length > 1 && merges < 100 && work < 1000000) {
    const types = pieces.map(piece => shapeKey(piece.cells));
    const aPairs = adjacentPairs(pieces, 'a', a, types);
    const bPairs = adjacentPairs(pieces, 'b', b, types);
    work += [...aPairs, ...bPairs].reduce((sum, pair) => sum + pair.cells.length, 0);
    const byShape = new Map();
    for (const pair of bPairs) if (!byShape.has(pair.key)) byShape.set(pair.key, pair);
    aPairs.sort((left, right) => right.cells.length - left.cells.length);
    const source = aPairs.find(pair => byShape.has(pair.key));
    if (!source) break;
    const destination = byShape.get(source.key);
    const removed = new Set(source.ids);
    const occupied = new Set(destination.ids);
    const vacancies = source.ids.filter(id => !occupied.has(id));
    const displaced = destination.ids.filter(id => !removed.has(id));
    const replacements = new Map();
    for (const id of displaced) {
      const position = vacancies.findIndex(slot => types[slot] === types[id]);
      if (position < 0) throw failure('A piece reassignment failed.', 'INVALID_GEOMETRY');
      const slot = vacancies.splice(position, 1)[0];
      replacements.set(id, fitPose(pieces[id].cells, positionedCells(pieces[slot], 'b')));
    }
    const sourceForm = shapeForm(source.cells);
    const merged = {
      id: 0, cells: sourceForm.cells, size: sourceForm.cells.length,
      a: { x: sourceForm.x, y: sourceForm.y, turn: 0 },
      b: fitPose(sourceForm.cells, destination.cells),
    };
    pieces = pieces.flatMap((piece, id) => {
      if (id === source.ids[0]) return [merged];
      if (id === source.ids[1]) return [];
      return [{ ...piece, b: replacements.get(id) || piece.b }];
    });
    pieces.forEach((piece, id) => { piece.id = id; });
    merges++;
  }
  return { pieces, merges };
}

function validatePuzzle(puzzle) {
  for (const side of ['a', 'b']) {
    const target = puzzle.targets[side];
    const expected = new Set(target.cells.map(([x, y]) => y * target.width + x));
    const covered = new Set();
    for (const piece of puzzle.pieces) {
      for (const [x, y] of piece.cells) {
        const [rx, ry] = rotateCell(x, y, piece[side].turn);
        const px = rx + piece[side].x;
        const py = ry + piece[side].y;
        const index = py * target.width + px;
        if (px < 0 || py < 0 || px >= target.width || py >= target.height || !expected.has(index) || covered.has(index)) {
          throw failure('The generated pieces did not pass the coverage check.', 'INVALID_GEOMETRY');
        }
        covered.add(index);
      }
    }
    if (covered.size !== expected.size) throw failure('The generated pieces left uncovered cells.', 'INVALID_GEOMETRY');
  }
  for (const piece of puzzle.pieces) {
    const width = Math.max(...piece.cells.map(([x]) => x)) + 1;
    const height = Math.max(...piece.cells.map(([, y]) => y)) + 1;
    const mask = new Uint8Array(width * height);
    for (const [x, y] of piece.cells) mask[y * width + x] = 1;
    if (components(mask, width, height).length !== 1) throw failure('A generated piece is disconnected.', 'INVALID_GEOMETRY');
  }
}

function generateCandidate({ first, second, seed = 1 }, { onProgress, config }) {
  first = normalizeName(first);
  second = normalizeName(second);
  if (typeof seed !== 'number' || !Number.isFinite(seed)) throw failure('Use a finite numeric seed.', 'INVALID_SEED');
  seed = seed >>> 0;
  const notify = (stage, progress) => { if (typeof onProgress === 'function') onProgress({ stage, progress }); };
  notify('Preparing letters', 0);
  const common = first.length * second.length / gcd(first.length, second.length);
  const area = common * Math.ceil(105 * Math.max(first.length, second.length) / common);
  const a = makeTarget(first, area / first.length);
  const b = makeTarget(second, area / second.length);
  if (a.cells.length !== b.cells.length) throw failure('The target areas differ.', 'INVALID_GEOMETRY');
  const aMask = a.mask.slice();
  const bMask = b.mask.slice();
  const rotations = rotationMaps(b);
  const random = randomSource(seed);
  let pieces = [];
  let pairComparisons = 0;
  let candidateEvaluations = 0;
  let searchLimited = false;
  let remaining = area;
  notify('Finding shared pieces', 0.05);
  while (remaining) {
    const aIds = [];
    const bIds = [];
    for (let id = 0; id < aMask.length; id++) if (aMask[id]) aIds.push(id);
    for (let id = 0; id < bMask.length; id++) if (bMask[id]) bIds.push(id);
    const candidates = [];
    const keys = new Set();
    for (const rotation of rotations) {
      const operations = aIds.length * bIds.length;
      if (pairComparisons + operations > PAIR_LIMIT) {
        searchLimited = true;
        break;
      }
      pairComparisons += operations;
      for (const { dx, dy } of largestShifts(aIds, bIds, a, rotation, config.shifts)) {
        for (const candidate of overlapCandidates(aIds, bMask, a, rotation, dx, dy)) {
          const key = candidate.aIds.slice().sort((x, y) => x - y).join(',') + ':' + candidate.bIds.slice().sort((x, y) => x - y).join(',');
          if (keys.has(key)) continue;
          keys.add(key);
          candidate.tie = random();
          candidates.push(candidate);
        }
      }
    }
    if (!candidates.length) {
      const rotation = rotations[0];
      const aid = aIds[0];
      const bid = bIds[0];
      candidates.push(...overlapCandidates(aIds, bMask, a, rotation, aid % a.width - rotation.xs[bid], Math.floor(aid / a.width) - rotation.ys[bid]));
      for (const candidate of candidates) candidate.tie = random();
    }
    candidates.sort((left, right) => right.aIds.length - left.aIds.length || right.tie - left.tie);
    let best;
    let bestScore = -Infinity;
    for (const candidate of candidates.slice(0, config.candidates)) {
      for (const id of candidate.aIds) aMask[id] = 0;
      for (const id of candidate.bIds) bMask[id] = 0;
      const sa = residualStats(aMask, a.width, a.height);
      const sb = residualStats(bMask, b.width, b.height);
      const score = candidate.aIds.length - config.fragment * (Math.max(sa.count, sb.count) + 0.3 * Math.min(sa.count, sb.count))
        - config.singleton * (sa.singletons + sb.singletons) - config.small * (sa.small + sb.small) + candidate.tie * 0.2;
      for (const id of candidate.aIds) aMask[id] = 1;
      for (const id of candidate.bIds) bMask[id] = 1;
      candidateEvaluations++;
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    if (!best) throw failure('No shared piece could be generated.', 'GENERATION_FAILED');
    for (const id of best.aIds) aMask[id] = 0;
    for (const id of best.bIds) bMask[id] = 0;
    pieces.push(toPiece(best, a, b, pieces.length));
    remaining -= best.aIds.length;
    notify('Finding shared pieces', 0.05 + 0.85 * (area - remaining) / area);
  }
  const rawPieceCount = pieces.length;
  notify('Combining compatible pieces', 0.92);
  const compacted = compactPieces(pieces, a, b);
  pieces = compacted.pieces;
  const puzzle = {
    version: VERSION, first, second, seed,
    targets: { a: { width: a.width, height: a.height, cells: a.cells }, b: { width: b.width, height: b.height, cells: b.cells } },
    pieces,
    metrics: {
      pieceCount: pieces.length, singletons: pieces.filter(piece => piece.size === 1).length,
      tinyPieces: pieces.filter(piece => piece.size <= 4).length, area,
      smallestPiece: Math.min(...pieces.map(piece => piece.size)), largestPiece: Math.max(...pieces.map(piece => piece.size)),
      identicalTargets: first === second, pairComparisons, candidateEvaluations, searchLimited,
      rawPieceCount, compactionMerges: compacted.merges,
    },
  };
  notify('Checking the result', 0.95);
  validatePuzzle(puzzle);
  notify('Ready', 1);
  return puzzle;
}

export function generatePuzzle({ first, second, seed = 1 } = {}, { onProgress } = {}) {
  first = normalizeName(first);
  second = normalizeName(second);
  if (typeof seed !== 'number' || !Number.isFinite(seed)) throw failure('Use a finite numeric seed.', 'INVALID_SEED');
  seed = seed >>> 0;
  let best;
  let bestScore = Infinity;
  let totalPairComparisons = 0;
  const searchedPieceCounts = [];
  for (let pass = 0; pass < SEARCH_PASSES.length; pass++) {
    const candidateSeed = pass ? (seed ^ Math.imul(pass, 0x9E3779B9)) >>> 0 : seed;
    const result = generateCandidate({ first, second, seed: candidateSeed }, {
      config: SEARCH_PASSES[pass],
      onProgress: update => {
        if (typeof onProgress === 'function') onProgress({
          stage: pass ? `Refining pieces (${pass + 1} of ${SEARCH_PASSES.length})` : update.stage,
          progress: (pass + update.progress) / SEARCH_PASSES.length,
        });
      },
    });
    const score = 4 * result.metrics.pieceCount + 3 * result.metrics.singletons + result.metrics.tinyPieces;
    searchedPieceCounts.push(result.metrics.pieceCount);
    totalPairComparisons += result.metrics.pairComparisons;
    if (score < bestScore) {
      bestScore = score;
      best = result;
      best.metrics.selectedPass = pass + 1;
    }
  }
  best.seed = seed;
  best.metrics.qualityPasses = SEARCH_PASSES.length;
  best.metrics.searchedPieceCounts = searchedPieceCounts;
  best.metrics.totalPairComparisons = totalPairComparisons;
  if (typeof onProgress === 'function') onProgress({ stage: 'Ready', progress: 1 });
  return best;
}
