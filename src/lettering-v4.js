import { FONT_V3 } from './glyphs-v3.js';
import { FONT_V4_EXTRA } from './glyphs-v4-extra.js';
import { isCanonicalText } from './text.js';

const MIN_AREA = 400;
const MAX_AREA = 1800;
const MIN_CAP_HEIGHT = 15;
const PADDING = 1;
const LETTER_GAP = 2;
const MAX_LINE_RATIO = 4.5;

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function dataFailure() {
  return failure('Letter shape data is incomplete.', 'FONT_DATA');
}

const families = Object.entries(FONT_V3)
  .map(([key, font]) => {
    const size = Number(key);
    const extra = FONT_V4_EXTRA[key];
    if (!Number.isSafeInteger(size) || size <= 0
      || !Number.isSafeInteger(font.height) || font.height <= 0
      || !Number.isSafeInteger(font.capHeight) || font.capHeight <= 0
      || !Number.isSafeInteger(font.baseline) || font.baseline < 0
      || font.baseline > font.height || !font.glyphs
      || !extra || extra.height !== font.height || extra.capHeight !== font.capHeight
      || extra.baseline !== font.baseline || !extra.glyphs) throw dataFailure();
    return { size, font: { ...font, glyphs: { ...font.glyphs, ...extra.glyphs } } };
  })
  .sort((a, b) => a.size - b.size);

