import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { encodeShare, decodeShare } from '../src/share.js';

const appUrl = new URL('../src/app.js', import.meta.url);
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// Execute the actual event wiring. Only rendering, browser services, and worker
// results are substituted; share encoding and decoding use production code.
const appSource = readFileSync(appUrl, 'utf8').replace(/^import .+;\n/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(appUrl.href));

class Element {
  constructor(tag = '') {
    this.listeners = new Map();
    this.attributes = new Map();
    this.value = tag.match(/\bvalue="([^"]*)"/)?.[1] || '';
    this.hidden = /(?:\s|^)hidden(?:\s|>|$)/.test(tag);
    this.dataset = {};
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  async dispatch(type) {
    for (const callback of this.listeners.get(type) || []) await callback({ preventDefault() {} });
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() {}
  select() {}
  scrollIntoView() {}
}

function loadApp(hash = '') {
  const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match => [match[1], new Element(match[0])]));
  const examples = [...html.matchAll(/<button class="example"[^>]+data-first="([^"]+)" data-second="([^"]+)"[^>]*>/g)].map(match => {
    const element = new Element();
    element.dataset = { first: match[1], second: match[2] };
    return element;
  });
  const section = new Element();
  const skip = new Element();
  const workers = [];
  const copied = [];
  const location = new URL(`https://example.test/name-puzzle/${hash}`);
  const window = new Element();
  const crypto = { getRandomValues(array) { array[0] = 42; return array; } };
  let appearance = { palette: 'classic' };
  class Worker {
    constructor() { this.listeners = {}; workers.push(this); }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    postMessage(request) { this.request = structuredClone(request); }
    terminate() { this.terminated = true; }
    complete() {
      const puzzle = { ...this.request, pieces: [{ cells: [[0, 0]] }], targets: { a: { cells: [[0, 0]] } } };
      if (puzzle.version === 1) delete puzzle.splitSharedLetters;
      this.listeners.message({ data: { type: 'complete', puzzle } });
    }
  }
  class PuzzleBoard {
    constructor(container, { onChange }) { this.onChange = onChange; }
    load(puzzle) { this.onChange({ mode: 'view', target: 'a', placed: 0, total: puzzle.pieces.length, selectedId: null, solved: false }); }
  }
  Object.assign(window, { Worker, crypto });
  vm.runInNewContext(appSource, {
    URL, Worker, PuzzleBoard, encodeShare, decodeShare, window, crypto, location,
    document: {
      getElementById: id => elements.get(id) || null,
      querySelector: selector => selector === '.puzzle-section' ? section : selector === '.skip-link' ? skip : null,
      querySelectorAll: selector => selector === '.example' ? examples : [],
    },
    history: { replaceState(_state, _unused, url) { location.href = new URL(url, location.href).href; } },
    navigator: { clipboard: { async writeText(url) { copied.push(url); } } },
    setupAppearance: () => ({ getAppearance: () => appearance, setAppearance: value => { appearance = structuredClone(value); } }),
    performance: { now: () => 100 }, setTimeout: () => 1, setInterval: () => 2,
    clearTimeout() {}, clearInterval() {}, requestAnimationFrame() {},
  }, { filename: appUrl.pathname });
  return { elements, examples, workers, copied, window, location, latest: () => workers.at(-1) };
}

const savedConfigurations = [[1, false], [2, false], [2, true], [3, false], [3, true], [4, false], [4, true]];

test('initial generation, example pairs, and Make puzzle always enable shared-character splitting', async () => {
  const app = loadApp();
  assert.equal(app.elements.has('split-shared-letters'), false);
  assert.deepEqual(app.latest().request, { first: 'LOVE', second: 'HOME', seed: 1, splitSharedLetters: true, version: 4 });
  app.latest().complete();
  assert.equal(app.elements.get('legacy-note').hidden, true);
  await app.examples[0].dispatch('click');
  assert.deepEqual(app.latest().request, { first: 'SUN', second: 'MOON', seed: 1, splitSharedLetters: true, version: 4 });
  app.latest().complete();
  app.elements.get('first-name').value = 'LETTER';
  app.elements.get('second-name').value = 'BETTER';
  await app.elements.get('name-form').dispatch('submit');
  assert.deepEqual(app.latest().request, { first: 'LETTER', second: 'BETTER', seed: 42, splitSharedLetters: true, version: 4 });
});

test('opening and copying every saved version retains its exact generation settings', async () => {
  for (const [version, splitSharedLetters] of savedConfigurations) {
    const saved = { first: 'LOVE', second: 'HOME', seed: 31, version, splitSharedLetters, appearance: { palette: 'ocean' } };
    const app = loadApp(encodeShare(saved));
    const { appearance, ...expectedRequest } = saved;
    assert.deepEqual(app.latest().request, expectedRequest);
    app.latest().complete();
    assert.equal(app.elements.get('legacy-note').hidden, version === 4 && splitSharedLetters);
    assert.deepEqual(decodeShare(app.location.hash), saved, 'automatic URL update retains the saved puzzle');
    await app.elements.get('share').dispatch('click');
    assert.equal(app.copied.length, 1);
    assert.deepEqual(decodeShare(new URL(app.copied[0]).hash), saved, 'Copy link retains the saved puzzle');
  }
});

test('New cut upgrades every saved version and option state while advancing its seed', async () => {
  for (const [version, splitSharedLetters] of savedConfigurations) {
    const saved = { first: 'LOVE', second: 'HOME', seed: 4294967295, version, splitSharedLetters };
    const app = loadApp(encodeShare(saved));
    app.latest().complete();
    await app.elements.get('new-cut').dispatch('click');
    assert.deepEqual(app.latest().request, { first: 'LOVE', second: 'HOME', seed: 0, version: 4, splitSharedLetters: true });
    app.latest().complete();
    assert.equal(app.elements.get('legacy-note').hidden, true);
    const shared = decodeShare(app.location.hash);
    assert.equal(shared.version, 4);
    assert.equal(shared.splitSharedLetters, true);
  }
});

test('hash navigation restores saved rules and Make puzzle then applies the current rules', async () => {
  const app = loadApp();
  app.latest().complete();
  const saved = { first: 'ANNA', second: 'NANA', seed: 7, version: 4, splitSharedLetters: false };
  app.location.hash = encodeShare(saved);
  await app.window.dispatch('hashchange');
  assert.deepEqual(app.latest().request, saved);
  app.latest().complete();
  assert.equal(app.elements.get('legacy-note').hidden, false);
  await app.elements.get('name-form').dispatch('submit');
  assert.deepEqual(app.latest().request, { ...saved, seed: 42, splitSharedLetters: true });
});
