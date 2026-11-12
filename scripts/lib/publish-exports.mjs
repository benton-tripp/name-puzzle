import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

async function statIfPresent(filename) {
  try { return await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function validateNames(names) {
  if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length
    || names.some(name => typeof name !== 'string' || !name || name === '.' || name === '..'
      || name.includes('\0') || path.posix.basename(name) !== name || path.win32.basename(name) !== name)) {
    throw new TypeError('Export filenames must be unique, nonempty filenames without directory components.');
  }
}

async function inspectDestination(destination, names, force) {
  const directory = await statIfPresent(destination);
  if (!directory) return { exists: false, previous: [] };
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error(`Output destination must be a directory, not a file or symbolic link: ${destination}`);
  }
  if (!force && (await fs.readdir(destination)).length) {
    throw new Error(`Output directory is not empty: ${destination}. Choose a new --out directory or use --force.`);
  }
  const previous = [];
  for (const name of names) {
    const filename = path.join(destination, name);
    const entry = await statIfPresent(filename);
    if (!entry) continue;
    if (!force) {
      throw new Error(`Output directory became nonempty: ${destination}. Existing files were preserved.`);
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Output filename is not a regular file: ${filename}. Existing files were preserved.`);
    }
    previous.push(name);
  }
  return { exists: true, previous };
}

// Stage complete files beside the destination, then keep replaced files until
// every new output has been installed. Named files are restored on failure.
export async function publishExports(sourceDirectory, destination, names, { force = false } = {}) {
  validateNames(names);
  if (typeof force !== 'boolean') throw new TypeError('force must be true or false.');
  sourceDirectory = path.resolve(sourceDirectory);
  destination = path.resolve(destination);
  for (const name of names) {
    const filename = path.join(sourceDirectory, name);
    const entry = await statIfPresent(filename);
    if (!entry || entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Generated export is not a regular file: ${filename}`);
    }
  }
  await inspectDestination(destination, names, force);
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, '.word-shapes-output-'));
  const incoming = path.join(staging, 'incoming');
  const backup = path.join(staging, 'backup');
  const installed = [];
  const backedUp = [];
  let preserveRecovery = false;
  let published = false;
  let failure;
  try {
    await fs.mkdir(incoming);
    await fs.mkdir(backup);
    for (const name of names) {
      await fs.copyFile(path.join(sourceDirectory, name), path.join(incoming, name), constants.COPYFILE_EXCL);
    }
    // Recheck after staging so a new collision cannot cause a partial update.
    const current = await inspectDestination(destination, names, force);
    if (!current.exists) {
      // Renaming a complete directory publishes a new output set in one step.
      // A nonempty directory created by another process is never replaced.
      await fs.rename(incoming, destination);
    } else {
      for (const name of current.previous) {
        await fs.rename(path.join(destination, name), path.join(backup, name));
        backedUp.push(name);
      }
      for (const name of names) {
        const target = path.join(destination, name);
        if (force) await fs.rename(path.join(incoming, name), target);
        else await fs.copyFile(path.join(incoming, name), target, constants.COPYFILE_EXCL);
        installed.push(name);
      }
    }
    published = true;
  } catch (error) {
    failure = error;
    const restorationErrors = [];
    const removalErrors = new Map();
    for (const name of installed.toReversed()) {
      try { await fs.unlink(path.join(destination, name)); }
      catch (restoreError) { if (restoreError.code !== 'ENOENT') removalErrors.set(name, restoreError); }
    }
    for (const name of backedUp.toReversed()) {
      try {
        await fs.rename(path.join(backup, name), path.join(destination, name));
        removalErrors.delete(name);
      }
      catch (restoreError) { restorationErrors.push(restoreError); }
    }
    restorationErrors.push(...removalErrors.values());
    if (restorationErrors.length) {
      preserveRecovery = true;
      failure = new AggregateError([error, ...restorationErrors],
        `Export publication failed and previous files could not all be restored. Recovery files remain at ${staging}. ${error.message}`);
      failure.recoveryDirectory = staging;
    }
  }
  if (!preserveRecovery) {
    try { await fs.rm(staging, { recursive: true, force: true }); }
    catch (error) {
      const cleanupMessage = `${published ? 'Export files were saved, but' : 'Export publication failed and'} temporary files could not be removed: ${staging}`;
      failure = new AggregateError(failure ? [failure, error] : [error], cleanupMessage);
      failure.recoveryDirectory = staging;
    }
  }
  if (failure) throw failure;
}
