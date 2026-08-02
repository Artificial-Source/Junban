/// <reference lib="webworker" />

/**
 * Piper worker entry. The Piper package is dynamic-imported only after load.
 */

export type PiperWorkerRequest = { type: "ping" } | { type: "load" } | { type: "dispose" };

export type PiperWorkerResponse =
  | { type: "pong" }
  | {
      type: "load-complete";
      packageId: string;
      voiceId: string;
      revision: string;
      wasmPaths: {
        onnxWasm: string;
        piperData: string;
        piperWasm: string;
      };
    }
  | { type: "load-error"; error: string }
  | { type: "disposed" };

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

let disposeHandle: (() => void) | null = null;

ctx.onmessage = async (event: MessageEvent<PiperWorkerRequest>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case "ping":
        ctx.postMessage({ type: "pong" } satisfies PiperWorkerResponse);
        return;
      case "dispose":
        disposeHandle?.();
        disposeHandle = null;
        ctx.postMessage({ type: "disposed" } satisfies PiperWorkerResponse);
        return;
      case "load": {
        const { loadPiperEngine } = await import("../engines/load-piper.ts");
        const handle = await loadPiperEngine();
        disposeHandle = handle.dispose;
        ctx.postMessage({
          type: "load-complete",
          packageId: handle.packageId,
          voiceId: handle.voiceId,
          revision: handle.revision,
          wasmPaths: handle.wasmPaths,
        } satisfies PiperWorkerResponse);
        return;
      }
      default:
        ctx.postMessage({
          type: "load-error",
          error: "Unknown piper worker message",
        } satisfies PiperWorkerResponse);
    }
  } catch (error) {
    ctx.postMessage({
      type: "load-error",
      error: error instanceof Error ? error.message : String(error),
    } satisfies PiperWorkerResponse);
  }
};
