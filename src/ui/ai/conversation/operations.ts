/**
 * Explicit operation-retention authority for conversation mutations.
 *
 * One UUID is retained per canonical logical action identity. Same-action
 * retries after ambiguous network/protocol failure reuse the exact id.
 * Definitive local v1 terminals (completed/cancelled/failed) release it.
 * Changed request bytes mint a new identity and cannot inherit an old receipt.
 *
 * Keys use a deterministic local digest of variable text so retention does not
 * keep unbounded duplicate chat bodies (text already lives in UI state).
 */

import { RetainedOperationId } from "../operation-id";
import type { AiRunTerminalView, AiRunStreamState, AiStreamResultLike } from "./operations-types";

export type { AiRunTerminalView };

/** FNV-1a 32-bit over UTF-8 — local identity only, not a security hash. */
export function digestUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function focusPart(focusedTaskId: string | null | undefined): string {
  return focusedTaskId ?? "";
}

function textPart(text: string): string {
  return `${new TextEncoder().encode(text).byteLength}:${digestUtf8(text)}`;
}

/** Canonical identity builders — stable across retries of the same logical action. */
export const ActionKeys = {
  createSession(title: string): string {
    return `createSession:${textPart(title)}`;
  },
  send(sessionId: string, text: string, focusedTaskId: string | null | undefined): string {
    return `send:${sessionId}:${focusPart(focusedTaskId)}:${textPart(text)}`;
  },
  briefing(sessionId: string): string {
    return `briefing:${sessionId}`;
  },
  edit(
    sessionId: string,
    messageId: string,
    text: string,
    focusedTaskId: string | null | undefined,
  ): string {
    return `edit:${sessionId}:${messageId}:${focusPart(focusedTaskId)}:${textPart(text)}`;
  },
  retry(sessionId: string, messageId: string): string {
    return `retry:${sessionId}:${messageId}`;
  },
  regenerate(sessionId: string, messageId: string): string {
    return `regenerate:${sessionId}:${messageId}`;
  },
  rename(sessionId: string, title: string): string {
    return `rename:${sessionId}:${textPart(title)}`;
  },
  delete(sessionId: string): string {
    return `delete:${sessionId}`;
  },
  clear(sessionId: string): string {
    return `clear:${sessionId}`;
  },
  approve(approvalId: string, actionHash: string): string {
    return `approve:${approvalId}:${actionHash}:approve`;
  },
  reject(approvalId: string, actionHash: string): string {
    return `reject:${approvalId}:${actionHash}:reject`;
  },
} as const;

/** True when the local v1 terminal is definitive (release retention). */
export function isDefinitiveTerminal(terminal: AiRunTerminalView | null | undefined): boolean {
  return (
    terminal?.kind === "completed" || terminal?.kind === "cancelled" || terminal?.kind === "failed"
  );
}

/** Extract terminal from an AiStreamResult-like value. */
export function terminalFromStreamResult(result: unknown): AiRunTerminalView | null {
  if (!result || typeof result !== "object") return null;
  const state = (result as AiStreamResultLike).state;
  if (!state || typeof state !== "object") return null;
  return (state as AiRunStreamState).terminal ?? null;
}

/** Extract terminal attached to a thrown protocol error, if any. */
export function terminalFromThrown(error: unknown): AiRunTerminalView | null {
  if (!error || typeof error !== "object") return null;
  if (!("state" in error)) return null;
  const state = (error as { state?: AiRunStreamState }).state;
  return state?.terminal ?? null;
}

/**
 * Holds retained operation UUIDs keyed by canonical action identity.
 * Not a React hook — one instance per conversation surface lifetime.
 */
export class ConversationOperations {
  #byKey = new Map<string, RetainedOperationId>();

  /** Get or create the retained id holder for this exact action identity. */
  retain(key: string): RetainedOperationId {
    let op = this.#byKey.get(key);
    if (!op) {
      op = new RetainedOperationId();
      this.#byKey.set(key, op);
    }
    return op;
  }

  /** Whether a holder already exists for this key (may still be unassigned). */
  has(key: string): boolean {
    return this.#byKey.has(key);
  }

  /** Assigned UUID for a key, if already minted. */
  peekId(key: string): string | null {
    const op = this.#byKey.get(key);
    if (!op || !op.assigned) return null;
    return op.id;
  }

  /** Release retention after a definitive terminal or successful non-stream mutation. */
  release(key: string): void {
    const op = this.#byKey.get(key);
    if (!op) return;
    op.reset();
    this.#byKey.delete(key);
  }

  /**
   * Release only when `terminal` is a definitive local v1 outcome.
   * Interrupted/EOF/null retains the identity for explicit retry.
   */
  releaseIfDefinitive(key: string, terminal: AiRunTerminalView | null | undefined): boolean {
    if (!isDefinitiveTerminal(terminal)) return false;
    this.release(key);
    return true;
  }

  /**
   * Drop deferred-create chat identities when the user starts a fresh draft.
   * Does not touch rename/delete/approval keys for other sessions.
   */
  resetDeferredChat(): void {
    for (const key of [...this.#byKey.keys()]) {
      if (
        key.startsWith("createSession:") ||
        key.startsWith("send:") ||
        key.startsWith("briefing:")
      ) {
        this.release(key);
      }
    }
  }

  /** Test/diagnostics: number of retained identities. */
  get size(): number {
    return this.#byKey.size;
  }
}
