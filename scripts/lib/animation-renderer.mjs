// Local SVG export renderer. It reads generated geometry without changing it.
// All frame times, colors, outlines, and decorations are deterministic.

const SVG_NS = 'http://www.w3.org/2000/svg';
const THEMES = {
  birthday: {
    background: '#fff7ec', stroke: '#604b43',
    colors: ['#df7466', '#e9ad56', '#65aaa0', '#82a3c6', '#b297c5', '#efc96f', '#ce8ea7', '#9ab58a'],
  },
  holidays: {
    background: '#123b3b', stroke: '#254f4b',
    colors: ['#dce9e4', '#91b8aa', '#c7d6bc', '#9bc3ca', '#dfc78f', '#76a59a', '#e9dfc6', '#b2cfc3'],
  },
  'new-year': {
    background: '#111e36', stroke: '#554a34',
    colors: ['#ebcd83', '#d4ad66', '#f7e8c8', '#c99c53', '#dfbe72', '#f1d9a5', '#9eafc7', '#c7cedb'],
  },
  plain: {
    background: '#f8f7f2', stroke: '#42564c',
    colors: ['#cd7658', '#639182', '#d2ae60', '#788caa', '#a887a2', '#8b9c58', '#b48a65', '#729fa9'],
  },
};
const OPTION_NAMES = new Set(['theme', 'width', 'height', 'fps', 'holdSeconds', 'transitionSeconds', 'background', 'colors']);
const MAX_CELLS = 100000;
const MAX_COORDINATE = 100000;

const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor;
const number = value => String(Number(value.toFixed(6)));
const ease = value => value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2;
const cellKey = ([x, y]) => `${x},${y}`;

function xml(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '\ufffd')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function finite(value, name, minimum, maximum, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be ${integer ? 'an integer' : 'a finite number'} from ${minimum} to ${maximum}.`);
  }
  return value;
}

function hex(value, name) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError(`${name} must be a six-digit hex color, such as #123b3b.`);
  return value.toLowerCase();
}

function settingsFor(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Animation options must be an object.');
  for (const name of Object.keys(options)) if (!OPTION_NAMES.has(name)) throw new TypeError(`Unknown animation option: ${name}.`);
  const theme = options.theme ?? 'birthday';
  if (!Object.hasOwn(THEMES, theme)) throw new TypeError('Choose birthday, holidays, new-year, or plain.');
  const width = finite(options.width ?? 1080, 'Width', 64, 4096, true);
  const height = finite(options.height ?? 1080, 'Height', 64, 4096, true);
  const fps = finite(options.fps ?? 30, 'Frame rate', 1, 60, true);
  const requestedHoldSeconds = finite(options.holdSeconds ?? 1.6, 'Hold duration', 0, 15);
  const requestedTransitionSeconds = finite(options.transitionSeconds ?? 1.2, 'Transition duration', 1 / 60, 15);
  const holdFrames = Math.round(requestedHoldSeconds * fps);
  const transitionFrames = Math.max(1, Math.round(requestedTransitionSeconds * fps));
  const suppliedColors = options.colors ?? THEMES[theme].colors;
  if (!Array.isArray(suppliedColors) || suppliedColors.length < 1 || suppliedColors.length > 32) throw new TypeError('Colors must contain from 1 to 32 hex colors.');
  const colors = Object.freeze(suppliedColors.map((color, index) => hex(color, `Color ${index + 1}`)));
  return Object.freeze({
    rendererVersion: 1, theme, width, height, fps,
    holdSeconds: holdFrames / fps, transitionSeconds: transitionFrames / fps,
    requestedHoldSeconds, requestedTransitionSeconds, holdFrames, transitionFrames,
    background: hex(options.background ?? THEMES[theme].background, 'Background'), colors,
  });
}

function readCells(value, name, connected = false) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CELLS) throw new TypeError(`${name} must contain from 1 to ${MAX_CELLS} cells.`);
  const cells = value.map(point => {
    if (!Array.isArray(point) || point.length !== 2) throw new TypeError(`${name} must contain coordinate pairs.`);
    return [finite(point[0], `${name} x`, -MAX_COORDINATE, MAX_COORDINATE, true), finite(point[1], `${name} y`, -MAX_COORDINATE, MAX_COORDINATE, true)];
  }).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const keys = new Set(cells.map(cellKey));
  if (keys.size !== cells.length) throw new TypeError(`${name} contains duplicate cells.`);
  if (connected) {
    const remaining = new Set(keys);
    const queue = [cells[0]];
    remaining.delete(cellKey(cells[0]));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const [x, y] = queue[cursor];
      for (const point of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (remaining.delete(cellKey(point))) queue.push(point);
      }
    }
    if (remaining.size) throw new TypeError(`${name} must be connected along cell edges.`);
  }
  return cells;
}

