/**
 * Mutation helpers with pending / error / outcome-unknown tracking.
 * One UUID Idempotency-Key is minted at user-action start (or supplied by the caller)
 * and retained across the single network retry inside the API client.
 */

import { useCallback, useRef, useState } from "react";
import type { MutationResponse } from "../api/client";
import {
  ApiError,
  NetworkError,
  generateOperationId,
  undoOperation as undoOperationApi,
} from "../api/client";

export type MutationPhase = "idle" | "pending" | "error" | "outcome-unknown";

export interface MutationState {
  phase: MutationPhase;
  error: string | null;
  lastOperationId: string | null;
  lastSourceOperationId: string | null;
}

export function formatMutationError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
}

/** Network failures after the request may have left the server are outcome-unknown. */
export function isOutcomeUnknown(error: unknown): boolean {
  return error instanceof NetworkError && !error.aborted;
}

export type RunMutationOptions = {
  /** Reuse a key when the caller is recovering from an outcome-unknown attempt. */
  operationId?: string;
  /** Called after outcome-unknown so the UI can force an authoritative refresh. */
  onOutcomeUnknown?: (operationId: string) => void | Promise<void>;
};

export function useMutations(): MutationState & {
  run: (
    execute: (operationId: string) => Promise<MutationResponse>,
    options?: RunMutationOptions,
  ) => Promise<MutationResponse | null>;
  undo: (
    sourceOperationId: string,
    options?: RunMutationOptions,
  ) => Promise<MutationResponse | null>;
  reset: () => void;
} {
  const [phase, setPhase] = useState<MutationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastOperationId, setLastOperationId] = useState<string | null>(null);
  const [lastSourceOperationId, setLastSourceOperationId] = useState<string | null>(null);
  const inFlightRef = useRef(0);

  const run = useCallback(
    async (
      execute: (operationId: string) => Promise<MutationResponse>,
      options?: RunMutationOptions,
    ): Promise<MutationResponse | null> => {
      const operationId = options?.operationId ?? generateOperationId();
      inFlightRef.current += 1;
      setPhase("pending");
      setError(null);
      setLastOperationId(operationId);
      try {
        const result = await execute(operationId);
        if (inFlightRef.current === 1) {
          setPhase("idle");
        }
        return result;
      } catch (err) {
        if (isOutcomeUnknown(err)) {
          setPhase("outcome-unknown");
          setError(formatMutationError(err));
          await options?.onOutcomeUnknown?.(operationId);
          return null;
        }
        setPhase("error");
        setError(formatMutationError(err));
        return null;
      } finally {
        inFlightRef.current = Math.max(0, inFlightRef.current - 1);
      }
    },
    [],
  );

  const undo = useCallback(
    async (
      sourceOperationId: string,
      options?: RunMutationOptions,
    ): Promise<MutationResponse | null> => {
      setLastSourceOperationId(sourceOperationId);
      return run((operationId) => undoOperationApi(sourceOperationId, operationId), options);
    },
    [run],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  return {
    phase,
    error,
    lastOperationId,
    lastSourceOperationId,
    run,
    undo,
    reset,
  };
}
