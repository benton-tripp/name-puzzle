const NAME_PATTERN = /^[A-Z]{2,10}$/;

export function encodeShare({ first, second, seed, version = 1, splitSharedLetters = false }) {
  if (![1, 2, 3].includes(version) || typeof splitSharedLetters !== 'boolean' || (version === 1 && splitSharedLetters) || !NAME_PATTERN.test(first) || !NAME_PATTERN.test(second) || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('This puzzle cannot be shared. Generate it again.');
  }
  const parameters = new URLSearchParams({ v: String(version), a: first, b: second, s: String(seed) });
  if (version >= 2) parameters.set('split', splitSharedLetters ? '1' : '0');
  return `#${parameters}`;
}

export function decodeShare(hash) {
  if (!hash || hash === '#') return null;
  if (hash.length > 200) throw new Error('This puzzle link is too long. Enter the names to make a new puzzle.');
  const parameters = new URLSearchParams(hash.replace(/^#/, ''));
  const rawVersion = parameters.get('v');
  if (!['1', '2', '3'].includes(rawVersion)) throw new Error('This puzzle link uses an unsupported version. Enter the names to make a new puzzle.');
  const version = Number(rawVersion);
  const split = parameters.get('split');
  if ((version === 1 && split !== null && split !== '0') || (version >= 2 && split !== '0' && split !== '1')) {
    throw new Error('This puzzle link has an invalid shared-letter option. Enter the names to make a new puzzle.');
  }
  const first = parameters.get('a');
  const second = parameters.get('b');
  const rawSeed = parameters.get('s');
  if (!NAME_PATTERN.test(first || '') || !NAME_PATTERN.test(second || '') || !/^\d{1,10}$/.test(rawSeed || '')) {
    throw new Error('This puzzle link is incomplete or invalid. Enter the names to make a new puzzle.');
  }
  const seed = Number(rawSeed);
  if (seed > 0xffffffff) throw new Error('This puzzle link has an invalid seed. Enter the names to make a new puzzle.');
  return { first, second, seed, version, splitSharedLetters: split === '1' };
}