function boundsForCells(cells) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of cells) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + 1); maxY = Math.max(maxY, y + 1);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function rotatePoint(x, y, degrees) {
  const quarter = degrees / 90;
  if (Number.isInteger(quarter)) {
    switch (modulo(quarter, 4)) {
      case 0: return { x, y };
      case 1: return { x: -y, y: x };
      case 2: return { x: -x, y: -y };
      default: return { x: y, y: -x };
    }
  }
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  return { x: x * cosine - y * sine, y: x * sine + y * cosine };
}

function rotateCell(x, y, turn) {
  if (turn === 1) return [-y - 1, x];
  if (turn === 2) return [-x - 1, -y - 1];
  if (turn === 3) return [y, -x - 1];
  return [x, y];
}

// Cancel shared cell edges, then trace every boundary, including holes.
// The turn priority keeps contours separate where boundaries meet at a corner.
function outline(cells) {
  const edges = new Map();
  const add = (x1, y1, x2, y2, direction) => {
    const from = `${x1},${y1}`, to = `${x2},${y2}`;
    const reverse = `${to}>${from}`;
    if (!edges.delete(reverse)) edges.set(`${from}>${to}`, { from, to, x1, y1, x2, y2, direction });
  };
  for (const [x, y] of cells) {
    add(x, y, x + 1, y, 0); add(x + 1, y, x + 1, y + 1, 1);
    add(x + 1, y + 1, x, y + 1, 2); add(x, y + 1, x, y, 3);
  }
  const outgoing = new Map();
  for (const edge of edges.values()) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }
  const remaining = new Set(edges.values());
  const paths = [];
  const priority = [1, 0, 3, 2];
  for (const first of edges.values()) {
    if (!remaining.has(first)) continue;
    let edge = first;
    let path = `M${edge.x1} ${edge.y1}`;
    while (edge && remaining.has(edge)) {
      remaining.delete(edge);
      path += `L${edge.x2} ${edge.y2}`;
      if (edge.to === first.from) break;
      const candidates = (outgoing.get(edge.to) || []).filter(next => remaining.has(next));
      candidates.sort((a, b) => priority.indexOf(modulo(a.direction - edge.direction, 4)) - priority.indexOf(modulo(b.direction - edge.direction, 4)));
      edge = candidates[0];
    }
    if (!edge || edge.to !== first.from) throw new Error('A piece boundary could not be closed.');
    paths.push(`${path}Z`);
  }
  return paths.join('');
}

