import { PuzzleBoard } from './board.js';
import { encodeShare, decodeShare } from './share.js';

const get = (id) => document.getElementById(id);
const form = get('name-form');
const firstInput = get('first-name');
const secondInput = get('second-name');
const splitInput = get('split-shared-letters');
const section = document.querySelector('.puzzle-section');
const controlIds = ['show-first', 'show-second', 'rearrange', 'play', 'share', 'new-cut'];
let currentPuzzle = null;
let boardState = { mode: 'view', target: 'a', placed: 0, total: 0, selectedId: null };
let worker = null;
let timeout = null;
let clock = null;
let generation = 0;
let busy = false;

const board = new PuzzleBoard(get('puzzle-board'), { onChange: handleBoardChange });

function handleBoardChange(state) {
  boardState = state;
  if (!currentPuzzle || busy) return;
  const playing = state.mode === 'play';
  const targetName = state.target === 'a' ? currentPuzzle.first : currentPuzzle.second;
  const otherName = state.target === 'a' ? currentPuzzle.second : currentPuzzle.first;
  get('arrangement-label').textContent = playing ? 'Target' : 'Arrangement';
  get('arrangements').setAttribute('aria-label', playing ? 'Choose target name' : 'Show an arrangement');
  get('target-help').hidden = !playing;
  get('show-first').setAttribute('aria-pressed', String(state.target === 'a'));
  get('show-second').setAttribute('aria-pressed', String(state.target === 'b'));
  get('rearrange').textContent = playing ? 'Show solution' : 'Rearrange';
  get('play').hidden = playing;
  get('play').textContent = `Play ${otherName}`;
  get('rotate').hidden = !playing;
  get('hint').hidden = !playing;
  get('reset').hidden = !playing;
  get('play-help').hidden = !playing || state.solved;
  get('rotate').disabled = state.selectedId === null || state.selectedId === undefined || state.solved;
  get('hint').disabled = state.solved;
  if (state.solved) get('board-status').textContent = `${targetName} is complete. All ${state.total} pieces fit.`;
  else if (playing) get('board-status').textContent = `Make ${targetName}. ${state.placed} of ${state.total} pieces placed.`;
  else get('board-status').textContent = `The same ${currentPuzzle.pieces.length} pieces also form ${state.target === 'a' ? currentPuzzle.second : currentPuzzle.first}.`;
}

function setBusy(value) {
  busy = value;
  firstInput.disabled = value;
  secondInput.disabled = value;
  splitInput.disabled = value;
  section.setAttribute('aria-busy', String(value));
  get('generate').disabled = value;
  get('generate').textContent = value ? 'Generating…' : 'Make puzzle';
  get('cancel').hidden = !value;
  for (const id of controlIds) get(id).disabled = value || !currentPuzzle;
  for (const button of document.querySelectorAll('.example')) button.disabled = value;
  for (const id of ['rotate', 'hint', 'reset']) get(id).disabled = value;
  if (!value && currentPuzzle) handleBoardChange(boardState);
}

function clearError() {
  get('form-error').hidden = true;
  get('form-error').textContent = '';
  firstInput.removeAttribute('aria-invalid');
  secondInput.removeAttribute('aria-invalid');
}

function showError(message, invalidInput = false) {
  get('form-error').textContent = message;
  get('form-error').hidden = false;
  if (invalidInput) {
    firstInput.setAttribute('aria-invalid', 'true');
    secondInput.setAttribute('aria-invalid', 'true');
  }
}

function stopWorker() {
  if (worker) worker.terminate();
  worker = null;
  clearTimeout(timeout);
  clearInterval(clock);
  timeout = null;
  clock = null;
  get('generation-clock').textContent = '';
}

