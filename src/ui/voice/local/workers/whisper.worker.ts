/// <reference lib="webworker" />

/**
 * Whisper worker entry. Engine packages are dynamic-imported only after a load message.
 */

export type WhisperWorkerRequest =
  { type: "ping" } | { type: "load"; packageId: string } | { type: "dispose" };

export type WhisperWorkerResponse =
  | { type: "pong" }
  | { type: "load-complete"; packageId: string; modelId: string; revision: string }
  | { type: "load-error"; error: string }
  | { type: "disposed" };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

let disposeHandle: (() => void) | null = null;

ctx.onmessage = async (event: MessageEvent<WhisperWorkerRequest>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case "ping":
        ctx.postMessage({ type: "pong" } satisfies WhisperWorkerResponse);
        return;
      case "dispose":
        disposeHandle?.();
        disposeHandle = null;
        ctx.postMessage({ type: "disposed" } satisfies WhisperWorkerResponse);
        return;
      case "load": {
        const { loadWhisperEngine } = await import("../engines/load-whisper.ts");
        const handle = await loadWhisperEngine();
        disposeHandle = handle.dispose;
        ctx.postMessage({
          type: "load-complete",
          packageId: handle.packageId,
          modelId: handle.modelId,
          revision: handle.revision,
        } satisfies WhisperWorkerResponse);
        return;
      }
      default:
        ctx.postMessage({
          type: "load-error",
          error: "Unknown whisper worker message",
        } satisfies WhisperWorkerResponse);
    }
  } catch (error) {
    ctx.postMessage({
      type: "load-error",
      error: error instanceof Error ? error.message : String(error),
    } satisfies WhisperWorkerResponse);
  }
};
