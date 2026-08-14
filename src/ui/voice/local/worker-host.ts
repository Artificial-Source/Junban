/**
 * Same-origin worker factories for local voice engines.
 * Workers are constructed only when called; module evaluation creates none.
 */

export function createWhisperWorker(): Worker {
  return new Worker(new URL("./workers/whisper.worker.ts", import.meta.url), {
    type: "module",
    name: "junban-whisper",
  });
}

export function createKokoroWorker(): Worker {
  return new Worker(new URL("./workers/kokoro.worker.ts", import.meta.url), {
    type: "module",
    name: "junban-kokoro",
  });
}

export function createPiperWorker(): Worker {
  return new Worker(new URL("./workers/piper.worker.ts", import.meta.url), {
    type: "module",
    name: "junban-piper",
  });
}