function characterCounts(name) {
  const counts = new Map();
  for (const character of name) {
    if (character !== ' ') counts.set(character, (counts.get(character) || 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function weightedOptions(font, character, count) {
  const records = font.glyphs[character];
  if (!records?.length) return [];
  if (records.length > 0x10000) throw dataFailure();
  return records.map((record, index) => {
    const [width, area, cost, hex] = record;
    if (!Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(area) || area <= 0 || area > width * font.height
      || !Number.isSafeInteger(cost) || cost < 0 || typeof hex !== 'string'
      || hex.length !== 2 * Math.ceil(width * font.height / 8)) throw dataFailure();
    return { area: count * area, cost: count * cost, token: index.toString(16).padStart(4, '0') };
  });
}

function reachable(name, onStep) {
  const counts = characterCounts(name);
  const bestCosts = new Float64Array(MAX_AREA + 1).fill(Infinity);
  const bestFamilies = new Int32Array(MAX_AREA + 1).fill(-1);
  const bestPaths = new Array(MAX_AREA + 1);
  let transitions = 0;

  for (let familyIndex = 0; familyIndex < families.length; familyIndex += 1) {
    const { font } = families[familyIndex];
    if (font.capHeight < MIN_CAP_HEIGHT) {
      onStep?.((familyIndex + 1) / families.length);
      continue;
    }
    const groups = counts.map(([character, count]) => weightedOptions(font, character, count));
    if (groups.some(options => options.length === 0)) {
      onStep?.((familyIndex + 1) / families.length);
      continue;
    }
    const remainingMin = new Array(groups.length + 1).fill(0);
    const remainingMax = new Array(groups.length + 1).fill(0);
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      remainingMin[index] = remainingMin[index + 1] + Math.min(...groups[index].map(option => option.area));
      remainingMax[index] = remainingMax[index + 1] + Math.max(...groups[index].map(option => option.area));
    }
    if (remainingMin[0] > MAX_AREA || remainingMax[0] < MIN_AREA) {
      onStep?.((familyIndex + 1) / families.length);
      continue;
    }

    let costs = new Float64Array(MAX_AREA + 1).fill(Infinity);
    let paths = new Array(MAX_AREA + 1);
    let active = [0];
    costs[0] = 0;
    paths[0] = '';

    for (let index = 0; index < groups.length; index += 1) {
      const nextCosts = new Float64Array(MAX_AREA + 1).fill(Infinity);
      const nextPaths = new Array(MAX_AREA + 1);
      const nextActive = [];
      for (const total of active) {
        for (const option of groups[index]) {
          transitions += 1;
          const area = total + option.area;
          if (area + remainingMin[index + 1] > MAX_AREA
            || area + remainingMax[index + 1] < MIN_AREA) continue;
          const cost = costs[total] + option.cost;
          if (cost > nextCosts[area]) continue;
          // Fixed-width hexadecimal indices preserve numeric lexicographic ties.
          const path = paths[total] + option.token;
          if (cost === nextCosts[area] && path >= nextPaths[area]) continue;
          if (nextCosts[area] === Infinity) nextActive.push(area);
          nextCosts[area] = cost;
          nextPaths[area] = path;
        }
      }
      costs = nextCosts;
      paths = nextPaths;
      active = nextActive;
      if (active.length === 0) break;
    }

    for (const area of active) {
      if (area < MIN_AREA || area > MAX_AREA) continue;
      const oldFamily = bestFamilies[area];
      const cost = costs[area];
      const path = paths[area];
      if (cost > bestCosts[area]) continue;
      if (cost === bestCosts[area] && oldFamily >= 0) {
        const size = families[familyIndex].size;
        const oldSize = families[oldFamily].size;
        if (size > oldSize || (size === oldSize && path >= bestPaths[area])) continue;
      }
      bestCosts[area] = cost;
      bestFamilies[area] = familyIndex;
      bestPaths[area] = path;
    }
    onStep?.((familyIndex + 1) / families.length);
  }

  let count = 0;
  for (let area = MIN_AREA; area <= MAX_AREA; area += 1) {
    if (bestFamilies[area] >= 0) count += 1;
  }
  return { counts, costs: bestCosts, familyIndices: bestFamilies, paths: bestPaths, count, transitions };
}

function decode(record, height) {
  const [width, expectedArea, , hex] = record;
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw dataFailure();
  const cells = [];
  for (let byte = 0; byte < hex.length / 2; byte += 1) {
    const bits = Number.parseInt(hex.slice(byte * 2, byte * 2 + 2), 16);
    for (let bit = 0; bit < 8; bit += 1) {
      const index = byte * 8 + bit;
      if (index >= width * height || !(bits & (1 << bit))) continue;
      cells.push([index % width, Math.floor(index / width)]);
    }
  }
  if (cells.length !== expectedArea) throw dataFailure();
  return cells;
}

function textWidth(text, selected, wordGap) {
  let width = 0;
  let pendingGap = 0;
  for (const character of text) {
    if (character === ' ') { pendingGap = wordGap; continue; }
    width += pendingGap + selected.get(character).record[0];
    pendingGap = LETTER_GAP;
  }
  return width;
}

function splitLines(text, selected, font, wordGap) {
  const fullWidth = textWidth(text, selected, wordGap);
  if (fullWidth <= MAX_LINE_RATIO * font.capHeight || !text.includes(' ')) {
    return [{ text, start: 0, width: fullWidth }];
  }
  let best;
  for (let index = 1; index < text.length - 1; index += 1) {
    if (text[index] !== ' ') continue;
    const left = text.slice(0, index);
    const right = text.slice(index + 1);
    // A punctuation-only line would be difficult to read as part of the phrase.
    if (!/[A-Z0-9]/.test(left) || !/[A-Z0-9]/.test(right)) continue;
    const widths = [textWidth(left, selected, wordGap), textWidth(right, selected, wordGap)];
    const maximum = Math.max(...widths);
    const difference = Math.abs(widths[0] - widths[1]);
    if (!best || maximum < best.maximum || (maximum === best.maximum && difference < best.difference)) {
      best = { index, maximum, difference, widths };
    }
  }
  if (!best) return [{ text, start: 0, width: fullWidth }];
  return [
    { text: text.slice(0, best.index), start: 0, width: best.widths[0] },
    { text: text.slice(best.index + 1), start: best.index + 1, width: best.widths[1] },
  ];
}

function buildTarget(name, area, choices) {
  const { size, font } = families[choices.familyIndices[area]];
  const path = choices.paths[area];
  const selected = new Map();
  for (const [index, [character]] of choices.counts.entries()) {
    const variantIndex = Number.parseInt(path.slice(index * 4, index * 4 + 4), 16);
    const record = font.glyphs[character][variantIndex];
    selected.set(character, { variantIndex, record, cells: decode(record, font.height) });
  }
  const wordGap = Math.max(LETTER_GAP + 2, Math.round(font.capHeight * 0.4));
  const lineGap = Math.max(4, Math.round(font.capHeight * 0.3));
  const textLines = splitLines(name, selected, font, wordGap);
  const inkWidth = Math.max(...textLines.map(line => line.width));
  const width = inkWidth + PADDING * 2;
  const height = font.height * textLines.length + lineGap * (textLines.length - 1) + PADDING * 2;
  const mask = new Uint8Array(width * height);
  const cells = [];
  const glyphs = [];
  const lines = [];
  for (const [lineIndex, line] of textLines.entries()) {
    const left = PADDING + Math.floor((inkWidth - line.width) / 2);
    const y = PADDING + lineIndex * (font.height + lineGap);
    lines.push({ text: line.text, x: left, y, width: line.width, baseline: y + font.baseline });
    let x = left;
    let pendingGap = 0;
    for (const [offset, character] of [...line.text].entries()) {
      if (character === ' ') { pendingGap = wordGap; continue; }
      x += pendingGap;
      const choice = selected.get(character);
      const [glyphWidth, glyphArea] = choice.record;
      const glyphCells = choice.cells.map(([xx, yy]) => [x + xx, y + yy]);
      for (const point of glyphCells) {
        mask[point[1] * width + point[0]] = 1;
        cells.push(point);
      }
      glyphs.push({ index: line.start + offset, character, variantIndex: choice.variantIndex,
        line: lineIndex, x, y, width: glyphWidth, area: glyphArea, cells: glyphCells });
      x += glyphWidth;
      pendingGap = LETTER_GAP;
    }
  }
  if (cells.length !== area) throw dataFailure();
  return { width, height, mask, cells, glyphs, lines,
    font: { size, capHeight: font.capHeight, baseline: font.baseline + PADDING,
      baselines: lines.map(line => line.baseline) } };
}

/** Match complete text using fixed glyph variants and deterministic word wrapping. */
export function createTextTargets(first, second, { onProgress } = {}) {
  for (const name of [first, second]) {
    if (!isCanonicalText(name)) {
      throw failure('Use 2 to 12 uppercase letters, numbers, or symbols, with single spaces.', 'INVALID_TEXT');
    }
  }
  const report = progress => onProgress?.({ stage: 'Preparing letter shapes', progress });
  report(0);
  const aChoices = reachable(first, progress => report(progress / 2));
  const bChoices = first === second ? aChoices : reachable(second, progress => report(0.5 + progress / 2));
  const firstLength = first.replace(/ /g, '').length;
  const secondLength = second.replace(/ /g, '').length;
  const ideal = Math.max(MIN_AREA, 105 * Math.max(firstLength, secondLength));
  let selectedArea = -1;
  let selectedScore = Infinity;
  let selectedDistance = Infinity;
  let commonAreas = 0;

  for (let area = MIN_AREA; area <= MAX_AREA; area += 1) {
    if (aChoices.familyIndices[area] < 0 || bChoices.familyIndices[area] < 0) continue;
    commonAreas += 1;
    const distance = Math.abs(area - ideal);
    // Costs are scaled by 10000. Multiplying the averaged objective by
    // 10 * firstLength * secondLength keeps the complete comparison integral.
    const score = 10 * secondLength * aChoices.costs[area]
      + 10 * firstLength * bChoices.costs[area]
      + firstLength * secondLength * distance * distance;
    if (!Number.isSafeInteger(score)) throw dataFailure();
    if (score < selectedScore || (score === selectedScore
      && (distance < selectedDistance || (distance === selectedDistance && area < selectedArea)))) {
      selectedArea = area;
      selectedScore = score;
      selectedDistance = distance;
    }
  }
  if (selectedArea < 0) {
    throw failure('These entries cannot be matched within the current puzzle size. Try fewer characters or symbols.', 'NO_MATCHING_AREA');
  }
  const a = buildTarget(first, selectedArea, aChoices);
  const b = buildTarget(second, selectedArea, bChoices);
  report(1);
  return { a, b, area: selectedArea,
    metrics: { commonAreas, reachableAreas: [aChoices.count, bChoices.count],
      matchingTransitions: aChoices.transitions + (aChoices === bChoices ? 0 : bChoices.transitions),
      matchingScore: selectedScore, fontSizes: [a.font.size, b.font.size] } };
}
