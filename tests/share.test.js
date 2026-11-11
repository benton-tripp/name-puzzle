import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeShare, decodeShare } from '../src/share.js';

test('shared puzzle preserves canonical inputs and unsigned seed', () => {
  for (const seed of [0, 1, 2147483648, 4294967295]) {
    const puzzle = { version: 1, first: 'MAYA', second: 'NOAH', seed };
    assert.deepEqual(decodeShare(encodeShare(puzzle)), puzzle);
  }
});

test('an empty fragment means no shared puzzle', () => {
  assert.equal(decodeShare(''), null);
  assert.equal(decodeShare('#'), null);
});

test('malformed or unsupported links are rejected', () => {
  for (const hash of ['#v=2&a=MAYA&b=NOAH&s=1', '#v=1&a=A&b=NOAH&s=1', '#v=1&a=MAYA&b=NOAH&s=-1', '#v=1&a=MAYA&b=NOAH&s=4294967296', '#v=1&a=MAYA&b=NOAH&s=1.5', '#v=1&a=MAYA&b=NOAH&s=NaN', '#v=1&a=%3Cscript%3E&b=NOAH&s=1', '#v=1&a=MAYA&b=NOAH', '#' + 'a'.repeat(201)]) {
    assert.throws(() => decodeShare(hash));
  }
});

test('invalid puzzle data cannot be encoded', () => {
  for (const patch of [{first:'A'}, {second:'José'}, {seed:-1}, {seed:NaN}, {seed:4294967296}, {version:2}]) {
    assert.throws(() => encodeShare({first:'MAYA',second:'NOAH',seed:1,...patch}));
  }
});
