import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  configFromFlags, configFromRecipe, exportSlug, EXPORTER_VERSION, SOURCE_FILES,
  parseCommandLine, validateConfig,
} from '../scripts/lib/export-options.mjs';

const catalogue = JSON.parse(await readFile(new URL('../examples/animations/presets.json', import.meta.url), 'utf8'));
const presets = catalogue.presets;
const fromArgs = args => configFromFlags(parseCommandLine(args), presets);
const base = () => configFromFlags({ preset: 'birthday' }, presets);
const recipe = () => ({ schemaVersion: 1, exporterVersion: EXPORTER_VERSION,
  geometrySha256: 'a'.repeat(64), configuration: base(),
  source: { fileSha256: Object.fromEntries(SOURCE_FILES.map(name => [name, 'a'.repeat(64)])) } });

test('the three requested occasions resolve to complete export configurations', () => {
  assert.equal(catalogue.schemaVersion, 1);
  assert.deepEqual(Object.keys(presets).sort(), ['birthday', 'holidays', 'new-year']);
  const expected = { birthday: ['HAPPY', 'BIRTHDAY'], holidays: ['HAPPY', 'HOLIDAYS'],
    'new-year': ['HAPPY', 'NEW YEAR'] };
  for (const [id, words] of Object.entries(expected)) {
    const config = fromArgs(['--preset', id]);
    assert.deepEqual([config.puzzle.first, config.puzzle.second], words);
    assert.equal(config.puzzle.version, 4);
    assert.equal(config.puzzle.seed, presets[id].seed);
    assert.equal(config.render.theme, id);
    assert.deepEqual(config.output.formats, ['mp4', 'gif']);
  }
});

test('custom text follows the website normalization without losing supported spaces and symbols', () => {
  const config = fromArgs(['--first', '  café   &  tea ', '--second', 'a−b + 12']);
  assert.equal(config.puzzle.first, 'CAFE & TEA');
  assert.equal(config.puzzle.second, 'A-B + 12');
  assert.equal(config.puzzle.version, 4);
  assert.equal(config.puzzle.splitSharedLetters, false);
  assert.throws(() => fromArgs(['--first', "IT'S", '--second', 'GOOD']), /Use letters/);
});

test('Happy Birthday fits across the two arrangements, not as a single thirteen-letter input', () => {
  assert.equal(fromArgs(['--first', 'HAPPY', '--second', 'BIRTHDAY']).puzzle.second, 'BIRTHDAY');
  assert.throws(() => fromArgs(['--first', 'HAPPY BIRTHDAY', '--second', 'TO YOU']), /2 to 12/);
  const spaced = 'A B C D E F G H I J K L';
  assert.equal(fromArgs(['--first', spaced, '--second', 'HELLO']).puzzle.first, spaced);
  assert.throws(() => fromArgs(['--first', `${spaced} M`, '--second', 'HELLO']), /2 to 12/);
});

test('preset overrides create explicit variations while leaving the catalogue intact', () => {
  const original = structuredClone(presets);
  const config = fromArgs(['--preset', 'birthday', '--first', 'BEST', '--second', 'WISHES',
    '--seed', '4294967295', '--theme', 'plain', '--background', '#ABCDEF',
    '--colors', '#112233, #AABBCC', '--format', 'gif']);
  assert.deepEqual(config.puzzle, { version: 4, first: 'BEST', second: 'WISHES',
    seed: 4294967295, splitSharedLetters: false });
  assert.equal(config.render.theme, 'plain');
  assert.equal(config.render.background, '#abcdef');
  assert.deepEqual(config.render.colors, ['#112233', '#aabbcc']);
  assert.deepEqual(config.output.formats, ['gif']);
  assert.deepEqual(presets, original);
});

test('small previews cap default GIF dimensions and frame rate to the source', () => {
  const config = fromArgs(['--preset', 'holidays', '--width', '256', '--height', '384', '--fps', '10']);
  assert.equal(config.output.gifWidth, 256);
  assert.equal(config.output.gifFps, 10);
  assert.throws(() => fromArgs(['--preset', 'holidays', '--width', '256', '--gif-width', '540']), /cannot exceed/);
  assert.throws(() => fromArgs(['--preset', 'holidays', '--fps', '10', '--gif-fps', '15']), /cannot exceed/);
});

test('invalid text, preset names, formats, and themes fail before any export', () => {
  for (const values of [{}, { first: 'HAPPY' }, { second: 'BIRTHDAY' },
    { first: 'A', second: 'YES' }, { first: '&&', second: 'YES' }]) {
    assert.throws(() => configFromFlags(values, presets));
  }
  assert.throws(() => fromArgs(['--preset', 'christmas']), /Unknown preset/);
  assert.throws(() => fromArgs(['--preset', 'birthday', '--format', 'webm']), /format/);
  assert.throws(() => fromArgs(['--preset', 'birthday', '--theme', 'unknown']), /theme/);
  assert.throws(() => parseCommandLine(['--preset', 'birthday', '--unknown']), /Unknown option/);
  assert.throws(() => parseCommandLine(['birthday']), /Unexpected argument/);
});

