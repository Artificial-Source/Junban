/**
 * Local Kokoro TTS adapter using kokoro-js.
 * Runs Kokoro TTS models entirely in the browser via WASM.
 * Model is downloaded and cached on first use (~160MB).
 */

import type { TTSProviderPlugin, TTSOptions, Voice } from "../interface.js";
import { float32ToWav } from "../audio-utils.js";

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

export class KokoroLocalTTSProvider implements TTSProviderPlugin {
  readonly id = "kokoro-local";
  readonly name = "Kokoro (Local)";
  readonly needsApiKey = false;
  readonly modelId: string;

  status: ModelStatus = "idle";
  progress = 0;
  onStatusChange?: (status: ModelStatus, progress: number) => void;

  private ttsInstance: any = null;
  private loadPromise: Promise<void> | null = null;

  constructor(opts?: {
    modelId?: string;
    onStatusChange?: (status: ModelStatus, progress: number) => void;
  }) {
    this.modelId = opts?.modelId ?? "onnx-community/Kokoro-82M-v1.0-ONNX";
    this.onStatusChange = opts?.onStatusChange;
  }

  /** Pre-load the model. Called automatically on first synthesize. */
  async preload(): Promise<void> {
    await this.ensureModel();
  }

  async synthesize(text: string, opts?: TTSOptions): Promise<ArrayBuffer> {
    await this.ensureModel();

    const voice = opts?.voice ?? "af_heart";
    const result = await this.ttsInstance!.generate(text, { voice });

    // kokoro-js returns { audio: Float32Array, sampling_rate: number }
    const samples: Float32Array = result.audio ?? result.data;
    const sampleRate: number = result.sampling_rate ?? result.samplingRate ?? 24000;

    // Convert to WAV ArrayBuffer
    const wavBlob = float32ToWav(samples, sampleRate);
    return wavBlob.arrayBuffer();
  }

  async getVoices(): Promise<Voice[]> {
    return KOKORO_VOICES;
  }

  async isAvailable(): Promise<boolean> {
    return typeof window !== "undefined" && typeof WebAssembly !== "undefined";
  }

  private async ensureModel(): Promise<void> {
    if (this.ttsInstance) return;
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
      const { KokoroTTS } = await import("kokoro-js");
      this.ttsInstance = await KokoroTTS.from_pretrained(this.modelId, {
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