function nextSeed() {
  if (window.crypto && crypto.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
  return Date.now() >>> 0;
}

function generate({ first = firstInput.value, second = secondInput.value, seed = nextSeed(), splitSharedLetters = splitInput.checked, version = 2 } = {}) {
  stopWorker();
  const job = ++generation;
  clearError();
  get('share-fallback').hidden = true;
  get('share-status').textContent = '';
  if (!window.Worker) {
    showError('This browser does not support background generation. Open the page in a current browser.');
    section.setAttribute('aria-busy', 'false');
    return;
  }
  setBusy(true);
  get('board-status').textContent = 'Generating pieces…';
  const started = performance.now();
  clock = setInterval(() => {
    get('generation-clock').textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`;
  }, 200);
  try {
    worker = new Worker(new URL('./generator.worker.js', import.meta.url), { type: 'module', name: 'name-puzzle-generator' });
  } catch {
    stopWorker();
    setBusy(false);
    showError('The generator could not start. Reload the page and try again.');
    if (!currentPuzzle) get('board-status').textContent = 'No puzzle generated.';
    return;
  }
  timeout = setTimeout(() => {
    if (job !== generation) return;
    stopWorker();
    setBusy(false);
    showError('Generation took longer than 20 seconds and was stopped. Try a shorter pair of names.');
    if (!currentPuzzle) get('board-status').textContent = 'No puzzle generated.';
  }, 20000);
  worker.addEventListener('message', ({ data }) => {
    if (job !== generation || data.type === 'progress') return;
    const elapsed = performance.now() - started;
    stopWorker();
    if (data.type === 'error') {
      setBusy(false);
      showError(data.message, data.code === 'INVALID_NAME');
      if (!currentPuzzle) get('board-status').textContent = 'Enter a valid pair of names.';
      return;
    }
    try {
      currentPuzzle = data.puzzle;
      firstInput.value = currentPuzzle.first;
      secondInput.value = currentPuzzle.second;
      splitInput.checked = currentPuzzle.splitSharedLetters === true;
      get('legacy-note').hidden = currentPuzzle.version !== 1;
      get('show-first').textContent = currentPuzzle.first;
      get('show-second').textContent = currentPuzzle.second;
      get('piece-count').textContent = `${currentPuzzle.pieces.length} pieces`;
      get('stat-time').textContent = `${(elapsed / 1000).toFixed(2)} s`;
      get('stat-pieces').textContent = String(currentPuzzle.pieces.length);
      get('stat-singletons').textContent = String(currentPuzzle.pieces.filter((piece) => piece.cells.length === 1).length);
      get('stat-cells').textContent = String(currentPuzzle.targets.a.cells.length);
      get('stat-seed').textContent = String(currentPuzzle.seed);
      board.load(currentPuzzle);
      const fragment = encodeShare(currentPuzzle);
      history.replaceState(null, '', `${location.pathname}${location.search}${fragment}`);
      setBusy(false);
    } catch (error) {
      setBusy(false);
      showError(error.message || 'The generated puzzle could not be displayed.');
    }
  });
  worker.addEventListener('error', () => {
    if (job !== generation) return;
    stopWorker();
    setBusy(false);
    showError('The generator could not load. Reload the page and try again.');
    if (!currentPuzzle) get('board-status').textContent = 'No puzzle generated.';
  });
  worker.postMessage({ first, second, seed, splitSharedLetters, version });
}

form.addEventListener('submit', (event) => { event.preventDefault(); generate(); });
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  firstInput.focus();
  form.scrollIntoView({ block: 'center' });
});
firstInput.addEventListener('input', clearError);
secondInput.addEventListener('input', clearError);
get('cancel').addEventListener('click', () => {
  ++generation;
  stopWorker();
  setBusy(false);
  if (!currentPuzzle) get('board-status').textContent = 'Generation canceled.';
});
document.querySelectorAll('.example').forEach((button) => {
  button.addEventListener('click', () => {
    firstInput.value = button.dataset.first;
    secondInput.value = button.dataset.second;
    generate({ seed: 1 });
  });
});
function chooseName(target) {
  if (boardState.mode === 'play') {
    if (target !== boardState.target) board.scatter(target);
  } else board.showArrangement(target);
}
get('show-first').addEventListener('click', () => chooseName('a'));
get('show-second').addEventListener('click', () => chooseName('b'));
get('rearrange').addEventListener('click', () => {
  board.showArrangement(boardState.mode === 'play' ? boardState.target : boardState.target === 'a' ? 'b' : 'a');
});
get('play').addEventListener('click', () => board.scatter(boardState.target === 'a' ? 'b' : 'a'));
get('rotate').addEventListener('click', () => board.rotateSelected(1));
get('hint').addEventListener('click', () => board.hint());
get('reset').addEventListener('click', () => board.reset());
get('new-cut').addEventListener('click', () => {
  if (currentPuzzle) generate({ first: currentPuzzle.first, second: currentPuzzle.second, seed: (currentPuzzle.seed + 1) >>> 0, splitSharedLetters: currentPuzzle.splitSharedLetters === true, version: currentPuzzle.version });
});
get('share').addEventListener('click', async () => {
  if (!currentPuzzle) return;
  const url = new URL(location.href);
  url.search = '';
  url.hash = encodeShare(currentPuzzle).slice(1);
  try {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(url.href);
    get('share-status').textContent = 'Link copied. It includes both names.';
    get('share-fallback').hidden = true;
  } catch {
    get('share-url').value = url.href;
    get('share-fallback').hidden = false;
    get('share-url').focus();
    get('share-url').select();
    get('share-status').textContent = 'Copy the link above. It includes both names.';
  }
});
window.addEventListener('pagehide', () => {
  if (!busy) return;
  ++generation;
  stopWorker();
  setBusy(false);
  if (!currentPuzzle) get('board-status').textContent = 'Generation paused. Choose Make puzzle to try again.';
});
window.addEventListener('hashchange', () => {
  try {
    const shared = decodeShare(location.hash);
    if (shared) generate(shared);
  } catch (error) { showError(error.message); }
});

try {
  const shared = decodeShare(location.hash);
  if (shared) {
    firstInput.value = shared.first;
    secondInput.value = shared.second;
  }
  generate(shared || { seed: 1 });
} catch (error) {
  setBusy(false);
  get('board-status').textContent = 'Enter the names to make a puzzle.';
  showError(error.message);
}
