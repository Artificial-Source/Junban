/**
 * Host-side local voice worker clients.
 *
 * Workers are constructed only on explicit load() after caller consent.
 * One in-flight request is serialized per client; AbortSignal cancels the
 * host waiter and discards late responses. dispose() always terminates.
 */

import {
  isLocalVoiceResponse,
  LOCAL_VOICE_INFER_TIMEOUT_MS,
  LOCAL_VOICE_LOAD_TIMEOUT_MS,
  LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ,
  LocalVoiceClientError,
  LOCAL_VOICE_ERROR_MESSAGES,
  type LocalVoiceErrorCode,
  type LocalVoiceRequest,
  type LocalVoiceResponse,
  validateSynthesisText,
  validateWhisperPcm,
} from "./protocol.ts";
import { createKokoroWorker, createPiperWorker, createWhisperWorker } from "./worker-host.ts";

export type LocalVoiceLoadInfo = {
  readonly packageId: string;
  readonly modelId: string;
  readonly revision: string;
  readonly voiceId?: string;
  readonly generation: number;
};

export type LocalTranscribeResult = {
  readonly text: string;
  readonly generation: number;
};

export type LocalSynthesizeResult = {
  readonly format: "pcm-f32" | "wav";
  readonly sampleRate: number;
  readonly channels: number;
  readonly pcm?: Float32Array;
  readonly wav?: ArrayBuffer;
  readonly generation: number;
};

