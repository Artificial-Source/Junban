/// <reference lib="webworker" />

/**
 * Kokoro worker entry. kokoro-js is dynamic-imported only after a load message.
 */

export type KokoroWorkerRequest = { type: "ping" } | { type: "load" } | { type: "dispose" };

export type KokoroWorkerResponse =
  | { type: "pong" }
  | { type: "load-complete"; packageId: string; modelId: string; revision: string }
  | { type: "load-error"; error: string }
  | { type: "disposed" };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

let disposeHandle: (() => void) | null = null;

ctx.onmessage = async (event: MessageEvent<KokoroWorkerRequest>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case "ping":
        ctx.postMessage({ type: "pong" } satisfies KokoroWorkerResponse);
        return;
      case "dispose":
        disposeHandle?.();
        disposeHandle = null;
        ctx.postMessage({ type: "disposed" } satisfies KokoroWorkerResponse);
        return;
      case "load": {
        const { loadKokoroEngine } = await import("../engines/load-kokoro.ts");
        const handle = await loadKokoroEngine();
        disposeHandle = handle.dispose;
        ctx.postMessage({
          type: "load-complete",
          packageId: handle.packageId,
          modelId: handle.modelId,
          revision: handle.revision,
        } satisfies KokoroWorkerResponse);
        return;
      }
      default:
        ctx.postMessage({
          type: "load-error",
          error: "Unknown kokoro worker message",
        } satisfies KokoroWorkerResponse);
    }
  } catch (error) {
    ctx.postMessage({
      type: "load-error",
      error: error instanceof Error ? error.message : String(error),
    } satisfies KokoroWorkerResponse);
  }
};
