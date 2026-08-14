/**
 * Shared worker-side request loop helpers (no engine imports).
 */

import {
  isLocalVoiceRequest,
  localVoiceError,
  type LocalVoiceRequest,
  type LocalVoiceResponse,
} from "../protocol.ts";
import { LocalVoiceClientError } from "../protocol.ts";

export type WorkerEngineOwner = {
  load: () => Promise<{
    packageId: string;
    modelId: string;
    revision: string;
    voiceId?: string;
  }>;
  transcribe?: (pcm: ArrayBuffer, sampleRate: number) => Promise<string>;
  synthesize?: (
    text: string,
  ) => Promise<
    | { format: "pcm-f32"; pcm: ArrayBuffer; sampleRate: number; channels: number }
    | { format: "wav"; wav: ArrayBuffer; sampleRate: number; channels: number }
  >;
  dispose: () => Promise<void>;
};

function errorCodeOf(error: unknown): Parameters<typeof localVoiceError>[0] {
  if (error instanceof LocalVoiceClientError) {
    return error.code;
  }
  return "worker_error";
}

/**
 * Install a generation-aware protocol handler on a dedicated worker scope.
 * After dispose, further requests (except a duplicate dispose) are rejected.
 */
export function installLocalVoiceWorker(
  ctx: DedicatedWorkerGlobalScope,
  owner: WorkerEngineOwner,
): void {
  let loaded = false;
  let disposed = false;
  let activeGeneration = -1;
  /** Serialize work so only one load/infer runs at a time inside the worker. */
  let chain: Promise<void> = Promise.resolve();

  const post = (response: LocalVoiceResponse, transfer: Transferable[] = []) => {
    if (disposed && response.type !== "disposed" && response.type !== "error") {
      return;
    }
    ctx.postMessage(response, transfer);
  };

  const handle = async (request: LocalVoiceRequest): Promise<void> => {
    const { requestId, generation } = request;

    if (disposed && request.type !== "dispose") {
      post(localVoiceError("disposed", requestId, generation));
      return;
    }

    switch (request.type) {
      case "ping":
        post({ type: "pong", requestId, generation });
        return;

      case "dispose": {
        disposed = true;
        try {
          await owner.dispose();
        } catch {
          // ignore
        }
        loaded = false;
        post({ type: "disposed", requestId, generation });
        return;
      }

      case "load": {
        if (loaded) {
          post(localVoiceError("already_loaded", requestId, generation));
          return;
        }
        try {
          const info = await owner.load();
          loaded = true;
          activeGeneration = generation;
          post({
            type: "load-complete",
            requestId,
            generation,
            packageId: info.packageId,
            modelId: info.modelId,
            revision: info.revision,
            ...(info.voiceId ? { voiceId: info.voiceId } : {}),
          });
        } catch (error) {
          post(
            localVoiceError(
              errorCodeOf(error) === "worker_error" ? "load_failed" : errorCodeOf(error),
              requestId,
              generation,
            ),
          );
        }
        return;
      }

      case "transcribe": {
        if (!loaded) {
          post(localVoiceError("not_loaded", requestId, generation));
          return;
        }
        if (!owner.transcribe) {
          post(localVoiceError("unsupported", requestId, generation));
          return;
        }
        try {
          const text = await owner.transcribe(request.pcm, request.sampleRate);
          post({ type: "transcript", requestId, generation, text });
        } catch (error) {
          post(localVoiceError(errorCodeOf(error), requestId, generation));
        }
        return;
      }

      case "synthesize": {
        if (!loaded) {
          post(localVoiceError("not_loaded", requestId, generation));
          return;
        }
        if (!owner.synthesize) {
          post(localVoiceError("unsupported", requestId, generation));
          return;
        }
        try {
          const audio = await owner.synthesize(request.text);
          if (audio.format === "pcm-f32") {
            post(
              {
                type: "audio",
                requestId,
                generation,
                format: "pcm-f32",
                sampleRate: audio.sampleRate,
                channels: audio.channels,
                pcm: audio.pcm,
              },
              [audio.pcm],
            );
          } else {
            post(
              {
                type: "audio",
                requestId,
                generation,
                format: "wav",
                sampleRate: audio.sampleRate,
                channels: audio.channels,
                wav: audio.wav,
              },
              [audio.wav],
            );
          }
        } catch (error) {
          post(localVoiceError(errorCodeOf(error), requestId, generation));
        }
        return;
      }

      default:
        post(localVoiceError("invalid_message", requestId, generation));
    }
  };

  ctx.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (!isLocalVoiceRequest(data)) {
      // Best-effort rejection when ids are present.
      const rough = data as { requestId?: unknown; generation?: unknown };
      const requestId = typeof rough?.requestId === "string" ? rough.requestId : "unknown";
      const generation = typeof rough?.generation === "number" ? rough.generation : -1;
      post(localVoiceError("invalid_message", requestId, generation));
      return;
    }

    // Ignore stale-generation traffic after a newer load/dispose generation.
    if (
      loaded &&
      activeGeneration >= 0 &&
      data.generation < activeGeneration &&
      data.type !== "dispose" &&
      data.type !== "ping"
    ) {
      return;
    }

    chain = chain
      .then(() => handle(data))
      .catch(() => {
        // Individual handlers already post errors.
      });
  };
}
