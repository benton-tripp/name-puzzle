import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePuzzle } from '../src/engine.js';
import { createAnimation } from './lib/animation-renderer.mjs';
import { configFromFlags, configFromRecipe, exportSlug, EXPORTER_VERSION, SOURCE_FILES, parseCommandLine } from './lib/export-options.mjs';
import { publishExports } from './lib/publish-exports.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const abort = new AbortController();
const sha256 = data => createHash('sha256').update(data).digest('hex');
const log = message => process.stdout.write(`${message}\n`);

function run(executable, args, { timeout = 300_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], signal: abort.signal });
    let output = '';
    const capture = data => { output = (output + data.toString()).slice(-80_000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Cannot run ${executable}: ${error.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(executable)} ${signal ? `stopped (${signal})` : `failed (${code})`}:\n${output.trim()}`));
    });
  });
}

async function preflight(ffmpeg, formats) {
  const version = await run(ffmpeg, ['-version'], { timeout: 10_000 });
  const decoders = await run(ffmpeg, ['-hide_banner', '-decoders'], { timeout: 10_000 });
  const encoders = await run(ffmpeg, ['-hide_banner', '-encoders'], { timeout: 10_000 });
  if (!/\blibrsvg\b/.test(decoders)) throw new Error('FFmpeg needs its librsvg SVG decoder. See docs/animation-exports.md.');
  for (const encoder of ['png', ...(formats.includes('mp4') ? ['libx264'] : []), ...(formats.includes('gif') ? ['gif'] : [])]) {
    if (!new RegExp(`\\b${encoder}\\b`).test(encoders)) throw new Error(`FFmpeg is missing the ${encoder} encoder.`);
  }
  return version.split(/\r?\n/)[0];
}

function geometryChecksum(puzzle) {
  return sha256(JSON.stringify({ version: puzzle.version, first: puzzle.first, second: puzzle.second,
    seed: puzzle.seed, targets: { a: puzzle.targets.a.cells, b: puzzle.targets.b.cells }, pieces: puzzle.pieces }));
}

async function sourceInfo() {
  const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const hashes = {};
  for (const file of SOURCE_FILES) {
    hashes[file] = sha256(await readFile(path.join(root, file)));
  }
  let commit = null, workingTreeChanged = null;
  try {
    commit = (await run('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 10_000 })).trim();
    workingTreeChanged = Boolean((await run('git', ['-C', root, 'status', '--porcelain'], { timeout: 10_000 })).trim());
  } catch { /* Source archives can be exported without a Git installation. */ }
  return { packageVersion: packageInfo.version, commit, workingTreeChanged, fileSha256: hashes };
}

const HELP = `Word Shapes Animation Exporter

Usage:
  npm run export:animation -- --preset birthday
  npm run export:animation -- --preset holidays --out exports/holidays
  npm run export:animation -- --first HAPPY --second "NEW YEAR" --theme new-year
  npm run export:animation -- --recipe exports/happy-birthday/happy-birthday.recipe.json --out exports/replay

Options:
  --list-presets           List the included designs without exporting
  --preset NAME           birthday, holidays, or new-year
  --first TEXT            First word or phrase (2 to 12 non-space characters)
  --second TEXT           Second word or phrase (2 to 12 non-space characters)
  --seed INTEGER          Reproducible puzzle cut; presets contain selected seeds
  --theme NAME            plain, birthday, holidays, or new-year
  --width N --height N    Even frame dimensions from 256 to 2160 (default 1080)
  --fps N                 Main frame rate from 10 to 60 (default 30)
  --hold SECONDS          Pause at each arrangement (default 1.6)
  --transition SECONDS    Duration of each rearrangement (default 1.2)
  --background "#RRGGBB"  Opaque background color
  --colors "#HEX,#HEX"    One to sixteen six-digit piece colors
  --format FORMAT         both, mp4, or gif (default both)
  --gif-width N           GIF width (default 540, capped to main width)
  --gif-fps N             GIF frame rate (default 15, capped to main rate)
  --out DIRECTORY        New output directory (default exports/<first>-<second>)
  --recipe FILE           Reproduce an existing saved configuration
  --ffmpeg PATH           FFmpeg executable; also accepts FFMPEG_PATH
  --force                 Replace only this design's named output files
  --help                  Show this help

Requires Node.js 22+ and FFmpeg with librsvg, PNG, GIF, and libx264 support.
The website, tests, and ordinary build do not require FFmpeg.
`;

async function main() {
  const values = parseCommandLine(process.argv.slice(2));
  if (values.help) { log(HELP); return; }
  const catalogue = JSON.parse(await readFile(path.join(root, 'examples/animations/presets.json'), 'utf8'));
  if (catalogue.schemaVersion !== 1) throw new Error('Unsupported preset catalogue version.');
  if (values['list-presets']) {
    for (const [id, preset] of Object.entries(catalogue.presets)) log(`${id.padEnd(12)} ${preset.label}: ${preset.first} / ${preset.second} (seed ${preset.seed})`);
    return;
  }
  const recipe = values.recipe ? JSON.parse(await readFile(path.resolve(values.recipe), 'utf8')) : null;
  const configuration = recipe ? configFromRecipe(recipe) : configFromFlags(values, catalogue.presets);
  const slug = exportSlug(configuration);
  const destination = path.resolve(values.out || path.join('exports', slug));
  const names = [...configuration.output.formats.map(ext => `${slug}.${ext}`), `${slug}.png`, `${slug}.svg`, `${slug}.recipe.json`];
  const existing = await readdir(destination).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  if (!values.force && existing.length) throw new Error(`Output directory is not empty: ${destination}. Choose a new --out directory or use --force.`);
  const ffmpeg = values.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg';
  const ffmpegVersion = await preflight(ffmpeg, configuration.output.formats);
  const source = await sourceInfo();
  if (recipe) {
    const changed = SOURCE_FILES.filter(name => source.fileSha256[name] !== recipe.source.fileSha256[name]);
    if (changed.length) throw new Error(`Recipe source files differ: ${changed.join(', ')}. Use the original exporter revision to reproduce this file.`);
  }
  log(`Generating ${configuration.puzzle.first} / ${configuration.puzzle.second} (v4, seed ${configuration.puzzle.seed})…`);
  const puzzle = generatePuzzle(configuration.puzzle);
  const geometrySha256 = geometryChecksum(puzzle);
  if (recipe && recipe.geometrySha256 !== geometrySha256) throw new Error('The regenerated geometry does not match the recipe checksum. No files were exported.');
  const animation = createAnimation(puzzle, configuration.render);
  log(`${puzzle.pieces.length} pieces; ${animation.frameCount} frames at ${animation.fps} fps; ${animation.duration.toFixed(2)} seconds.`);
  const temporary = await mkdtemp(path.join(tmpdir(), 'word-shapes-export-'));
  try {
    for (let index = 0; index < animation.frameCount; index += 1) {
      await writeFile(path.join(temporary, `frame-${String(index).padStart(5, '0')}.svg`), animation.renderFrame(index));
    }
    const input = path.join(temporary, 'frame-%05d.svg');
    const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
    if (configuration.output.formats.includes('mp4')) {
      log('Encoding MP4…');
      await run(ffmpeg, [...common, '-framerate', String(animation.fps), '-i', input,
        '-frames:v', String(animation.frameCount), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-pix_fmt', 'yuv420p', '-threads', '2', '-movflags', '+faststart', path.join(temporary, `${slug}.mp4`)]);
    }
    if (configuration.output.formats.includes('gif')) {
      log('Encoding looping GIF…');
      const { gifWidth, gifFps } = configuration.output;
      const filter = `fps=${gifFps},scale=${gifWidth}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`;
      await run(ffmpeg, [...common, '-framerate', String(animation.fps), '-i', input,
        '-filter_complex_threads', '1', '-filter_complex', filter, '-loop', '0', path.join(temporary, `${slug}.gif`)]);
    }
    // Use the second arrangement as the poster so the occasion is visible.
    const posterIndex = animation.settings.holdFrames + animation.settings.transitionFrames;
    const poster = path.join(temporary, `frame-${String(posterIndex).padStart(5, '0')}.svg`);
    await cp(poster, path.join(temporary, `${slug}.svg`));
    await run(ffmpeg, [...common, '-i', poster, '-frames:v', '1', '-threads', '1', path.join(temporary, `${slug}.png`)]);
    const result = {
      schemaVersion: 1, exporterVersion: EXPORTER_VERSION, configuration,
      geometrySha256, source, tools: { node: process.version, ffmpeg: ffmpegVersion },
      actual: { width: animation.width, height: animation.height, fps: animation.fps,
        frameCount: animation.frameCount, durationSeconds: animation.duration,
        holdFrames: animation.settings.holdFrames, transitionFrames: animation.settings.transitionFrames },
      puzzleMetrics: puzzle.metrics, files: names,
    };
    await writeFile(path.join(temporary, `${slug}.recipe.json`), `${JSON.stringify(result, null, 2)}\n`);
    await publishExports(temporary, destination, names, { force: values.force });
    log(`Saved ${names.length} files to ${destination}`);
    for (const name of names) log(`  ${name}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
main().catch(error => { process.stderr.write(`Export failed: ${error.message}\n`); process.exitCode = abort.signal.aborted ? 130 : 1; });
