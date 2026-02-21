/**
 * Local Whisper STT adapter using @huggingface/transformers.
 * Runs Whisper models entirely in the browser via WASM.
 * Model is downloaded and cached on first use (~40MB for tiny.en quantized).
 */

import type { STTProviderPlugin, STTOptions } from "../interface.js";

export type ModelStatus = "idle" | "loading" | "ready" | "error";

export class WhisperLocalSTTProvider implements STTProviderPlugin {
  readonly id = "whisper-local";
  readonly name = "Whisper (Local)";
  readonly needsApiKey = false;
  readonly modelId: string;

  status: ModelStatus = "idle";
  progress = 0;
  onStatusChange?: (status: ModelStatus, progress: number) => void;

  private pipelineInstance: any = null;
  private loadPromise: Promise<void> | null = null;

  constructor(opts?: {
    modelId?: string;
    onStatusChange?: (status: ModelStatus, progress: number) => void;
  }) {
    this.modelId = opts?.modelId ?? "onnx-community/whisper-tiny.en";
    this.onStatusChange = opts?.onStatusChange;
  }

  /** Pre-load the model. Called automatically on first transcribe. */
  async preload(): Promise<void> {
    await this.ensureModel();
  }

  async transcribe(audio: Blob, _opts?: STTOptions): Promise<string> {
    await this.ensureModel();

    // Decode audio blob to Float32Array at 16kHz (Whisper's expected sample rate)
    const samples = await decodeAudioBlob(audio, 16000);

    const result = await this.pipelineInstance!(samples, {
      return_timestamps: false,
    });

    return (result?.text ?? "").trim();
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
    // Reset provider state
    this.pipelineInstance = null;
    this.loadPromise = null;
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

  private async ensureModel(): Promise<void> {
    if (this.pipelineInstance) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }
    this.loadPromise = this.loadModel();
    await this.loadPromise;
  }

  private async loadModel(): Promise<void> {
    this.status = "loading";
    this.progress = 0;
    this.onStatusChange?.("loading", 0);

    try {
      const { pipeline } = await import("@huggingface/transformers");
      this.pipelineInstance = await pipeline("automatic-speech-recognition", this.modelId, {
        dtype: "q4",
        device: "wasm",
        progress_callback: (event: any) => {
          if (event.status === "progress" && typeof event.progress === "number") {
            this.progress = Math.round(event.progress);
            this.onStatusChange?.("loading", this.progress);
          }
        },
      });
      this.status = "ready";
      this.progress = 100;
      this.onStatusChange?.("ready", 100);
    } catch (err) {
      this.status = "error";
      this.loadPromise = null;
      this.onStatusChange?.("error", 0);
      throw err;
    }
  }
}

/** Decode an audio Blob to a mono Float32Array at the target sample rate. */
async function decodeAudioBlob(blob: Blob, targetSampleRate: number): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new AudioContext();
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const duration = audioBuffer.duration;
    const numSamples = Math.ceil(duration * targetSampleRate);
    const offlineCtx = new OfflineAudioContext(1, numSamples, targetSampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const rendered = await offlineCtx.startRendering();
    return rendered.getChannelData(0);
  } finally {
    await audioCtx.close();
  }
}
