/**
 * AI run SSE stream pump and animation-frame batching.
 *
 * Orchestrates decoder + reducer over a fetch body. Does not auto-replay.
 * React stays outside the parser via pull API or once-per-frame callbacks.
 */

import { AiSseDecoder } from "./sse-decoder";
import { AiRunSseReducer } from "./sse-reducer";
import { AiSseError, type AiRunStreamState } from "./types";

export type AiRunStreamHandlers = {
  /** Fired after each accepted envelope (may be high frequency). */
  onState?: (state: AiRunStreamState) => void;
  /** Fired at most once per animation frame when visible text changes. */
  onVisibleText?: (text: string, state: AiRunStreamState) => void;
};

/**
 * Animation-frame batching helper so React can update visible text at most
 * once per frame without living inside the parser.
 */
export function createVisibleTextFrameBatcher(
  onFlush: (text: string, state: AiRunStreamState) => void,
  schedule: (cb: () => void) => number = defaultRaf,
  cancel: (id: number) => void = defaultCancelRaf,
): {
  notify: (state: AiRunStreamState) => void;
  flushNow: () => void;
  dispose: () => void;
} {
  let scheduled = false;
  let handle: number | null = null;
  let pending: AiRunStreamState | null = null;
  let lastRevision = -1;

  const flush = () => {
    scheduled = false;
    handle = null;
    if (!pending) return;
    if (pending.textRevision === lastRevision) return;
    lastRevision = pending.textRevision;
    onFlush(pending.visibleText, pending);
  };

  return {
    notify(state: AiRunStreamState) {
      pending = state;
      if (scheduled) return;
      scheduled = true;
      handle = schedule(flush);
    },
    flushNow() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      flush();
    },
    dispose() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      scheduled = false;
      pending = null;
    },
  };
}

/**
 * Read a fetch SSE body through the bounded decoder/reducer until terminal,
 * abort, or EOF. Does not auto-replay.
 */
export async function consumeAiRunSseStream(
  body: ReadableStream<Uint8Array>,
  options: {
    signal?: AbortSignal;
    handlers?: AiRunStreamHandlers;
  } = {},
): Promise<AiRunStreamState> {
  const decoder = new AiSseDecoder();
  const reducer = new AiRunSseReducer();
  const reader = body.getReader();
  const batcher = options.handlers?.onVisibleText
    ? createVisibleTextFrameBatcher(options.handlers.onVisibleText)
    : null;

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (options.signal) {
    if (options.signal.aborted) {
      batcher?.dispose();
      return reducer.finish({ aborted: true });
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const emit = (state: AiRunStreamState) => {
    options.handlers?.onState?.(state);
    if (batcher) batcher.notify(state);
  };

  try {
    while (true) {
      if (options.signal?.aborted) {
        batcher?.flushNow();
        return reducer.finish({ aborted: true });
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const frames = decoder.push(value);
      for (const frame of frames) {
        const state = reducer.pushFrame(frame);
        emit(state);
        if (state.terminal && state.terminal.kind !== "interrupted") {
          batcher?.flushNow();
          // Drain is not required; terminal ends logical consumption.
          await reader.cancel().catch(() => undefined);
          return state;
        }
      }
    }

    const trailing = decoder.finish();
    for (const frame of trailing) {
      const state = reducer.pushFrame(frame);
      emit(state);
      if (state.terminal && state.terminal.kind !== "interrupted") {
        batcher?.flushNow();
        return state;
      }
    }

    const finished = reducer.finish({ aborted: Boolean(options.signal?.aborted) });
    emit(finished);
    batcher?.flushNow();
    return finished;
  } catch (error) {
    batcher?.dispose();
    if (options.signal?.aborted) {
      return reducer.finish({ aborted: true });
    }
    if (error instanceof AiSseError) {
      // Protocol failure becomes interrupted so callers reload; error remains typed.
      const interrupted = reducer.finish();
      if (interrupted.terminal?.kind === "interrupted") {
        const withProtocol: AiRunStreamState = {
          ...interrupted,
          terminal: {
            kind: "interrupted",
            reason: "protocol",
            message: error.message,
          },
        };
        // Re-throw so callers can branch on AiSseError codes; state is still available
        // via the error cause pattern below.
        throw Object.assign(error, { state: withProtocol });
      }
      throw error;
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    batcher?.dispose();
    reader.releaseLock?.();
  }
}

function defaultRaf(cb: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(cb);
  }
  return setTimeout(cb, 16) as unknown as number;
}

function defaultCancelRaf(id: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(id);
    return;
  }
  clearTimeout(id);
}
