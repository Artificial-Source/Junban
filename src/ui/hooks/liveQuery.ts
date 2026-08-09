/**
 * Monotonic live-query primitives shared by task and catalog hooks.
 * No external state-management package — plain helpers only.
 */

/** Accept a snapshot only when its revision is not older than the applied head. */
export function nextStateFromRevisionSnapshot<T>(
  currentRevision: number,
  snapshot: { revision: number; value: T },
): { revision: number; value: T } | null {
  if (snapshot.revision < currentRevision) {
    return null;
  }
  return { revision: snapshot.revision, value: snapshot.value };
}

/**
 * Coalesce bursty refresh requests to one in-flight run plus at most one trailing run.
 * Stale-response rejection remains the caller's responsibility via revision checks.
 */
export class RefreshCoalescer {
  private inFlight = false;
  private queued = false;
  private completion: Promise<void> | null = null;

  get isInFlight(): boolean {
    return this.inFlight;
  }

  get isQueued(): boolean {
    return this.queued;
  }

  run(task: () => Promise<void>): Promise<void> {
    if (this.completion) {
      this.queued = true;
      return this.completion;
    }
    this.inFlight = true;
    const completion = (async () => {
      try {
        do {
          this.queued = false;
          await task();
        } while (this.queued);
      } finally {
        this.inFlight = false;
        this.completion = null;
      }
    })();
    this.completion = completion;
    return completion;
  }
}

/** Stable serialization of list query params for dependency keys. */
export function stableQueryKey(params: Record<string, unknown> | undefined): string {
  if (!params) return "";
  const keys = Object.keys(params).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    const value = params[key];
    if (value !== undefined) normalized[key] = value;
  }
  return JSON.stringify(normalized);
}
