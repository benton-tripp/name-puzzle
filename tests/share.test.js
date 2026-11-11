import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeShare, decodeShare } from '../src/share.js';

test('shared puzzle preserves canonical inputs and unsigned seed', () => {
  for (const seed of [0, 1, 2147483648, 4294967295]) {
    const puzzle = { version: 1, first: 'MAYA', second: 'NOAH', seed };
    assert.deepEqual(decodeShare(encodeShare(puzzle)), { ...puzzle, splitSharedLetters: false });
  }
  assert.equal(encodeShare({version:1,first:'MAYA',second:'NOAH',seed:1}), '#v=1&a=MAYA&b=NOAH&s=1');
});

test('new links preserve both shared-letter option states', () => {
  for (const version of [2, 3]) {
    for (const splitSharedLetters of [false, true]) {
      const puzzle = { version, first: 'LOVE', second: 'HOME', seed: 4294967295, splitSharedLetters };
      assert.deepEqual(decodeShare(encodeShare(puzzle)), puzzle);
      assert.equal(new URLSearchParams(encodeShare(puzzle).slice(1)).get('split'), splitSharedLetters ? '1' : '0');
    }
  }
});

test('a legacy link explicitly clears the shared-letter option', () => {
  assert.equal(decodeShare('#v=1&a=LOVE&b=HOME&s=1').splitSharedLetters, false);
});

test('an empty fragment means no shared puzzle', () => {
  assert.equal(decodeShare(''), null);
  assert.equal(decodeShare('#'), null);
});

test('malformed or unsupported links are rejected', () => {
  for (const hash of ['#v=4&a=MAYA&b=NOAH&s=1', '#v=3&a=MAYA&b=NOAH&s=1', '#v=2&a=MAYA&b=NOAH&s=1', '#v=2&a=MAYA&b=NOAH&s=1&split=true', '#v=1&a=MAYA&b=NOAH&s=1&split=1', '#v=1&a=A&b=NOAH&s=1', '#v=1&a=MAYA&b=NOAH&s=-1', '#v=1&a=MAYA&b=NOAH&s=4294967296', '#v=1&a=MAYA&b=NOAH&s=1.5', '#v=1&a=MAYA&b=NOAH&s=NaN', '#v=1&a=%3Cscript%3E&b=NOAH&s=1', '#v=1&a=MAYA&b=NOAH', '#' + 'a'.repeat(201)]) {
    assert.throws(() => decodeShare(hash));
  }
});

test('invalid puzzle data cannot be encoded', () => {
  for (const patch of [{first:'A'}, {second:'José'}, {seed:-1}, {seed:NaN}, {seed:4294967296}, {version:4}, {splitSharedLetters:true}, {version:2,splitSharedLetters:'true'}]) {
    assert.throws(() => encodeShare({first:'MAYA',second:'NOAH',seed:1,...patch}));
  }
});
