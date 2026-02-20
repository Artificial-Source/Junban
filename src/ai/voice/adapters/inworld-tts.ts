/**
 * Inworld AI TTS adapter.
 * High-quality, low-latency TTS with 15-language support.
 * Proxied through vite middleware to avoid CORS and handle base64 decoding.
 */

import type { TTSProviderPlugin, TTSOptions, TTSModel, Voice } from "../interface.js";

const INWORLD_MODELS: TTSModel[] = [
  { id: "inworld-tts-1.5-max", name: "TTS 1.5 Max (best quality, ~200ms)" },
  { id: "inworld-tts-1.5-mini", name: "TTS 1.5 Mini (fastest, ~100ms)" },
  { id: "inworld-tts-1-max", name: "TTS 1.0 Max" },
  { id: "inworld-tts-1", name: "TTS 1.0" },
];

export class InworldTTSProvider implements TTSProviderPlugin {
  readonly id = "inworld-tts";
  readonly name = "Inworld AI";
  readonly needsApiKey = true;

  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = "/api/voice/inworld-synthesize") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async synthesize(text: string, opts?: TTSOptions): Promise<ArrayBuffer> {
    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": this.apiKey,
      },
      body: JSON.stringify({
        text,
        voiceId: opts?.voice || "Ashley",
        modelId: opts?.model || "inworld-tts-1.5-max",
        audioConfig: { audioEncoding: "MP3" },
        applyTextNormalization: "OFF",
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Inworld TTS error (${res.status}): ${errText}`);
    }

    return res.arrayBuffer();
  }

  async getVoices(): Promise<Voice[]> {
    try {
      const res = await fetch(this.baseUrl.replace("inworld-synthesize", "inworld-voices"), {
        headers: { "X-Api-Key": this.apiKey },
      });

      if (!res.ok) return [];

      const data = await res.json();
      const voices: { voiceId: string; displayName: string }[] = data.voices ?? [];
      return voices.map((v) => ({ id: v.voiceId, name: v.displayName }));
    } catch {
      return [];
    }
  }

  async getModels(): Promise<TTSModel[]> {
    return INWORLD_MODELS;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }
}
