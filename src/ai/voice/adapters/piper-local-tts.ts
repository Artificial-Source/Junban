/**
 * Local Piper TTS adapter using @mintplex-labs/piper-tts-web.
 * Runs Piper TTS models entirely in the browser via WASM + OPFS caching.
 * Per-voice models (~60-75MB each) are downloaded on first use.
 */

import type { TTSProviderPlugin, TTSOptions, Voice } from "../interface.js";

export type ModelStatus = "idle" | "loading" | "ready" | "error";

const PIPER_VOICES: Voice[] = [
  { id: "en_US-hfc_female-medium", name: "HFC Female (US)" },
  { id: "en_US-hfc_male-medium", name: "HFC Male (US)" },
  { id: "en_US-amy-medium", name: "Amy (US)" },
  { id: "en_US-danny-low", name: "Danny (US)" },
  { id: "en_US-joe-medium", name: "Joe (US)" },
  { id: "en_US-kristin-medium", name: "Kristin (US)" },
  { id: "en_US-lessac-medium", name: "Lessac (US)" },
  { id: "en_US-ryan-medium", name: "Ryan (US)" },
  { id: "en_GB-alba-medium", name: "Alba (UK)" },
  { id: "en_GB-cori-medium", name: "Cori (UK)" },
];

export class PiperLocalTTSProvider implements TTSProviderPlugin {
  readonly id = "piper-local";
  readonly name = "Piper (Local)";
  readonly needsApiKey = false;
  readonly modelId: string;

  status: ModelStatus = "idle";
  progress = 0;
  onStatusChange?: (status: ModelStatus, progress: number) => void;

  private defaultVoice: string;

  constructor(opts?: {
    defaultVoice?: string;
    onStatusChange?: (status: ModelStatus, progress: number) => void;
  }) {
    this.defaultVoice = opts?.defaultVoice ?? "en_US-hfc_female-medium";
    this.modelId = this.defaultVoice;
    this.onStatusChange = opts?.onStatusChange;
  }

  /** Pre-download the default voice model. */
  async preload(): Promise<void> {
    this.status = "loading";
    this.progress = 0;
    this.onStatusChange?.("loading", 0);

    try {
      const tts = await import("@mintplex-labs/piper-tts-web");
      await tts.download(this.defaultVoice as any, (p) => {
        if (p.total > 0) {
          this.progress = Math.round((p.loaded / p.total) * 100);
          this.onStatusChange?.("loading", this.progress);
        }
      });
      this.status = "ready";
      this.progress = 100;
      this.onStatusChange?.("ready", 100);
    } catch (err) {
      this.status = "error";
      this.onStatusChange?.("error", 0);
      throw err;
    }
  }

  async synthesize(text: string, opts?: TTSOptions): Promise<ArrayBuffer> {
    const voiceId = opts?.voice ?? this.defaultVoice;

    const tts = await import("@mintplex-labs/piper-tts-web");
    const blob = await tts.predict({ text, voiceId: voiceId as any }, (p) => {
      if (this.status !== "ready" && p.total > 0) {
        this.status = "loading";
        this.progress = Math.round((p.loaded / p.total) * 100);
        this.onStatusChange?.("loading", this.progress);
      }
    });

    if (this.status !== "ready") {
      this.status = "ready";
      this.progress = 100;
      this.onStatusChange?.("ready", 100);
    }

    return blob.arrayBuffer();
  }

  async getVoices(): Promise<Voice[]> {
    return PIPER_VOICES;
  }

  async isAvailable(): Promise<boolean> {
    return typeof window !== "undefined" && typeof WebAssembly !== "undefined";
  }

  /** Check if any voice models are already cached in OPFS (no library import needed). */
  async checkCached(): Promise<boolean> {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("piper", { create: false });
      for await (const name of (dir as any).keys()) {
        if ((name as string).endsWith(".onnx")) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Delete cached model files from OPFS. */
  async deleteModel(): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("piper", { recursive: true });
    } catch {
      // Directory may not exist
    }
    this.status = "idle";
    this.progress = 0;
    this.onStatusChange?.("idle", 0);
  }

  /** Get the total size of cached model files in OPFS in bytes. */
  async getModelSize(): Promise<number> {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("piper", { create: false });
      let totalSize = 0;
      for await (const name of (dir as any).keys()) {
        try {
          const fileHandle = await dir.getFileHandle(name as string);
          const file = await fileHandle.getFile();
          totalSize += file.size;
        } catch {
          /* skip unreadable entries */
        }
      }
      return totalSize;
    } catch {
      return 0;
    }
  }
}
