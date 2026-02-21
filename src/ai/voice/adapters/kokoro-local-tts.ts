/**
 * Local Kokoro TTS adapter using kokoro-js via Web Worker.
 * Runs Kokoro TTS models in a dedicated worker thread to prevent UI freezes.
 * Model is downloaded and cached on first use (~160MB).
 */

import type { TTSProviderPlugin, TTSOptions, Voice } from "../interface.js";
import type { KokoroWorkerRequest, KokoroWorkerResponse } from "../workers/kokoro-worker-types.js";

export type ModelStatus = "idle" | "loading" | "ready" | "error";

const KOKORO_VOICES: Voice[] = [
  { id: "af_heart", name: "Heart (Female)" },
  { id: "af_alloy", name: "Alloy (Female)" },
  { id: "af_aoede", name: "Aoede (Female)" },
  { id: "af_bella", name: "Bella (Female)" },
  { id: "af_jessica", name: "Jessica (Female)" },
  { id: "af_kore", name: "Kore (Female)" },
  { id: "af_nicole", name: "Nicole (Female)" },
  { id: "af_nova", name: "Nova (Female)" },
  { id: "af_river", name: "River (Female)" },
  { id: "af_sarah", name: "Sarah (Female)" },
  { id: "af_sky", name: "Sky (Female)" },
  { id: "am_adam", name: "Adam (Male)" },
  { id: "am_echo", name: "Echo (Male)" },
  { id: "am_eric", name: "Eric (Male)" },
  { id: "am_liam", name: "Liam (Male)" },
  { id: "am_michael", name: "Michael (Male)" },
  { id: "am_onyx", name: "Onyx (Male)" },
  { id: "am_puck", name: "Puck (Male)" },
  { id: "am_santa", name: "Santa (Male)" },
  { id: "bf_emma", name: "Emma (British Female)" },
  { id: "bm_george", name: "George (British Male)" },
];

let synthesisCounter = 0;

export class KokoroLocalTTSProvider implements TTSProviderPlugin {
  readonly id = "kokoro-local";
  readonly name = "Kokoro (Local)";
  readonly needsApiKey = false;
  readonly modelId: string;

  status: ModelStatus = "idle";
  progress = 0;
  onStatusChange?: (status: ModelStatus, progress: number) => void;

  private worker: Worker | null = null;
  private modelLoaded = false;
  private loadPromise: Promise<void> | null = null;
  private pendingSyntheses = new Map<
    string,
    {
      resolve: (buf: ArrayBuffer) => void;
      reject: (err: Error) => void;
    }
  >();

  constructor(opts?: {
    modelId?: string;
    onStatusChange?: (status: ModelStatus, progress: number) => void;
  }) {
    this.modelId = opts?.modelId ?? "onnx-community/Kokoro-82M-v1.0-ONNX";
    this.onStatusChange = opts?.onStatusChange;
  }

  /** Pre-load the model in the worker. Called automatically on first synthesize. */
  async preload(): Promise<void> {
    await this.ensureModel();
  }