test('invalid numerical limits and incompatible video dimensions are rejected', () => {
  const invalidFlags = [
    ['--seed', 'NaN'], ['--seed', 'Infinity'], ['--seed', ''], ['--seed', '-1'],
    ['--seed', '1.5'], ['--seed', '4294967296'], ['--width', 'NaN'], ['--width', ''],
    ['--width', '255'], ['--height', '2162'], ['--width', '257'], ['--height', '539'],
    ['--fps', '9'], ['--fps', '61'], ['--fps', '10.5'], ['--hold', '0'],
    ['--hold', 'Infinity'], ['--transition', '-1'], ['--transition', '5.1'],
    ['--gif-width', '127'], ['--gif-fps', '4'],
  ];
  for (const pair of invalidFlags) {
    assert.throws(() => fromArgs(['--preset', 'birthday', ...pair]), undefined, pair.join(' '));
  }
  assert.throws(() => fromArgs(['--preset', 'birthday', '--width', '2160', '--height', '2160',
    '--fps', '60', '--hold', '10', '--transition', '5']), /too large/);
});

test('recipe numerical values cannot silently coerce null, booleans, or non-number containers', () => {
  for (const value of [null, true, false, NaN, Infinity, [], [19], {}, '   ']) {
    const config = base();
    config.puzzle.seed = value;
    assert.throws(() => validateConfig(config), undefined, `seed ${JSON.stringify(value)}`);
  }
});

test('recipe sections must be objects rather than arrays or strings', () => {
  for (const section of ['puzzle', 'render', 'output']) {
    for (const value of [null, [], 'invalid']) {
      const config = base();
      config[section] = value;
      assert.throws(() => validateConfig(config), undefined, `${section}: ${JSON.stringify(value)}`);
    }
  }
});

test('colors are literal hex values and cannot introduce SVG markup or external resources', () => {
  for (const value of ['red', '#abc', '#1234567', 'url(https://example.com/color)', '<style/>', '']) {
    assert.throws(() => fromArgs(['--preset', 'birthday', '--background', value]), /hex color/);
    assert.throws(() => fromArgs(['--preset', 'birthday', '--colors', value]), /hex color/);
  }
  assert.throws(() => fromArgs(['--preset', 'birthday', '--colors', Array(17).fill('#112233').join(',')]), /sixteen/);
  const config = base();
  config.render.colors = [];
  assert.throws(() => validateConfig(config), /sixteen/);
});

test('recipes require supported versions, checksums, and complete valid configuration', () => {
  const saved = recipe();
  const before = structuredClone(saved);
  assert.deepEqual(configFromRecipe(saved), saved.configuration);
  assert.deepEqual(saved, before);
  for (const changed of [{ schemaVersion: 2 }, { exporterVersion: EXPORTER_VERSION + 1 },
    { geometrySha256: '' }, { geometrySha256: 'a'.repeat(63) },
    { geometrySha256: 'z'.repeat(64) }, { configuration: null }]) {
    assert.throws(() => configFromRecipe({ ...saved, ...changed }));
  }
  const old = recipe();
  old.configuration.puzzle.version = 3;
  assert.throws(() => configFromRecipe(old), /version 4/);
  const duplicate = recipe();
  duplicate.configuration.output.formats = ['gif', 'gif'];
  assert.throws(() => configFromRecipe(duplicate), /output formats/);
  const incomplete = recipe();
  delete incomplete.configuration.puzzle.splitSharedLetters;
  assert.throws(() => configFromRecipe(incomplete), /true or false/);
});

test('recipes require the exact source-file manifest and lowercase SHA-256 values', () => {
  const renderer = 'scripts/lib/animation-renderer.mjs';
  assert.ok(SOURCE_FILES.includes(renderer));
  assert.deepEqual(configFromRecipe(recipe()), base());
  const missingSource = recipe();
  delete missingSource.source;
  assert.throws(() => configFromRecipe(missingSource));
  for (const source of [{}, { fileSha256: {} }, { fileSha256: [] },
    { fileSha256: null }, { fileSha256: 'not a manifest' }]) {
    assert.throws(() => configFromRecipe({ ...recipe(), source }));
  }
  const missingRenderer = recipe();
  delete missingRenderer.source.fileSha256[renderer];
  assert.throws(() => configFromRecipe(missingRenderer));
  const extra = recipe();
  extra.source.fileSha256['unexpected.js'] = 'a'.repeat(64);
  assert.throws(() => configFromRecipe(extra));
  for (const hash of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64), null, 19]) {
    const malformed = recipe();
    malformed.source.fileSha256[renderer] = hash;
    assert.throws(() => configFromRecipe(malformed), undefined, `invalid source hash ${JSON.stringify(hash)}`);
  }
});

test('recipe reproduction accepts output locations and executable paths with spaces but rejects design overrides', () => {
  const values = parseCommandLine(['--recipe', '/tmp/My Designs/birthday.recipe.json',
    '--out', '/tmp/My Exports/birthday', '--ffmpeg', 'C:\\Program Files\\FFmpeg\\ffmpeg.exe', '--force']);
  assert.equal(values.recipe, '/tmp/My Designs/birthday.recipe.json');
  assert.equal(values.out, '/tmp/My Exports/birthday');
  assert.equal(values.ffmpeg, 'C:\\Program Files\\FFmpeg\\ffmpeg.exe');
  assert.equal(values.force, true);
  for (const pair of [['--preset', 'birthday'], ['--first', 'HELLO'], ['--seed', '1'],
    ['--theme', 'plain'], ['--width', '540'], ['--format', 'gif'], ['--hold', '1']]) {
    assert.throws(() => parseCommandLine(['--recipe', 'saved.json', ...pair]), /Use --recipe/);
  }
});

test('output names use canonical text without spaces, punctuation, or path separators', () => {
  assert.equal(exportSlug(base()), 'happy-birthday');
  assert.equal(exportSlug(fromArgs(['--preset', 'new-year'])), 'happy-new-year');
  const config = fromArgs(['--first', 'A + B', '--second', 'C & D']);
  const slug = exportSlug(config);
  assert.equal(slug, 'a-b-c-d');
  assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
});
