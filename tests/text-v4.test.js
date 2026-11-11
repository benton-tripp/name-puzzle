import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, isCanonicalText, MAX_GLYPHS } from '../src/text.js';

test('text normalization preserves supported phrase content and collapses spacing', () => {
  const examples = new Map([
    ['  ice   cream  ', 'ICE CREAM'],
    ['YOU\t+\nME', 'YOU + ME'],
    ['Søren & Zoë', 'SOREN & ZOE'],
    ['straße 26', 'STRASSE 26'],
    ['Ægir + Þora', 'AEGIR + THORA'],
    ['BENTON TRIPP', 'BENTON TRIPP'],
    ['A-1 B+2', 'A-1 B+2'],
  ]);
  for (const [value, expected] of examples) {
    assert.equal(normalizeText(value), expected);
    assert.equal(isCanonicalText(expected), true);
  }
});

test('the limit counts ink-bearing characters rather than spaces', () => {
  assert.equal(MAX_GLYPHS, 12);
  assert.equal(normalizeText('A B C D E F G H I J K L'), 'A B C D E F G H I J K L');
  assert.equal(normalizeText('0123456789+-'), '0123456789+-');
  for (const value of ['ABCDEFGHIJKLM', 'A B C D E F G H I J K L M', 'ABCDEFGHIJKL&', 'ÞÞÞÞÞÞA']) {
    assert.throws(() => normalizeText(value), { code: 'INVALID_TEXT' });
  }
});

test('unsupported punctuation, isolated symbols, and invalid values fail explicitly', () => {
  const inputs = ['', ' ', 'A', '+ - &', 'HELLO!', 'WHY?', 'A:B', "O'NEIL", 'HI.', 'A_B', 'A/B', 'HI🙂', 'АB', null, 12, {}, []];
  for (const value of inputs) {
    assert.throws(() => normalizeText(value), { code: 'INVALID_TEXT' }, String(value));
    assert.equal(isCanonicalText(value), false, String(value));
  }
});

test('shared text must already be canonical', () => {
  for (const value of ['Hello', ' HELLO', 'HELLO ', 'HI  THERE', 'SØREN', 'AEGIR\nTHORA']) {
    assert.equal(isCanonicalText(value), false, value);
  }
});