type Pending = {
  resolve: (value: LocalVoiceResponse) => void;
  reject: (error: LocalVoiceClientError) => void;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
};

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `lv-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export type LocalVoiceWorkerFactory = () => Worker;

export type LocalVoiceClientOptions = {
  /** Override worker construction (tests). */
  createWorker?: LocalVoiceWorkerFactory;
  loadTimeoutMs?: number;
  inferTimeoutMs?: number;
};

/**
 * Base host client: protocol transport, generation fencing, dispose/terminate.
 * Not a global singleton — callers own instances.
 */
export class LocalVoiceWorkerClient {
  private worker: Worker | null = null;
  private generation = 0;
  private loaded = false;
  private disposed = false;
  private readonly pending = new Map<string, Pending>();
  /** Serialize outbound requests (queue depth effectively 1 active + waiters). */
  private gate: Promise<unknown> = Promise.resolve();
  private inflight = 0;
  private readonly createWorker: LocalVoiceWorkerFactory;
  private readonly loadTimeoutMs: number;
  private readonly inferTimeoutMs: number;
  private readonly onMessage: (event: MessageEvent<unknown>) => void;

  constructor(createWorker: LocalVoiceWorkerFactory, options: LocalVoiceClientOptions = {}) {
    this.createWorker = options.createWorker ?? createWorker;
    this.loadTimeoutMs = options.loadTimeoutMs ?? LOCAL_VOICE_LOAD_TIMEOUT_MS;
    this.inferTimeoutMs = options.inferTimeoutMs ?? LOCAL_VOICE_INFER_TIMEOUT_MS;
    this.onMessage = (event: MessageEvent<unknown>) => {
      this.handleMessage(event.data);
    };
  }

  get isLoaded(): boolean {
    return this.loaded && !this.disposed;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /**
   * Create the dedicated worker (if needed) and load the engine inside it.
   * Safe to call only after user consent / verified download.
   */
  async load(signal?: AbortSignal): Promise<LocalVoiceLoadInfo> {
    if (this.disposed) {
      throw new LocalVoiceClientError("disposed");
    }
    if (this.loaded) {
      throw new LocalVoiceClientError("already_loaded");
    }
    return this.enqueue(async () => {
      if (this.disposed) {
        throw new LocalVoiceClientError("disposed");
      }
      if (this.loaded) {
        throw new LocalVoiceClientError("already_loaded");
      }
      this.ensureWorker();
      this.generation += 1;
      const generation = this.generation;
      const response = await this.send(
        { type: "load", requestId: newRequestId(), generation },
        this.loadTimeoutMs,
        signal,
      );
      if (response.type !== "load-complete") {
        throw new LocalVoiceClientError(response.type === "error" ? response.code : "load_failed");
      }
      this.loaded = true;
      return {
        packageId: response.packageId,
        modelId: response.modelId,
        revision: response.revision,
        voiceId: response.voiceId,
        generation,
      };
    });
  }

  /**
   * Post dispose, then always terminate, drop listeners, and reject pending
   * waiters. Idempotent. Termination is the authoritative cancellation; the
   * worker ack is best-effort and never blocks cleanup.
   */
  async dispose(): Promise<void> {
    if (this.disposed && !this.worker) {
      return;
    }
    this.disposed = true;
    this.loaded = false;
    this.generation += 1;
    const generation = this.generation;
    const worker = this.worker;

    // Reject anything still waiting under prior generations.
    this.rejectAllPending("disposed");

    if (!worker) {
      return;
    }

    try {
      worker.postMessage({
        type: "dispose",
        requestId: newRequestId(),
        generation,
      } satisfies LocalVoiceRequest);
    } catch {
      // ignore — termination below is authoritative
    }
    // Microtask gap so the dispose message can be delivered before terminate
    // in cooperative runtimes; never block on an ack.
    await Promise.resolve();
    this.teardownWorker(worker);
  }

  protected async requestTranscribe(
    samples: Float32Array,
    generation: number,
    signal?: AbortSignal,
  ): Promise<LocalTranscribeResult> {
    if (this.disposed) {
      throw new LocalVoiceClientError("disposed");
    }
    if (!this.loaded) {
      throw new LocalVoiceClientError("not_loaded");
    }
    if (generation !== this.generation) {
      throw new LocalVoiceClientError("aborted");
    }
    const copy = new Float32Array(samples.length);
    copy.set(samples);
    const validated = validateWhisperPcm(copy.buffer, LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ);
    if (!validated.ok) {
      throw new LocalVoiceClientError(validated.code);
    }
    return this.enqueue(async () => {
      this.assertActive(generation);
      const pcmCopy = new Float32Array(validated.samples.length);
      pcmCopy.set(validated.samples);
      const pcm = pcmCopy.buffer as ArrayBuffer;
      const response = await this.send(
        {
          type: "transcribe",
          requestId: newRequestId(),
          generation,
          pcm,
          sampleRate: LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ,
        },
        this.inferTimeoutMs,
        signal,
        [pcm],
      );
      if (response.type !== "transcript") {
        throw new LocalVoiceClientError(response.type === "error" ? response.code : "infer_failed");
      }
      return { text: response.text, generation };
    });
  }

  protected async requestSynthesize(
    text: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<LocalSynthesizeResult> {
    if (this.disposed) {
      throw new LocalVoiceClientError("disposed");
    }
    if (!this.loaded) {
      throw new LocalVoiceClientError("not_loaded");
    }
    if (generation !== this.generation) {
      throw new LocalVoiceClientError("aborted");
    }
    const validated = validateSynthesisText(text);
    if (!validated.ok) {
      throw new LocalVoiceClientError(validated.code);
    }
    return this.enqueue(async () => {
      this.assertActive(generation);
      const response = await this.send(
        {
          type: "synthesize",
          requestId: newRequestId(),
          generation,
          text: validated.text,
        },
        this.inferTimeoutMs,
        signal,
      );
      if (response.type !== "audio") {
        throw new LocalVoiceClientError(response.type === "error" ? response.code : "infer_failed");
      }
      if (response.format === "pcm-f32") {
        if (!response.pcm) {
          throw new LocalVoiceClientError("infer_failed");
        }
        return {
          format: "pcm-f32",
          sampleRate: response.sampleRate,
          channels: response.channels,
          pcm: new Float32Array(response.pcm),
          generation,
        };
      }
      if (!response.wav) {
        throw new LocalVoiceClientError("infer_failed");
      }
      return {
        format: "wav",
        sampleRate: response.sampleRate,
        channels: response.channels,
        wav: response.wav,
        generation,
      };
    });
  }

  private assertActive(generation: number): void {
    if (this.disposed) {
      throw new LocalVoiceClientError("disposed");
    }
    if (!this.loaded) {
      throw new LocalVoiceClientError("not_loaded");
    }
    if (generation !== this.generation) {
      throw new LocalVoiceClientError("aborted");
    }
  }

  private ensureWorker(): void {
    if (this.worker) return;
    const worker = this.createWorker();
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onWorkerError);
    worker.addEventListener("messageerror", this.onWorkerError);
    this.worker = worker;
  }

  private readonly onWorkerError = (): void => {
    this.rejectAllPending("worker_error");
  };

  private teardownWorker(worker: Worker): void {
    try {
      worker.removeEventListener("message", this.onMessage);
      worker.removeEventListener("error", this.onWorkerError);
      worker.removeEventListener("messageerror", this.onWorkerError);
    } catch {
      // ignore
    }
    try {
      worker.terminate();
    } catch {
      // ignore
    }
    if (this.worker === worker) {
      this.worker = null;
    }
  }

  private handleMessage(data: unknown): void {
    if (!isLocalVoiceResponse(data)) {
      return;
    }
    // Drop late/duplicate responses after dispose or generation change.
    if (data.generation !== this.generation && data.type !== "disposed") {
      return;
    }
    const pending = this.pending.get(data.requestId);
    if (!pending) {
      return;
    }
    if (pending.generation !== data.generation && data.type !== "disposed") {
      return;
    }
    this.pending.delete(data.requestId);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.resolve(data);
  }

  private rejectAllPending(code: LocalVoiceErrorCode): void {
    const error = new LocalVoiceClientError(code);
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private send(
    request: LocalVoiceRequest,
    timeoutMs: number,
    signal?: AbortSignal,
    transfer: Transferable[] = [],
  ): Promise<LocalVoiceResponse> {
    if (this.disposed && request.type !== "dispose") {
      return Promise.reject(new LocalVoiceClientError("disposed"));
    }
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new LocalVoiceClientError("worker_error"));
    }
    if (signal?.aborted) {
      return Promise.reject(new LocalVoiceClientError("aborted"));
    }
    if (this.pending.has(request.requestId)) {
      return Promise.reject(new LocalVoiceClientError("invalid_message"));
    }

    return new Promise<LocalVoiceResponse>((resolve, reject) => {
      let settled = false;

      const onAbort = () => {
        finalizeReject("aborted");
      };

      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
      };

      const finalizeReject = (code: LocalVoiceErrorCode) => {
        if (settled) return;
        settled = true;
        const pending = this.pending.get(request.requestId);
        this.pending.delete(request.requestId);
        if (pending?.timer) clearTimeout(pending.timer);
        cleanup();
        reject(new LocalVoiceClientError(code, LOCAL_VOICE_ERROR_MESSAGES[code]));
      };

      const pending: Pending = {
        generation: request.generation,
        timer: setTimeout(() => {
          finalizeReject("timeout");
        }, timeoutMs),
        resolve: (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(request.requestId, pending);

      try {
        worker.postMessage(request, transfer);
      } catch {
        finalizeReject("worker_error");
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    // Bounded queue: one active + at most one waiter. Further callers get busy.
    if (this.inflight >= 2) {
      return Promise.reject(new LocalVoiceClientError("busy"));
    }
    this.inflight += 1;
    const run = this.gate.then(task, task);
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.inflight -= 1;
    });
  }
}

/** Whisper STT client — adapter-compatible transcribe(). */
export class LocalWhisperClient extends LocalVoiceWorkerClient {
  constructor(options: LocalVoiceClientOptions = {}) {
    super(createWhisperWorker, options);
  }

  async transcribe(
    samples: Float32Array,
    generation: number,
    signal?: AbortSignal,
  ): Promise<LocalTranscribeResult> {
    return this.requestTranscribe(samples, generation, signal);
  }
}

/** Kokoro TTS client — adapter-compatible synthesize() returning PCM. */
export class LocalKokoroClient extends LocalVoiceWorkerClient {
  constructor(options: LocalVoiceClientOptions = {}) {
    super(createKokoroWorker, options);
  }

  async synthesize(
    text: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<LocalSynthesizeResult> {
    return this.requestSynthesize(text, generation, signal);
  }
}

/** Piper TTS client — adapter-compatible synthesize() returning WAV. */
export class LocalPiperClient extends LocalVoiceWorkerClient {
  constructor(options: LocalVoiceClientOptions = {}) {
    super(createPiperWorker, options);
  }

  async synthesize(
    text: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<LocalSynthesizeResult> {
    return this.requestSynthesize(text, generation, signal);
  }
}

export function createLocalWhisperClient(options?: LocalVoiceClientOptions): LocalWhisperClient {
  return new LocalWhisperClient(options);
}

export function createLocalKokoroClient(options?: LocalVoiceClientOptions): LocalKokoroClient {
  return new LocalKokoroClient(options);
}

export function createLocalPiperClient(options?: LocalVoiceClientOptions): LocalPiperClient {
  return new LocalPiperClient(options);
}
