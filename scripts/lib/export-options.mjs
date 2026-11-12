import { parseArgs } from 'node:util';
import { normalizeText } from '../../src/text.js';

export const EXPORTER_VERSION = 1;
export const SOURCE_FILES = Object.freeze([
  'scripts/lib/animation-renderer.mjs', 'scripts/lib/export-options.mjs',
  'scripts/lib/publish-exports.mjs', 'scripts/export-animation.mjs',
  'src/engine.js', 'src/text.js', 'src/lettering.js', 'src/lettering-v4.js',
  'src/glyphs.js', 'src/glyphs-v2.js', 'src/glyphs-v3.js', 'src/glyphs-v4-extra.js',
]);
export const DEFAULT_RENDER = Object.freeze({
  theme: 'plain', width: 1080, height: 1080, fps: 30,
  holdSeconds: 1.6, transitionSeconds: 1.2,
});
const THEMES = new Set(['plain', 'birthday', 'holidays', 'new-year']);
const CONFIG_FLAGS = ['preset', 'first', 'second', 'seed', 'theme', 'width', 'height', 'fps',
  'hold', 'transition', 'background', 'colors', 'gif-width', 'gif-fps', 'format'];
const FLAGS = Object.fromEntries([
  ...CONFIG_FLAGS, 'out', 'recipe', 'ffmpeg',
].map(name => [name, { type: 'string' }]));
Object.assign(FLAGS, { help: { type: 'boolean', short: 'h' },
  'list-presets': { type: 'boolean' }, force: { type: 'boolean' } });

export function parseCommandLine(args) {
  const { values } = parseArgs({ args, options: FLAGS, strict: true, allowPositionals: false });
  if (values.recipe && CONFIG_FLAGS.some(name => values[name] !== undefined)) {
    throw new Error('Use --recipe with only --out, --ffmpeg, or --force. Use preset or custom flags without --recipe to make a variation.');
  }
  return values;
}

function number(value, name, min, max, integer = false) {
  if (!(typeof value === 'number' || (typeof value === 'string' && value.trim().length))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
  }
  const result = typeof value === 'number' ? value : Number(value);
  if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(result)
    || result < min || result > max || (integer && !Number.isInteger(result))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
  }
  return result;
}

function color(value, name) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${name} must be a six-digit hex color, such as #163e38.`);
  }
  return value.toLowerCase();
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('An export configuration is required.');
  const { puzzle: source, render: requested, output: target } = input;
  if ([source, requested, target].some(value => !value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('The configuration needs puzzle, render, and output objects.');
  }
  if (source.version !== 4) throw new Error('This exporter uses generator version 4. Existing website links are unaffected.');
  if (typeof source.splitSharedLetters !== 'boolean') throw new Error('splitSharedLetters must be true or false.');
  const puzzle = {
    version: 4, first: normalizeText(source.first), second: normalizeText(source.second),
    seed: number(source.seed, 'Seed', 0, 0xffffffff, true), splitSharedLetters: source.splitSharedLetters,
  };
  const render = { ...DEFAULT_RENDER, ...requested };
  if (!THEMES.has(render.theme)) throw new Error('Choose the plain, birthday, holidays, or new-year theme.');
  render.width = number(render.width, 'Width', 256, 2160, true);
  render.height = number(render.height, 'Height', 256, 2160, true);
  if (render.width % 2 || render.height % 2) throw new Error('Width and height must be even numbers for MP4 compatibility.');
  render.fps = number(render.fps, 'Frame rate', 10, 60, true);
  render.holdSeconds = number(render.holdSeconds, 'Hold duration', 0.2, 10);
  render.transitionSeconds = number(render.transitionSeconds, 'Transition duration', 0.2, 5);
  if (render.background !== undefined) render.background = color(render.background, 'Background');
  if (render.colors !== undefined) {
    if (!Array.isArray(render.colors) || render.colors.length < 1 || render.colors.length > 16) {
      throw new Error('Use between one and sixteen piece colors.');
    }
    render.colors = render.colors.map(value => color(value, 'Piece color'));
  }
  const formats = target.formats;
  if (!Array.isArray(formats) || formats.length === 0 || formats.length > 2
    || new Set(formats).size !== formats.length || formats.some(value => !['mp4', 'gif'].includes(value))) {
    throw new Error('Choose mp4, gif, or both output formats.');
  }
  const output = {
    formats: [...formats], gifWidth: number(target.gifWidth, 'GIF width', 128, 1080, true),
    gifFps: number(target.gifFps, 'GIF frame rate', 5, 30, true),
  };
  if (output.gifWidth > render.width) throw new Error('GIF width cannot exceed the main frame width.');
  if (output.gifFps > render.fps) throw new Error('GIF frame rate cannot exceed the main frame rate.');
  const frameCount = 2 * (Math.round(render.holdSeconds * render.fps)
    + Math.round(render.transitionSeconds * render.fps));
  if (frameCount * render.width * render.height > 1_200_000_000) {
    throw new Error('This export is too large. Reduce dimensions, durations, or frame rate.');
  }
  return { puzzle, render, output };
}

export function configFromFlags(values, presets) {
  let selected;
  if (values.preset) {
    selected = presets[values.preset];
    if (!selected) throw new Error(`Unknown preset: ${values.preset}. Use --list-presets.`);
  }
  const width = values.width ?? DEFAULT_RENDER.width;
  const fps = values.fps ?? DEFAULT_RENDER.fps;
  const format = values.format ?? 'both';
  if (!['both', 'mp4', 'gif'].includes(format)) throw new Error('--format must be both, mp4, or gif.');
  return validateConfig({
    puzzle: { version: 4, first: values.first ?? selected?.first,
      second: values.second ?? selected?.second, seed: values.seed ?? selected?.seed ?? 1,
      splitSharedLetters: false },
    render: { ...DEFAULT_RENDER, theme: values.theme ?? selected?.theme ?? 'plain',
      width, height: values.height ?? DEFAULT_RENDER.height, fps,
      holdSeconds: values.hold ?? DEFAULT_RENDER.holdSeconds,
      transitionSeconds: values.transition ?? DEFAULT_RENDER.transitionSeconds,
      ...(values.background !== undefined ? { background: values.background } : {}),
      ...(values.colors !== undefined ? { colors: values.colors.split(',').map(value => value.trim()) } : {}),
    },
    output: { formats: format === 'both' ? ['mp4', 'gif'] : [format],
      gifWidth: values['gif-width'] ?? Math.min(540, Number(width)),
      gifFps: values['gif-fps'] ?? Math.min(15, Number(fps)) },
  });
}

export function configFromRecipe(recipe) {
  if (!recipe || recipe.schemaVersion !== 1 || recipe.exporterVersion !== EXPORTER_VERSION) {
    throw new Error('This recipe uses an unsupported schema or exporter version.');
  }
  if (typeof recipe.geometrySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(recipe.geometrySha256)) {
    throw new Error('The recipe is missing its geometry checksum.');
  }
  const hashes = recipe.source?.fileSha256;
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)
    || Object.keys(hashes).length !== SOURCE_FILES.length
    || SOURCE_FILES.some(name => !Object.hasOwn(hashes, name) || typeof hashes[name] !== 'string' || !/^[0-9a-f]{64}$/.test(hashes[name]))) {
    throw new Error('The recipe needs the complete source-file checksum manifest.');
  }
  return validateConfig(recipe.configuration);
}

export function exportSlug(config) {
  return `${config.puzzle.first}-${config.puzzle.second}`.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