function preparePuzzle(puzzle) {
  if (!puzzle || typeof puzzle !== 'object' || !puzzle.targets || !Array.isArray(puzzle.pieces) || !puzzle.pieces.length || puzzle.pieces.length > 4096) throw new TypeError('A generated puzzle with targets and pieces is required.');
  const targets = {};
  const targetOffsets = {};
  for (const side of ['a', 'b']) {
    const source = puzzle.targets[side];
    if (!source || typeof source !== 'object') throw new TypeError(`Target ${side} is required.`);
    const width = finite(source.width, `Target ${side} width`, 1, MAX_COORDINATE, true);
    const height = finite(source.height, `Target ${side} height`, 1, MAX_COORDINATE, true);
    const cells = readCells(source.cells, `Target ${side}`);
    if (cells.some(([x, y]) => x < 0 || y < 0 || x >= width || y >= height)) throw new TypeError(`Target ${side} cells exceed its dimensions.`);
    const bounds = boundsForCells(cells);
    targets[side] = new Set(cells.map(cellKey));
    targetOffsets[side] = Object.freeze({ x: -(bounds.minX + bounds.maxX) / 2, y: -(bounds.minY + bounds.maxY) / 2 });
  }
  const covered = { a: new Set(), b: new Set() };
  let totalCells = 0;
  const pieces = puzzle.pieces.map((source, index) => {
    if (!source || typeof source !== 'object') throw new TypeError(`Piece ${index + 1} is invalid.`);
    const cells = readCells(source.cells, `Piece ${index + 1}`, true);
    totalCells += cells.length;
    if (totalCells > MAX_CELLS) throw new TypeError(`A puzzle cannot contain more than ${MAX_CELLS} piece cells.`);
    const localCenter = cells.reduce((center, [x, y]) => ({ x: center.x + (x + 0.5) / cells.length, y: center.y + (y + 0.5) / cells.length }), { x: 0, y: 0 });
    let radius = 0;
    for (const [x, y] of cells) for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) radius = Math.max(radius, Math.hypot(x + dx - localCenter.x, y + dy - localCenter.y));
    const endpoints = {};
    for (const side of ['a', 'b']) {
      const pose = source[side];
      if (!pose || typeof pose !== 'object') throw new TypeError(`Piece ${index + 1} needs its ${side} pose.`);
      const x = finite(pose.x, `Piece ${index + 1} ${side} x`, -MAX_COORDINATE, MAX_COORDINATE, true);
      const y = finite(pose.y, `Piece ${index + 1} ${side} y`, -MAX_COORDINATE, MAX_COORDINATE, true);
      const turn = finite(pose.turn, `Piece ${index + 1} ${side} turn`, 0, 3, true);
      for (const [cx, cy] of cells) {
        const [rx, ry] = rotateCell(cx, cy, turn);
        const key = `${x + rx},${y + ry}`;
        if (!targets[side].has(key) || covered[side].has(key)) throw new TypeError(`Pieces do not cover target ${side} exactly once.`);
        covered[side].add(key);
      }
      const centered = rotatePoint(localCenter.x, localCenter.y, turn * 90);
      endpoints[side] = Object.freeze({
        x: x + targetOffsets[side].x, y: y + targetOffsets[side].y, angle: turn * 90,
        centerX: x + targetOffsets[side].x + centered.x, centerY: y + targetOffsets[side].y + centered.y,
      });
    }
    return Object.freeze({
      index, cells: Object.freeze(cells.map(point => Object.freeze(point))), path: outline(cells),
      localCenter: Object.freeze(localCenter), radius, a: endpoints.a, b: endpoints.b,
      angleDelta: modulo(endpoints.b.angle - endpoints.a.angle + 180, 360) - 180,
    });
  });
  for (const side of ['a', 'b']) if (covered[side].size !== targets[side].size) throw new TypeError(`Pieces do not cover target ${side} exactly once.`);
  const names = ['first', 'second'].map((key, index) => {
    const value = puzzle[key] ?? (index ? 'Second arrangement' : 'First arrangement');
    if (typeof value !== 'string' || value.length > 256) throw new TypeError('Puzzle names must be strings of at most 256 characters.');
    return value;
  });
  return { pieces: Object.freeze(pieces), targetOffsets: Object.freeze(targetOffsets), names };
}

function layoutFor(pieces, settings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const piece of pieces) {
    // The centroid stays on the segment joining its two endpoint centroids.
    // Every corner is within radius of that centroid at every rotation.
    // These bounds therefore cover continuous motion, not just sampled frames.
    minX = Math.min(minX, Math.min(piece.a.centerX, piece.b.centerX) - piece.radius);
    minY = Math.min(minY, Math.min(piece.a.centerY, piece.b.centerY) - piece.radius);
    maxX = Math.max(maxX, Math.max(piece.a.centerX, piece.b.centerX) + piece.radius);
    maxY = Math.max(maxY, Math.max(piece.a.centerY, piece.b.centerY) + piece.radius);
  }
  // Keep the occupied center of each completed word at the canvas center.
  // Symmetric bounds preserve that position while still covering all motion.
  const extentX = Math.max(Math.abs(minX), Math.abs(maxX));
  const extentY = Math.max(Math.abs(minY), Math.abs(maxY));
  minX = -extentX; maxX = extentX;
  minY = -extentY; maxY = extentY;
  const margin = Object.freeze({ x: settings.width * 0.1, y: settings.height * (settings.theme === 'plain' ? 0.1 : 0.21) });
  const worldBounds = Object.freeze({ minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY });
  const scale = Math.min((settings.width - 2 * margin.x) / worldBounds.width, (settings.height - 2 * margin.y) / worldBounds.height);
  const centerX = settings.width / 2 - (minX + maxX) / 2 * scale;
  const centerY = settings.height / 2 - (minY + maxY) / 2 * scale;
  const contentBounds = Object.freeze({ minX: minX * scale + centerX, minY: minY * scale + centerY, maxX: maxX * scale + centerX, maxY: maxY * scale + centerY });
  return Object.freeze({ scale, centerX, centerY, worldBounds, contentBounds, margin });
}

