let engineReady;

self.addEventListener('message', async ({ data }) => {
  try {
    engineReady ??= import('./engine.js');
    const { generatePuzzle } = await engineReady;
    const started = performance.now();
    const puzzle = generatePuzzle(data, {
      onProgress: (progress) => self.postMessage({ type: 'progress', progress }),
    });
    self.postMessage({ type: 'complete', puzzle, computeMs: performance.now() - started });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || 'The puzzle could not be generated.', code: error.code || 'GENERATION_ERROR' });
  }
});