  async synthesize(text: string, opts?: TTSOptions): Promise<ArrayBuffer> {
    await this.ensureModel();

    const voice = opts?.voice ?? "af_heart";
    const id = `synth-${++synthesisCounter}`;

    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pendingSyntheses.set(id, { resolve, reject });
      this.postMessage({ type: "synthesize", id, text, voice });
    });
  }

  async getVoices(): Promise<Voice[]> {
    return KOKORO_VOICES;
  }

  async isAvailable(): Promise<boolean> {
    return typeof window !== "undefined" && typeof WebAssembly !== "undefined";
  }

  /** Check if model files are already present in the browser's cache storage. */
  async checkCached(): Promise<boolean> {
    if (typeof caches === "undefined") return false;
    try {
      const names = await caches.keys();
      for (const name of names) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        if (keys.some((req) => req.url.includes(this.modelId))) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Delete cached model files from Cache Storage. */
  async deleteModel(): Promise<void> {
    // Terminate worker first
    this.terminateWorker();
    if (typeof caches === "undefined") return;
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      for (const req of keys) {
        if (req.url.includes(this.modelId)) {
          await cache.delete(req);
        }
      }
    }
    this.status = "idle";
    this.progress = 0;
    this.onStatusChange?.("idle", 0);
  }

  /** Get the total size of cached model files in bytes. */
  async getModelSize(): Promise<number> {
    if (typeof caches === "undefined") return 0;
    let totalSize = 0;
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      for (const req of keys) {
        if (req.url.includes(this.modelId)) {
          try {
            const response = await cache.match(req);
            if (response) {
              // Prefer Content-Length header to avoid reading full blob into memory
              const cl = response.headers.get("Content-Length");
              if (cl) {
                totalSize += parseInt(cl, 10) || 0;
              } else {
                const blob = await response.blob();
                totalSize += blob.size;
              }
            }
          } catch {
            /* skip unreadable entries */
          }
        }
      }
    }
    return totalSize;
  }

  private postMessage(msg: KokoroWorkerRequest): void {
    this.worker!.postMessage(msg);
  }

  private createWorker(): Worker {
    const worker = new Worker(new URL("../workers/kokoro.worker.ts", import.meta.url), {
      type: "module",
    });

    worker.addEventListener("message", (e: MessageEvent<KokoroWorkerResponse>) => {
      this.handleWorkerMessage(e.data);
    });

    worker.addEventListener("error", (e) => {
      console.warn("[Kokoro Worker] Error:", e?.message ?? e);
      this.handleWorkerCrash();
    });

    return worker;
  }

  private handleWorkerMessage(msg: KokoroWorkerResponse): void {
    switch (msg.type) {
      case "load-progress":
        this.progress = msg.progress;
        this.onStatusChange?.("loading", msg.progress);
        break;

      case "load-complete":
        this.modelLoaded = true;
        this.status = "ready";
        this.progress = 100;
        this.onStatusChange?.("ready", 100);
        break;

      case "load-error":
        this.status = "error";
        this.terminateWorker();
        this.onStatusChange?.("error", 0);
        break;

      case "synthesize-complete": {
        const pending = this.pendingSyntheses.get(msg.id);
        if (pending) {
          this.pendingSyntheses.delete(msg.id);
          pending.resolve(msg.buffer);
        }
        break;
      }

      case "synthesize-error": {
        const pending = this.pendingSyntheses.get(msg.id);
        if (pending) {
          this.pendingSyntheses.delete(msg.id);
          pending.reject(new Error(msg.error));
        }
        break;
      }
    }
  }

  private handleWorkerCrash(): void {
    this.status = "error";
    this.onStatusChange?.("error", 0);

    // Reject all pending syntheses
    for (const [id, { reject }] of this.pendingSyntheses) {
      reject(new Error("Worker crashed"));
      this.pendingSyntheses.delete(id);
    }

    this.terminateWorker();
  }

  private terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.modelLoaded = false;
    this.loadPromise = null;
  }

  private async ensureModel(): Promise<void> {
    if (this.modelLoaded && this.worker) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }
    this.loadPromise = this.loadModel();
    await this.loadPromise;
  }

  private loadModel(): Promise<void> {
    this.status = "loading";
    this.progress = 0;
    this.onStatusChange?.("loading", 0);

    const worker = (this.worker = this.createWorker());

    return new Promise<void>((resolve, reject) => {
      const onMessage = (e: MessageEvent<KokoroWorkerResponse>) => {
        if (e.data.type === "load-complete") {
          worker.removeEventListener("message", onMessage);
          resolve();
        }
        if (e.data.type === "load-error") {
          worker.removeEventListener("message", onMessage);
          reject(new Error(e.data.error));
        }
      };
      worker.addEventListener("message", onMessage);
      this.postMessage({ type: "load", modelId: this.modelId });
    });
  }
}