function decorations(settings) {
  const { theme, width, height, colors } = settings;
  if (theme === 'plain') return '';
  const scale = Math.min(width, height) / 1080 * 1.6;
  const positions = [[0.1, 0.13], [0.22, 0.075], [0.37, 0.135], [0.53, 0.085], [0.69, 0.14], [0.83, 0.08], [0.92, 0.155],
    [0.08, 0.86], [0.21, 0.925], [0.36, 0.87], [0.51, 0.94], [0.66, 0.865], [0.81, 0.92], [0.93, 0.86]];
  const shapes = positions.map(([x, y], index) => {
    const color = theme === 'new-year' ? ['#e8cd8b', '#b8c4d8', '#d0ab65'][index % 3] : colors[index % colors.length];
    let shape;
    if (theme === 'birthday') {
      shape = index % 3 === 0 ? '<circle r="5.5"/>' : index % 3 === 1
        ? '<rect x="-3" y="-9" width="6" height="18" rx="2"/>'
        : '<path d="M0 -7L6 0L0 7L-6 0Z"/>';
    } else if (theme === 'holidays') {
      shape = index % 3 === 0 ? '<circle r="3.1"/>' : index % 3 === 1
        ? '<path d="M-9 0H9M0 -9V9M-6.4 -6.4L6.4 6.4M-6.4 6.4L6.4 -6.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
        : '<path d="M0 -8L2 -2L8 0L2 2L0 8L-2 2L-8 0L-2 -2Z"/>';
    } else {
      shape = index % 3 === 0 ? '<circle r="2.7"/>' : index % 3 === 1
        ? '<path d="M0 -11L2.1 -2.1L11 0L2.1 2.1L0 11L-2.1 2.1L-11 0L-2.1 -2.1Z"/>'
        : '<path d="M-7 0H7M0 -7V7M-5 -5L5 5M-5 5L5 -5" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"/>';
    }
    return `<g transform="translate(${number(x * width)} ${number(y * height)}) rotate(${index * 31 % 90 - 45}) scale(${number(scale)})" fill="${color}" color="${color}" opacity="${theme === 'birthday' ? '0.75' : '0.6'}">${shape}</g>`;
  });
  return `<g aria-hidden="true">${shapes.join('')}</g>`;
}

/**
 * Prepare a deterministic, fixed-frame animation from an existing puzzle.
 * Target centering uses occupied bounds and translation only. Dimensions and
 * durations refer to the export, and never change the generated piece shapes.
 * `layout.centerX/centerY` are the world-to-pixel translation after scaling.
 */
export function createAnimation(puzzle, options = {}) {
  const settings = settingsFor(options);
  const { pieces, targetOffsets, names } = preparePuzzle(puzzle);
  const layout = layoutFor(pieces, settings);
  const { width, height, fps, holdFrames, transitionFrames } = settings;
  const halfFrames = holdFrames + transitionFrames;
  const frameCount = halfFrames * 2;
  const duration = frameCount / fps;
  const decoration = decorations(settings);
  const title = xml(`${names[0]} becomes ${names[1]}`);
  const stroke = THEMES[settings.theme].stroke;
  const strokeWidth = Math.max(0.35, Math.min(width, height) / 1080);

  function getFrame(index) {
    finite(index, 'Frame index', 0, frameCount - 1, true);
    let phase, progress;
    if (index < holdFrames) { phase = 'hold-a'; progress = 0; }
    else if (index < halfFrames) { phase = 'a-to-b'; progress = ease((index - holdFrames) / transitionFrames); }
    else if (index < halfFrames + holdFrames) { phase = 'hold-b'; progress = 1; }
    else { phase = 'b-to-a'; progress = 1 - ease((index - halfFrames - holdFrames) / transitionFrames); }
    const poses = pieces.map(piece => {
      const angle = piece.a.angle + piece.angleDelta * progress;
      const centerX = piece.a.centerX + (piece.b.centerX - piece.a.centerX) * progress;
      const centerY = piece.a.centerY + (piece.b.centerY - piece.a.centerY) * progress;
      const localCenter = rotatePoint(piece.localCenter.x, piece.localCenter.y, angle);
      return { index: piece.index, x: centerX - localCenter.x, y: centerY - localCenter.y, angle, centerX, centerY };
    });
    return { index, timeSeconds: index / fps, phase, progress, pieces: poses };
  }

  function renderFrame(index) {
    const frame = getFrame(index);
    const shapes = frame.pieces.map(pose => `<g data-piece-index="${pose.index}" transform="translate(${number(pose.x)} ${number(pose.y)}) rotate(${number(pose.angle)})"><path d="${pieces[pose.index].path}" fill="${settings.colors[pose.index % settings.colors.length]}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${number(strokeWidth)}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></g>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${title}</title><desc>The same rigid pieces form both arrangements. Pieces can overlap during the transition.</desc><rect width="${width}" height="${height}" fill="${settings.background}"/>${decoration}<g transform="translate(${number(layout.centerX)} ${number(layout.centerY)}) scale(${number(layout.scale)})">${shapes}</g></svg>\n`;
  }

  return Object.freeze({ width, height, fps, frameCount, duration, settings, layout, targetOffsets, pieces, getFrame, renderFrame });
}
