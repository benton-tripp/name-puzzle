export const MAX_GLYPHS = 12;
export const MAX_TEXT_LENGTH = MAX_GLYPHS * 2 - 1;

const TEXT_PATTERN = /^[A-Z0-9&+\-]+(?: [A-Z0-9&+\-]+)*$/;

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_TEXT';
  return error;
}

export function isCanonicalText(value) {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH || !TEXT_PATTERN.test(value)) return false;
  const count = value.replace(/ /g, '').length;
  return count >= 2 && count <= MAX_GLYPHS && /[A-Z0-9]/.test(value);
}

export function normalizeText(value) {
  if (typeof value !== 'string' || value.length > 200) {
    throw invalid('Enter a word or phrase using 2 to 12 letters, numbers, or symbols.');
  }
  const folds = { Æ: 'AE', æ: 'AE', Œ: 'OE', œ: 'OE', Ø: 'O', ø: 'O', Ł: 'L', ł: 'L', Đ: 'D', đ: 'D', Ð: 'D', ð: 'D', Þ: 'TH', þ: 'TH' };
  const text = value.replace(/[ÆæŒœØøŁłĐđÐðÞþ]/g, character => folds[character])
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/gu, '-')
    .replace(/\s+/gu, ' ').trim().toUpperCase();
  if (/[^A-Z0-9 &+\-]/.test(text)) {
    throw invalid('Use letters A to Z, numbers, spaces, and the symbols - + &.');
  }
  const count = text.replace(/ /g, '').length;
  if (count < 2 || count > MAX_GLYPHS) {
    throw invalid('Use 2 to 12 characters per entry, not counting spaces.');
  }
  if (!/[A-Z0-9]/.test(text)) throw invalid('Include at least one letter or number in each entry.');
  return text;
}
