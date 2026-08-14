/**
 * Operation identity helpers for AI mutations.
 *
 * One UUID is generated per logical mutation and retained across same-action
 * retries. Streaming POSTs never auto-replay; callers pass the retained id.
 */

import { generateOperationId } from "../api/client";

/** Generate one fresh operation UUID (Idempotency-Key). */
export function createAiOperationId(): string {
  return generateOperationId();
}

/**
 * Holds one operation UUID for a single logical action.
 * Reuse `id` on same-action retries; call `reset()` when the logical action changes.
 */
export class RetainedOperationId {
  #id: string | null;

  constructor(existing?: string) {
    this.#id = existing ?? null;
  }

  /** Current id, generating once on first access. */
  get id(): string {
    if (this.#id === null) {
      this.#id = createAiOperationId();
    }
    return this.#id;
  }

  /** Whether an id has already been minted. */
  get assigned(): boolean {
    return this.#id !== null;
  }

  /** Drop the retained id so the next access mints a new logical mutation. */
  reset(): void {
    this.#id = null;
  }
}

/**
 * Resolve an operation id for a mutation call.
 * When `existing` is provided it is retained as-is (retry path).
 */
export function resolveOperationId(existing?: string): string {
  return existing ?? createAiOperationId();
}
