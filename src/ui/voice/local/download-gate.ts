/**
 * Global single-flight gate for local voice model downloads.
 * Only one verified model download may run at a time across the page.
 */

let tail: Promise<unknown> = Promise.resolve();

/**
 * Run `task` after any prior download tasks settle. Failures do not block the queue.
 */
export function withModelDownloadLock<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task);
  // Keep the chain alive regardless of task success/failure.
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test-only: reset the gate between cases. */
export function resetModelDownloadLockForTests(): void {
  tail = Promise.resolve();
}
