const NAME_PATTERN = /^[A-Z]{2,10}$/;

export function encodeShare({ first, second, seed, version = 1 }) {
  if (version !== 1 || !NAME_PATTERN.test(first) || !NAME_PATTERN.test(second) || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error('This puzzle cannot be shared. Generate it again.');
  }
  const parameters = new URLSearchParams({ v: String(version), a: first, b: second, s: String(seed) });
  return `#${parameters}`;
}

export function decodeShare(hash) {
  if (!hash || hash === '#') return null;
  if (hash.length > 200) throw new Error('This puzzle link is too long. Enter the names to make a new puzzle.');
  const parameters = new URLSearchParams(hash.replace(/^#/, ''));
  if (parameters.get('v') !== '1') throw new Error('This puzzle link uses an unsupported version. Enter the names to make a new puzzle.');
  const first = parameters.get('a');
  const second = parameters.get('b');
  const rawSeed = parameters.get('s');
  if (!NAME_PATTERN.test(first || '') || !NAME_PATTERN.test(second || '') || !/^\d{1,10}$/.test(rawSeed || '')) {
    throw new Error('This puzzle link is incomplete or invalid. Enter the names to make a new puzzle.');
  }
  const seed = Number(rawSeed);
  if (seed > 0xffffffff) throw new Error('This puzzle link has an invalid seed. Enter the names to make a new puzzle.');
  return { first, second, seed, version: 1 };
}
