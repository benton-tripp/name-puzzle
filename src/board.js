const SVG_NS = 'http://www.w3.org/2000/svg';
const FALLBACK_COLORS = ['#cd7658', '#639182', '#d2ae60', '#788caa', '#a887a2', '#8b9c58', '#b48a65', '#729fa9'];
let boardSequence = 0;

const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor;
const copyPose = ({ x, y, turn }) => ({ x, y, turn: modulo(turn || 0, 4) });

function element(name, attributes = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function rotatedCell(x, y, turn) {
  if (turn === 1) return [-y - 1, x];
  if (turn === 2) return [-x - 1, -y - 1];
  if (turn === 3) return [y, -x - 1];
  return [x, y];
}

function geometry(cells, turn) {
  const points = cells.map(([x, y]) => rotatedCell(x, y, turn));
  const minX = Math.min(...points.map(([x]) => x));
  const minY = Math.min(...points.map(([, y]) => y));
  const width = Math.max(...points.map(([x]) => x)) - minX + 1;
  const height = Math.max(...points.map(([, y]) => y)) - minY + 1;
  const normalized = points.map(([x, y]) => [x - minX, y - minY]);
  normalized.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return { minX, minY, width, height, key: normalized.map(point => point.join(',')).join(';') };
}

function outline(cells) {
  const edges = new Map();
  const add = (x1, y1, x2, y2, direction) => {
    const from = `${x1},${y1}`;
    const to = `${x2},${y2}`;
    const reverse = `${to}>${from}`;
    if (edges.has(reverse)) edges.delete(reverse);
    else edges.set(`${from}>${to}`, { from, to, x1, y1, x2, y2, direction });
  };
  for (const [x, y] of cells) {
    add(x, y, x + 1, y, 0);
    add(x + 1, y, x + 1, y + 1, 1);
    add(x + 1, y + 1, x, y + 1, 2);
    add(x, y + 1, x, y, 3);
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
    paths.push(`${path}Z`);
  }
  return paths.join('');
}

function validCells(cells) {
  return Array.isArray(cells) && cells.length > 0 && cells.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isInteger));
}

