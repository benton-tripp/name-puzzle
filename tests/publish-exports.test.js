import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishExports } from '../scripts/lib/publish-exports.mjs';

const names = ['one.mp4', 'two.gif', 'three.recipe.json'];

async function fixture(t, existing = false) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'word-shapes-publish-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'output');
  await fs.mkdir(source);
  for (const name of names) await fs.writeFile(path.join(source, name), `new ${name}`);
  if (existing) await fs.mkdir(destination);
  return { root, source, destination };
}

const read = filename => fs.readFile(filename, 'utf8');
const missing = filename => assert.rejects(fs.lstat(filename), { code: 'ENOENT' });

async function noStaging(root) {
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.word-shapes-output-')), []);
}

test('publishes a complete new directory and preserves source files', async t => {
  const { root, source, destination } = await fixture(t);
  await publishExports(source, destination, names);
  assert.deepEqual((await fs.readdir(destination)).sort(), [...names].sort());
  for (const name of names) {
    assert.equal(await read(path.join(destination, name)), `new ${name}`);
    assert.equal(await read(path.join(source, name)), `new ${name}`);
  }
  await noStaging(root);
});

test('rejects an existing nonempty directory without force and preserves its files', async t => {
  const { root, source, destination } = await fixture(t, true);
  await fs.writeFile(path.join(destination, 'notes.txt'), 'keep notes');
  await fs.writeFile(path.join(destination, names[0]), 'previous video');
  await assert.rejects(publishExports(source, destination, names), /not empty/);
  assert.equal(await read(path.join(destination, 'notes.txt')), 'keep notes');
  assert.equal(await read(path.join(destination, names[0])), 'previous video');
  await missing(path.join(destination, names[1]));
  await noStaging(root);
});

test('force replaces named files while preserving unrelated files', async t => {
  const { root, source, destination } = await fixture(t, true);
  await fs.writeFile(path.join(destination, names[0]), 'previous video');
  await fs.writeFile(path.join(destination, names[2]), 'previous recipe');
  await fs.writeFile(path.join(destination, 'notes.txt'), 'keep notes');
  await publishExports(source, destination, names, { force: true });
  for (const name of names) assert.equal(await read(path.join(destination, name)), `new ${name}`);
  assert.equal(await read(path.join(destination, 'notes.txt')), 'keep notes');
  await noStaging(root);
});

test('a directory collision is rejected before any previous output is replaced', async t => {
  const { root, source, destination } = await fixture(t, true);
  await fs.writeFile(path.join(destination, names[0]), 'previous video');
  await fs.mkdir(path.join(destination, names[1]));
  await fs.writeFile(path.join(destination, names[1], 'notes.txt'), 'keep directory contents');
  await assert.rejects(publishExports(source, destination, names, { force: true }), /not a regular file/);
  assert.equal(await read(path.join(destination, names[0])), 'previous video');
  assert.equal(await read(path.join(destination, names[1], 'notes.txt')), 'keep directory contents');
  await missing(path.join(destination, names[2]));
  await noStaging(root);
});

test('rejects symbolic-link output entries without changing their targets', async t => {
  const { root, source, destination } = await fixture(t, true);
  const unrelated = path.join(root, 'unrelated.txt');
  await fs.writeFile(unrelated, 'keep target');
  await fs.writeFile(path.join(destination, names[0]), 'previous video');
  try { await fs.symlink(unrelated, path.join(destination, names[1])); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Creating symbolic links requires additional privileges on this platform.'); return; } throw error; }
  await assert.rejects(publishExports(source, destination, names, { force: true }), /not a regular file/);
  assert.equal(await read(path.join(destination, names[0])), 'previous video');
  assert.equal(await read(unrelated), 'keep target');
  assert.equal((await fs.lstat(path.join(destination, names[1]))).isSymbolicLink(), true);
  await noStaging(root);
});

test('restores all previous named outputs after an installation failure', async t => {
  const { root, source, destination } = await fixture(t, true);
  for (const name of names) await fs.writeFile(path.join(destination, name), `old ${name}`);
  await fs.writeFile(path.join(destination, 'notes.txt'), 'keep notes');
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (path.basename(path.dirname(from)) === 'incoming' && path.basename(from) === names[1]) {
      throw Object.assign(new Error('Injected installation failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await assert.rejects(publishExports(source, destination, names, { force: true }), /Injected installation failure/);
  for (const name of names) assert.equal(await read(path.join(destination, name)), `old ${name}`);
  assert.equal(await read(path.join(destination, 'notes.txt')), 'keep notes');
  await noStaging(root);
});

test('retains recoverable backups and reports their location if restoration fails', async t => {
  const { root, source, destination } = await fixture(t, true);
  for (const name of names) await fs.writeFile(path.join(destination, name), `old ${name}`);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    const folder = path.basename(path.dirname(from));
    if ((folder === 'incoming' && path.basename(from) === names[1])
      || (folder === 'backup' && path.basename(from) === names[0])) {
      throw Object.assign(new Error('Injected filesystem failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  let error;
  try { await publishExports(source, destination, names, { force: true }); }
  catch (caught) { error = caught; }
  assert.ok(error instanceof AggregateError);
  assert.match(error.message, /Recovery files remain at/);
  assert.equal(path.dirname(error.recoveryDirectory), root);
  assert.equal(await read(path.join(error.recoveryDirectory, 'backup', names[0])), `old ${names[0]}`);
  assert.equal(await read(path.join(destination, names[1])), `old ${names[1]}`);
  assert.equal(await read(path.join(destination, names[2])), `old ${names[2]}`);
});

test('an exclusive no-force copy preserves a filename created during publication', async t => {
  const { root, source, destination } = await fixture(t, true);
  const copyFile = fs.copyFile;
  let inserted = false;
  t.mock.method(fs, 'copyFile', async (from, to, mode) => {
    if (to === path.join(destination, names[1]) && !inserted) {
      inserted = true;
      assert.equal(mode, constants.COPYFILE_EXCL);
      await fs.writeFile(to, 'created by another process');
    }
    return copyFile(from, to, mode);
  });
  await assert.rejects(publishExports(source, destination, names), { code: 'EEXIST' });
  assert.equal(await read(path.join(destination, names[1])), 'created by another process');
  await missing(path.join(destination, names[0]));
  await missing(path.join(destination, names[2]));
  await noStaging(root);
});

test('rejects invalid filenames and missing generated files before publishing', async t => {
  const { root, source, destination } = await fixture(t);
  for (const invalid of [[], ['../escape'], ['a\\escape'], ['one', 'one'], ['.'], ['a\0b']]) {
    await assert.rejects(publishExports(source, destination, invalid), /filenames/);
  }
  await assert.rejects(publishExports(source, destination, ['missing.mp4']), /not a regular file/);
  await missing(destination);
  await noStaging(root);
});
