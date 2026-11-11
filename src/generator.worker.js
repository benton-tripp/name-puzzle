import { generatePuzzle } from './engine.js';

self.addEventListener('message', ({ data }) => {
  const started = performance.now();
  try {
    const puzzle = generatePuzzle(data, {
      onProgress: (progress) => self.postMessage({ type: 'progress', progress }),
    });
    self.postMessage({ type: 'complete', puzzle, computeMs: performance.now() - started });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || 'The puzzle could not be generated.', code: error.code || 'GENERATION_ERROR' });
  }
});