export class PuzzleBoard {
  constructor(container, { onChange } = {}) {
    if (!container || typeof container.append !== 'function') throw new Error('A puzzle board container is required.');
    this.container = container;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.mode = 'view';
    this.target = 'a';
    this._puzzle = null;
    this._pieces = [];
    this._byId = new Map();
    this._byElement = new WeakMap();
    this._slots = [];
    this._selectedId = null;
    this._drag = null;
    this._scrollFrame = null;
    this._animation = null;
    this._resizeFrame = null;
    this._destroyed = false;
    this._zoom = 1;
    this._width = container.getBoundingClientRect().width || 640;
    this._pixelsPerUnit = 20;
    this._view = { x: 0, y: 0, width: 32, height: 12 };
    this._reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

    const descriptionId = `puzzle-board-description-${++boardSequence}`;
    this.svg = element('svg', {
      class: 'puzzle-svg', width: '100%', role: 'group',
      'aria-label': 'Word shape puzzle', 'aria-describedby': descriptionId,
      preserveAspectRatio: 'xMidYMid meet', hidden: '',
    });
    Object.assign(this.svg.style, { display: 'block', width: '100%', height: 'auto', userSelect: 'none', touchAction: 'pan-x pan-y pinch-zoom' });
    this.svg.style.webkitUserSelect = 'none';
    this._description = element('desc', { id: descriptionId });
    this._targetGroup = element('g', { class: 'puzzle-target', 'aria-hidden': 'true', 'pointer-events': 'none' });
    this._silhouette = element('path', { fill: 'var(--puzzle-target, #dfe4d9)', 'fill-rule': 'evenodd' });
    this._slotGroup = element('g', { class: 'puzzle-target-slots', fill: 'none', stroke: 'var(--ink, #253b33)', opacity: '0.28' });
    this._targetGroup.append(this._silhouette, this._slotGroup);
    this._labels = element('g', { 'aria-hidden': 'true', 'pointer-events': 'none', fill: 'var(--muted, #616b63)', 'font-family': 'inherit' });
    this._targetLabel = element('text', { 'text-anchor': 'middle' });
    this._targetLabel.textContent = 'Target';
    this._trayLabel = element('text');
    this._trayLabel.textContent = 'Pieces';
    this._trayLine = element('line', { stroke: 'var(--line, #d9ded2)', 'stroke-width': '1', 'vector-effect': 'non-scaling-stroke' });
    this._labels.append(this._targetLabel, this._trayLine, this._trayLabel);
    this._pieceGroup = element('g', { class: 'puzzle-pieces' });
    this.svg.append(this._description, this._targetGroup, this._labels, this._pieceGroup);
    container.append(this.svg);

    this._listeners = {
      pointermove: event => this._pointerMove(event),
      pointerup: event => this._pointerEnd(event, false),
      pointercancel: event => this._pointerEnd(event, true),
      lostpointercapture: event => this._pointerEnd(event, true),
      keydown: event => this._keyDown(event),
    };
    for (const [type, listener] of Object.entries(this._listeners)) this.svg.addEventListener(type, listener);
    this._onResize = () => {
      if (this._resizeFrame !== null || this._destroyed) return;
      this._resizeFrame = requestAnimationFrame(() => {
        this._resizeFrame = null;
        this._resize();
      });
    };
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._onResize);
      this._resizeObserver.observe(container);
    } else window.addEventListener('resize', this._onResize);
  }

  get placedCount() {
    return this._pieces.reduce((count, piece) => count + Number(piece.placed), 0);
  }

  get solved() {
    return this.mode === 'play' && this._pieces.length > 0 && this.placedCount === this._pieces.length;
  }

  setZoom(zoom) {
    if (this._destroyed || ![1, 1.5, 2, 3].includes(zoom)) return;
    this._cancelDrag();
    this._pixelsPerUnit *= zoom / this._zoom;
    this._zoom = zoom;
    this.container.style.width = `${zoom * 100}%`;
    this._refresh();
  }

  load(puzzle) {
    if (this._destroyed) return;
    if (!puzzle?.targets || !Array.isArray(puzzle.pieces) || !puzzle.pieces.length) throw new Error('The puzzle contains no pieces.');
    for (const side of ['a', 'b']) {
      const target = puzzle.targets[side];
      if (!target || !(target.width > 0) || !(target.height > 0) || !validCells(target.cells)) throw new Error('The puzzle contains an invalid outline.');
    }
    const ids = new Set();
    for (const [index, piece] of puzzle.pieces.entries()) {
      const id = piece.id ?? index;
      if (ids.has(id) || !validCells(piece.cells) || ['a', 'b'].some(side => !piece[side] || ![piece[side].x, piece[side].y, piece[side].turn].every(Number.isFinite))) throw new Error('The puzzle contains invalid pieces.');
      ids.add(id);
    }
    this._cancelAnimation();
    this._cancelDrag();
    this._puzzle = puzzle;
    this._selectedId = null;
    this._initialPoses = null;
    this._byId.clear();
    this._byElement = new WeakMap();
    this._pieceGroup.replaceChildren();
    this._pieces = puzzle.pieces.map((source, index) => this._makePiece(source, index));
    this.container.replaceChildren(this.svg);
    this.svg.removeAttribute('hidden');
    this._width = this.container.getBoundingClientRect().width / this._zoom || this._width;
    this.showArrangement('a', { animate: false });
  }

  showArrangement(target, { animate = true } = {}) {
    if (!this._puzzle || this._destroyed) return;
    this._checkTarget(target);
    this._cancelDrag();
    this.mode = 'view';
    this.target = target;
    this._selectedId = null;
    for (const piece of this._pieces) {
      piece.placed = false;
      piece.slotId = null;
      piece.atHome = false;
    }
    this._prepareTarget();
    const layout = this._layout(false);
    const poses = new Map(this._pieces.map(piece => [piece.id, copyPose(piece.source[target])]));
    this._transition(poses, layout, animate);
    this._refresh();
    this._notify();
  }

  scatter(target = 'b') {
    if (!this._puzzle || this._destroyed) return;
    this._checkTarget(target);
    this._cancelAnimation();
    this._cancelDrag();
    this.mode = 'play';
    this.target = target;
    this._selectedId = null;
    this._scatterTurns = new Map();
    for (const piece of this._pieces) {
      piece.placed = false;
      piece.slotId = null;
      piece.atHome = true;
      this._scatterTurns.set(piece.id, modulo(piece.source[target].turn + [1, 2, 3, 1, 0, 3, 2, 0][piece.index % 8], 4));
    }
    this._prepareTarget();
    const layout = this._layout(true);
    this._initialPoses = new Map([...layout.poses].map(([id, pose]) => [id, copyPose(pose)]));
    this._transition(layout.poses, layout, false);
    this._refresh();
    this._notify();
  }

  reset() {
    if (!this._puzzle || this._destroyed) return;
    if (this.mode !== 'play' || !this._initialPoses) return this.scatter(this.target);
    this._cancelAnimation();
    this._cancelDrag();
    this._selectedId = null;
    for (const piece of this._pieces) {
      piece.placed = false;
      piece.slotId = null;
      piece.atHome = true;
    }
    for (const slot of this._slots) slot.occupiedBy = null;
    const layout = this._layout(true);
    this._initialPoses = new Map([...layout.poses].map(([id, pose]) => [id, copyPose(pose)]));
    this._transition(this._initialPoses, layout, false);
    this._refresh();
    this._notify();
  }

  hint() {
    if (this.mode !== 'play' || this.solved || this._destroyed) return false;
    this._cancelDrag();
    const selected = this._byId.get(this._selectedId);
    const piece = selected && !selected.placed ? selected : this._pieces.filter(item => !item.placed).sort((a, b) => a.cells.length - b.cells.length || a.index - b.index)[0];
    if (!piece) return false;
    const slots = [...this._slots].sort((a, b) => Number(b.id === piece.id) - Number(a.id === piece.id));
    const turns = [piece.source[this.target].turn, 0, 1, 2, 3];
    for (const slot of slots) {
      if (slot.occupiedBy !== null) continue;
      for (const turn of turns) {
        const pose = this._fit(piece, slot, modulo(turn, 4));
        if (!pose) continue;
        this._place(piece, slot, pose);
        this._refresh();
        this._notify();
        return true;
      }
    }
    return false;
  }

  rotateSelected(direction = 1) {
    if (this.mode !== 'play' || this._animation || this._drag || this._destroyed) return false;
    const piece = this._byId.get(this._selectedId);
    if (!piece || piece.placed) return false;
    const oldBounds = piece.rotations[piece.pose.turn];
    const turn = modulo(piece.pose.turn + (direction < 0 ? -1 : 1), 4);
    const bounds = piece.rotations[turn];
    piece.pose = {
      x: piece.pose.x + oldBounds.minX + oldBounds.width / 2 - bounds.minX - bounds.width / 2,
      y: piece.pose.y + oldBounds.minY + oldBounds.height / 2 - bounds.minY - bounds.height / 2,
      turn,
    };
    piece.atHome = false;
    this._clamp(piece);
    this._trySnap(piece);
    this._renderPiece(piece);
    this._refresh();
    this._notify();
    return true;
  }

  destroy() {
    if (this._destroyed) return;
    this._cancelAnimation();
    this._cancelDrag();
    this._destroyed = true;
    if (this._resizeFrame !== null) cancelAnimationFrame(this._resizeFrame);
    this._resizeObserver?.disconnect();
    window.removeEventListener('resize', this._onResize);
    for (const [type, listener] of Object.entries(this._listeners)) this.svg.removeEventListener(type, listener);
    this.svg.remove();
    this._pieces = [];
    this._byId.clear();
  }

  _checkTarget(target) {
    if (target !== 'a' && target !== 'b') throw new Error('Choose the first or second arrangement.');
  }

  _makePiece(source, index) {
    const id = source.id ?? index;
    const cells = source.cells.map(point => [...point]);
    const path = outline(cells);
    const group = element('g', { class: 'puzzle-piece', 'data-piece-id': id, 'data-size': cells.length, tabindex: '-1' });
    Object.assign(group.style, { outline: 'none', touchAction: 'none' });
    const selection = element('path', {
      class: 'puzzle-piece-selection', d: path, fill: 'none', stroke: 'var(--piece-selection, #224c9a)',
      'stroke-width': '3', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke',
      'pointer-events': 'none', opacity: '0',
    });
    const shape = element('path', {
      class: 'puzzle-piece-shape', d: path, fill: `var(--piece-${index % 8 + 1}, ${FALLBACK_COLORS[index % 8]})`,
      'fill-rule': 'evenodd', stroke: 'var(--piece-stroke, rgba(25, 42, 34, 0.7))', 'stroke-width': '1',
      'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'visiblePainted',
    });
    shape.style.touchAction = 'none';
    const average = cells.reduce(([x, y], point) => [x + point[0] / cells.length, y + point[1] / cells.length], [0, 0]);
    const anchor = [...cells].sort((a, b) => (a[0] - average[0]) ** 2 + (a[1] - average[1]) ** 2 - (b[0] - average[0]) ** 2 - (b[1] - average[1]) ** 2)[0];
    const label = element('text', {
      x: anchor[0] + 0.5, y: anchor[1] + 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: 'var(--piece-label, #172c23)', 'font-family': 'inherit', 'font-weight': '650', 'pointer-events': 'none', 'aria-hidden': 'true',
    });
    label.textContent = String(index + 1);
    group.append(selection, shape, label);
    const piece = { id, index, source, cells, path, group, selection, shape, label, rotations: [0, 1, 2, 3].map(turn => geometry(cells, turn)), pose: copyPose(source.a), render: { x: source.a.x, y: source.a.y, angle: source.a.turn * 90 }, placed: false, atHome: false, slotId: null };
    group.addEventListener('pointerdown', event => this._pointerDown(event, piece));
    group.addEventListener('focus', () => {
      if (this.mode === 'play' && !piece.placed) this._select(piece.id);
      this._stylePiece(piece);
    });
    group.addEventListener('blur', () => this._stylePiece(piece));
    this._byId.set(id, piece);
    this._byElement.set(group, piece);
    this._pieceGroup.append(group);
    return piece;
  }

  _prepareTarget() {
    const target = this._puzzle.targets[this.target];
    this._silhouette.setAttribute('d', outline(target.cells));
    this._slots = this._pieces.map(piece => {
      const pose = copyPose(piece.source[this.target]);
      const bounds = piece.rotations[pose.turn];
      return { id: piece.id, bounds, x: pose.x + bounds.minX, y: pose.y + bounds.minY, occupiedBy: null, pose, piece };
    });
    this._slotGroup.replaceChildren(...this._slots.map(slot => element('path', {
      d: slot.piece.path, transform: `translate(${slot.pose.x} ${slot.pose.y}) rotate(${slot.pose.turn * 90})`,
      'stroke-width': '0.75', 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round',
    })));
    this._targetGroup.style.display = this.mode === 'play' ? '' : 'none';
    this._labels.style.display = this.mode === 'play' ? '' : 'none';
    const name = (this.target === 'a' ? this._puzzle.first : this._puzzle.second) || (this.target === 'a' ? 'the first arrangement' : 'the second arrangement');
    this.svg.setAttribute('aria-label', this.mode === 'play' ? `Arrange ${this._pieces.length} pieces to make ${name}.` : `Puzzle pieces arranged as ${name}.`);
    this._description.textContent = this.mode === 'play'
      ? 'Use Tab to select a piece. Arrow keys move one square. Shift and an arrow move five squares. R rotates clockwise. Shift and R rotate counterclockwise. Pieces lock when they fit an outlined position.'
      : 'The same pieces form both words or phrases. Use the arrangement controls to switch between them, or choose Play.';
  }

  _layout(play, minimumInnerWidth = 0, pass = 0) {
    const target = this._puzzle.targets[this.target];
    const pixels = Math.max(120, this._width);
    const edgePixels = 14;
    const minimumPieceWidth = play ? Math.max(...this._pieces.map(piece => Math.min(piece.rotations[0].width, piece.rotations[0].height))) : 0;
    const targetWidth = play ? target.width : Math.max(this._puzzle.targets.a.width, this._puzzle.targets.b.width);
    const minimumCanvasWidth = play && pixels >= 600 ? (pixels - edgePixels * 2) / 10 : Math.min(44, Math.max(16, pixels / 24));
    const innerWidth = Math.max(targetWidth, minimumPieceWidth, minimumCanvasWidth, minimumInnerWidth);
    const width = innerWidth / (1 - edgePixels * 2 / pixels);
    const scale = pixels / width;
    const padding = edgePixels / scale;
    const x = (target.width - width) / 2;
    if (!play) {
      const targetHeight = Math.max(this._puzzle.targets.a.height, this._puzzle.targets.b.height);
      const height = Math.max(targetHeight + padding * 2, 240 / scale);
      return { x, y: (target.height - height) / 2, width, height, scale };
    }
    const left = x + padding;
    const gap = Math.max(0.6, 11 / scale);
    const trayY = target.height + 44 / scale;
    const records = this._pieces.map(piece => {
      let turn = this._scatterTurns.get(piece.id) ?? 0;
      if (piece.rotations[turn].width > innerWidth + 0.0001) turn = modulo(turn + 1, 4);
      this._scatterTurns.set(piece.id, turn);
      return { piece, turn, bounds: piece.rotations[turn] };
    }).sort((a, b) => b.bounds.height - a.bounds.height || b.bounds.width - a.bounds.width || a.piece.index - b.piece.index);
    const rows = [];
    for (const record of records) {
      let row = rows.find(item => item.used + gap + record.bounds.width <= innerWidth + 0.0001);
      if (!row) {
        row = { height: record.bounds.height, used: 0, records: [] };
        rows.push(row);
      }
      const offset = row.records.length ? row.used + gap : 0;
      row.records.push({ ...record, offset });
      row.used = offset + record.bounds.width;
    }
    const poses = new Map();
    let y = trayY;
    for (const row of rows) {
      for (const record of row.records) {
        poses.set(record.piece.id, { x: left + record.offset - record.bounds.minX, y: y - record.bounds.minY, turn: record.turn });
      }
      y += row.height + gap;
    }
    const top = -28 / scale;
    const height = Math.max(y - gap + 16 / scale - top, 240 / scale);
    if (pixels >= 600 && height * scale > 560 && pass < 4) return this._layout(true, innerWidth * height * scale / 550, pass + 1);
    return { x, y: top, width, height, scale, left, trayY, poses };
  }

  _decorateLayout(layout) {
    this._pixelsPerUnit = layout.scale * this._zoom;
    if (this.mode !== 'play') return;
    const target = this._puzzle.targets[this.target];
    const fontSize = 11 / layout.scale;
    this._targetLabel.setAttribute('x', target.width / 2);
    this._targetLabel.setAttribute('y', -12 / layout.scale);
    this._targetLabel.setAttribute('font-size', fontSize);
    this._trayLabel.setAttribute('x', layout.left);
    this._trayLabel.setAttribute('y', target.height + 33 / layout.scale);
    this._trayLabel.setAttribute('font-size', fontSize);
    this._trayLine.setAttribute('x1', layout.left);
    this._trayLine.setAttribute('x2', layout.x + layout.width - 14 / layout.scale);
    this._trayLine.setAttribute('y1', target.height + 15 / layout.scale);
    this._trayLine.setAttribute('y2', target.height + 15 / layout.scale);
  }

  _setView(view) {
    this._view = { x: view.x, y: view.y, width: view.width, height: view.height };
    this.svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
    this.svg.style.aspectRatio = `${view.width} / ${view.height}`;
  }

  _transition(poses, layout, animate) {
    this._cancelAnimation();
    this._decorateLayout(layout);
    const fromView = { ...this._view };
    const records = this._pieces.map(piece => {
      const pose = poses.get(piece.id) || piece.pose;
      const from = { ...piece.render };
      piece.pose = copyPose(pose);
      const angle = from.angle + modulo(pose.turn * 90 - from.angle + 180, 360) - 180;
      return { piece, from, to: { x: pose.x, y: pose.y, angle } };
    });
    if (!animate || this._reducedMotion?.matches) {
      for (const { piece } of records) this._renderPiece(piece);
      this._setView(layout);
      return;
    }
    const started = performance.now();
    const animation = { frame: null };
    this._animation = animation;
    this.svg.setAttribute('aria-busy', 'true');
    const tick = now => {
      if (this._animation !== animation) return;
      const progress = Math.min(1, (now - started) / 650);
      const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
      for (const { piece, from, to } of records) {
        piece.render = { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased, angle: from.angle + (to.angle - from.angle) * eased };
        this._writeTransform(piece);
      }
      const view = {};
      for (const key of ['x', 'y', 'width', 'height']) view[key] = fromView[key] + (layout[key] - fromView[key]) * eased;
      this._setView(view);
      if (progress < 1) animation.frame = requestAnimationFrame(tick);
      else {
        this._animation = null;
        this.svg.removeAttribute('aria-busy');
        for (const { piece } of records) this._renderPiece(piece);
        this._setView(layout);
      }
    };
    animation.frame = requestAnimationFrame(tick);
  }

  _cancelAnimation() {
    if (this._animation) cancelAnimationFrame(this._animation.frame);
    this._animation = null;
    this.svg?.removeAttribute('aria-busy');
  }

  _renderPiece(piece) {
    piece.render = { x: piece.pose.x, y: piece.pose.y, angle: piece.pose.turn * 90 };
    this._writeTransform(piece);
  }

  _writeTransform(piece) {
    piece.group.setAttribute('transform', `translate(${piece.render.x} ${piece.render.y}) rotate(${piece.render.angle})`);
    piece.group.dataset.turn = String(piece.pose.turn);
  }

  _stylePiece(piece) {
    const playable = this.mode === 'play' && !piece.placed;
    const selected = playable && this._selectedId === piece.id;
    piece.group.setAttribute('role', this.mode === 'play' ? 'button' : 'img');
    piece.group.setAttribute('tabindex', playable ? '0' : '-1');
    piece.group.setAttribute('aria-label', `Piece ${piece.index + 1}, ${piece.cells.length} ${piece.cells.length === 1 ? 'cell' : 'cells'}${piece.placed ? ', placed' : ''}.`);
    if (this.mode === 'play') {
      piece.group.setAttribute('aria-pressed', String(selected));
      piece.group.setAttribute('aria-disabled', String(!playable));
    } else {
      piece.group.removeAttribute('aria-pressed');
      piece.group.removeAttribute('aria-disabled');
    }
    piece.group.dataset.placed = String(piece.placed);
    piece.group.style.cursor = playable ? (this._drag?.id === piece.id ? 'grabbing' : 'grab') : 'default';
    piece.group.style.pointerEvents = playable ? 'auto' : 'none';
    piece.shape.setAttribute('pointer-events', playable ? 'visiblePainted' : 'none');
    piece.selection.setAttribute('opacity', selected || (playable && document.activeElement === piece.group) ? '1' : '0');
    piece.shape.setAttribute('stroke-width', this._pixelsPerUnit < 8 ? '0.6' : '1');
    piece.label.style.display = this.mode === 'play' && this._pixelsPerUnit >= 16 ? '' : 'none';
    piece.label.setAttribute('font-size', Math.min(0.68, 10 / this._pixelsPerUnit));
  }

  _refresh() {
    for (const piece of this._pieces) this._stylePiece(piece);
  }

  _select(id, focus = false) {
    const piece = this._byId.get(id);
    if (!piece || piece.placed || this.mode !== 'play') return;
    const changed = this._selectedId !== id;
    this._selectedId = id;
    this._refresh();
    if (focus && document.activeElement !== piece.group) piece.group.focus({ preventScroll: true });
    if (changed) this._notify();
  }

  _point(event) {
    const matrix = this.svg.getScreenCTM();
    if (!matrix) return null;
    const point = this.svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(matrix.inverse());
  }

  _revealPiece(piece) {
    const viewport = this.container.parentElement;
    if (!viewport?.classList.contains('is-zoomed')) return;
    const bounds = viewport.getBoundingClientRect();
    const item = piece.group.getBoundingClientRect();
    const offset = (start, end, visibleStart, visibleEnd) => {
      if (end - start > visibleEnd - visibleStart - 24) return (start + end - visibleStart - visibleEnd) / 2;
      if (start < visibleStart + 12) return start - visibleStart - 12;
      if (end > visibleEnd - 12) return end - visibleEnd + 12;
      return 0;
    };
    viewport.scrollLeft += offset(item.left, item.right, bounds.left, bounds.right);
    viewport.scrollTop += offset(item.top, item.bottom, bounds.top, bounds.bottom);
  }

  _pointerDown(event, piece) {
    if (this.mode !== 'play' || piece.placed || this._animation || this._drag || event.button !== 0) return;
    const point = this._point(event);
    if (!point) return;
    if (event.cancelable) event.preventDefault();
    this._select(piece.id, true);
    this._pieceGroup.append(piece.group);
    this._drag = { id: piece.id, pointerId: event.pointerId, offsetX: point.x - piece.pose.x, offsetY: point.y - piece.pose.y, clientX: event.clientX, clientY: event.clientY, lastX: event.clientX, lastY: event.clientY, start: copyPose(piece.pose), atHome: piece.atHome, moved: false };
    try { this.svg.setPointerCapture(event.pointerId); } catch { /* Capture can end when the pointer is released. */ }
    this._stylePiece(piece);
  }

  _pointerMove(event) {
    const drag = this._drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.cancelable) event.preventDefault();
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 3) return;
    const point = this._point(event);
    if (!point) return;
    const piece = this._byId.get(drag.id);
    drag.moved = true;
    piece.atHome = false;
    piece.pose.x = point.x - drag.offsetX;
    piece.pose.y = point.y - drag.offsetY;
    this._clamp(piece);
    this._renderPiece(piece);
    this._scrollDuringDrag();
  }

  _scrollDuringDrag() {
    if (this._scrollFrame !== null || !this._drag?.moved) return;
    const viewport = this.container.parentElement;
    if (!viewport?.classList.contains('is-zoomed')) return;
    const tick = () => {
      this._scrollFrame = null;
      const drag = this._drag;
      if (!drag) return;
      const bounds = viewport.getBoundingClientRect();
      const speed = (position, start, end) => position < start + 32
        ? -Math.min(12, (start + 32 - position) / 2)
        : position > end - 32 ? Math.min(12, (position - end + 32) / 2) : 0;
      const beforeX = viewport.scrollLeft;
      const beforeY = viewport.scrollTop;
      viewport.scrollLeft += speed(drag.lastX, bounds.left, bounds.right);
      viewport.scrollTop += speed(drag.lastY, bounds.top, bounds.bottom);
      if (viewport.scrollLeft === beforeX && viewport.scrollTop === beforeY) return;
      const point = this._point({ clientX: drag.lastX, clientY: drag.lastY });
      const piece = this._byId.get(drag.id);
      if (point && piece) {
        piece.pose.x = point.x - drag.offsetX;
        piece.pose.y = point.y - drag.offsetY;
        this._clamp(piece);
        this._renderPiece(piece);
      }
      this._scrollFrame = requestAnimationFrame(tick);
    };
    this._scrollFrame = requestAnimationFrame(tick);
  }

  _pointerEnd(event, canceled) {
    if (!this._drag || event.pointerId !== this._drag.pointerId) return;
    const drag = this._drag;
    const piece = this._byId.get(drag.id);
    this._drag = null;
    if (this._scrollFrame !== null) cancelAnimationFrame(this._scrollFrame);
    this._scrollFrame = null;
    try { if (this.svg.hasPointerCapture(drag.pointerId)) this.svg.releasePointerCapture(drag.pointerId); } catch { /* The browser may already have released capture. */ }
    if (canceled) {
      piece.pose = drag.start;
      piece.atHome = drag.atHome;
    } else if (drag.moved) this._trySnap(piece);
    this._renderPiece(piece);
    this._refresh();
    this._notify();
    this._resize();
  }

  _cancelDrag() {
    if (this._drag) this._pointerEnd({ pointerId: this._drag.pointerId }, true);
  }

  _clamp(piece) {
    const bounds = piece.rotations[piece.pose.turn];
    const inset = Math.min(0.15, 2 / this._pixelsPerUnit);
    const minX = this._view.x + inset - bounds.minX;
    const minY = this._view.y + inset - bounds.minY;
    const maxX = this._view.x + this._view.width - inset - bounds.minX - bounds.width;
    const maxY = this._view.y + this._view.height - inset - bounds.minY - bounds.height;
    piece.pose.x = Math.max(minX, Math.min(Math.max(minX, maxX), piece.pose.x));
    piece.pose.y = Math.max(minY, Math.min(Math.max(minY, maxY), piece.pose.y));
  }

  _fit(piece, slot, turn) {
    const bounds = piece.rotations[turn];
    if (bounds.key !== slot.bounds.key) return null;
    return { x: slot.x - bounds.minX, y: slot.y - bounds.minY, turn };
  }

  _trySnap(piece) {
    const threshold = Math.min(0.8, Math.max(0.35, 7 / this._pixelsPerUnit));
    let closest = null;
    for (const slot of this._slots) {
      if (slot.occupiedBy !== null) continue;
      const pose = this._fit(piece, slot, piece.pose.turn);
      if (!pose) continue;
      const distance = Math.hypot(pose.x - piece.pose.x, pose.y - piece.pose.y);
      if (distance <= threshold && (!closest || distance < closest.distance)) closest = { slot, pose, distance };
    }
    if (!closest) return false;
    this._place(piece, closest.slot, closest.pose);
    return true;
  }

  _place(piece, slot, pose) {
    piece.pose = copyPose(pose);
    piece.placed = true;
    piece.atHome = false;
    piece.slotId = slot.id;
    slot.occupiedBy = piece.id;
    if (this._selectedId === piece.id) this._selectedId = null;
    this._renderPiece(piece);
  }

  _keyDown(event) {
    if (this.mode !== 'play' || this._animation || this._drag || event.altKey || event.ctrlKey || event.metaKey) return;
    const group = event.target.closest?.('.puzzle-piece');
    const focused = group ? this._byElement.get(group) : null;
    const piece = focused && !focused.placed ? focused : this._byId.get(this._selectedId);
    if (!piece || piece.placed) return;
    const key = event.key.toLowerCase();
    if (key === 'enter' || key === ' ' || key === 'spacebar') {
      event.preventDefault();
      this._select(piece.id);
      return;
    }
    const directions = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (!directions[key] && key !== 'r') return;
    event.preventDefault();
    this._select(piece.id);
    if (key === 'r') this.rotateSelected(event.shiftKey ? -1 : 1);
    else {
      const distance = event.shiftKey ? 5 : 1;
      piece.pose.x = Math.round(piece.pose.x) + directions[key][0] * distance;
      piece.pose.y = Math.round(piece.pose.y) + directions[key][1] * distance;
      piece.atHome = false;
      this._clamp(piece);
      this._trySnap(piece);
      this._renderPiece(piece);
      this._refresh();
      this._notify();
    }
    if (piece.placed) {
      const next = this._pieces.find(item => !item.placed);
      if (next) {
        this._select(next.id, true);
        this._revealPiece(next);
      }
    } else this._revealPiece(piece);
  }

  _resize() {
    if (this._destroyed || this._drag) return;
    const width = this.container.getBoundingClientRect().width / this._zoom;
    if (!width || Math.abs(width - this._width) < 1) return;
    this._width = width;
    if (!this._puzzle) return;
    this._cancelAnimation();
    const layout = this._layout(this.mode === 'play');
    this._decorateLayout(layout);
    this._setView(layout);
    if (this.mode === 'play') {
      this._initialPoses = new Map([...layout.poses].map(([id, pose]) => [id, copyPose(pose)]));
      for (const piece of this._pieces) {
        if (piece.placed) continue;
        if (piece.atHome) piece.pose = copyPose(layout.poses.get(piece.id));
        else this._clamp(piece);
      }
    }
    for (const piece of this._pieces) this._renderPiece(piece);
    this._refresh();
  }

  _notify() {
    this.onChange({ mode: this.mode, target: this.target, placed: this.placedCount, total: this._pieces.length, solved: this.solved, selectedId: this._selectedId });
  }
}
