import { isCanonicalText } from './text.js';

const NAME_PATTERN = /^[A-Z]{2,10}$/;
const PALETTES = new Set(['classic', 'ocean', 'sunset', 'solid']);

function validText(value, version) {
  return typeof value === 'string' && (version === 4 ? isCanonicalText(value) : NAME_PATTERN.test(value));
}

function validAppearance(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && PALETTES.has(value.palette)
    && (value.palette === 'solid'
      ? /^#[0-9a-f]{6}$/.test(value.color || '')
      : value.color === undefined);
}

export function encodeShare({ first, second, seed, version = 1, splitSharedLetters = false, appearance }) {
  if (![1, 2, 3, 4].includes(version) || typeof splitSharedLetters !== 'boolean' || (version === 1 && splitSharedLetters) || !validText(first, version) || !validText(second, version) || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || (appearance !== undefined && !validAppearance(appearance))) {
    throw new Error('This puzzle cannot be shared. Generate it again.');
  }
  const parameters = new URLSearchParams({ v: String(version), a: first, b: second, s: String(seed) });
  if (version >= 2) parameters.set('split', splitSharedLetters ? '1' : '0');
  if (appearance !== undefined) {
    parameters.set('p', appearance.palette);
    if (appearance.palette === 'solid') parameters.set('c', appearance.color.slice(1));
  }
  return `#${parameters}`;
}

export function decodeShare(hash) {
  if (!hash || hash === '#') return null;
  if (hash.length > 200) throw new Error('This puzzle link is too long. Enter the words to make a new puzzle.');
  const parameters = new URLSearchParams(hash.replace(/^#/, ''));
  const rawVersion = parameters.get('v');
  if (!['1', '2', '3', '4'].includes(rawVersion)) throw new Error('This puzzle link uses an unsupported version. Enter the words to make a new puzzle.');
  const version = Number(rawVersion);
  const split = parameters.get('split');
  if ((version === 1 && split !== null && split !== '0') || (version >= 2 && split !== '0' && split !== '1')) {
    throw new Error('This puzzle link has an invalid shared-letter option. Enter the words to make a new puzzle.');
  }
  const first = parameters.get('a');
  const second = parameters.get('b');
  const rawSeed = parameters.get('s');
  if (!validText(first, version) || !validText(second, version) || !/^\d{1,10}$/.test(rawSeed || '')) {
    throw new Error('This puzzle link is incomplete or invalid. Enter the words to make a new puzzle.');
  }
  const seed = Number(rawSeed);
  if (seed > 0xffffffff) throw new Error('This puzzle link has an invalid seed. Enter the words to make a new puzzle.');
  const puzzle = { first, second, seed, version, splitSharedLetters: split === '1' };
  const palette = parameters.get('p');
  const color = parameters.get('c');
  if (palette !== null || color !== null) {
    const appearance = { palette };
    if (color !== null) appearance.color = `#${color}`;
    if (!validAppearance(appearance)) throw new Error('This puzzle link has an invalid color option.');
    puzzle.appearance = appearance;
  }
  return puzzle;
}
