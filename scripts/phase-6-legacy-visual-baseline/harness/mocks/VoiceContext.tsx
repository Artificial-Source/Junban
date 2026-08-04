import { createContext, useContext, useMemo, type ReactNode } from "react";
import { readFixture } from "./read-fixture";

export type VoiceMode = "off" | "push-to-talk" | "vad";

export interface VoiceSettings {
  sttProviderId: string;
  ttsProviderId: string;
  voiceMode: VoiceMode;
  ttsEnabled: boolean;
  autoSend: boolean;
  ttsVoice: string;
  ttsModel: string;
  groqApiKey: string;
  inworldApiKey: string;
  microphoneId: string;
  smartEndpoint: boolean;
  gracePeriodMs: number;
}

type STTProvider = {
  id: string;
  name: string;
  needsApiKey?: boolean;
  startLiveRecognition?: (opts?: unknown, signal?: AbortSignal) => Promise<string>;
};

type TTSProvider = {
  id: string;
  name: string;
  needsApiKey?: boolean;
};

type VoiceContextValue = {
  settings: VoiceSettings;
  updateSettings: (patch: Partial<VoiceSettings>) => void;
  registry: {
    listSTT: () => STTProvider[];
    listTTS: () => TTSProvider[];
  };
  sttProvider: STTProvider | null;
  ttsProvider: TTSProvider | null;
  isTranscribing: boolean;
  isSpeaking: boolean;
  speak: (text: string) => Promise<void>;
  cancelSpeech: () => void;
  transcribeAudio: (blob: Blob) => Promise<string>;
  ttsVoices: { id: string; name: string }[];
  ttsModels: { id: string; label: string }[];
  localProvidersLoaded: boolean;
  ensureLocalProvidersLoaded: () => Promise<void>;
  ensureRegistryLoaded: () => Promise<void>;
};

const VoiceContext = createContext<VoiceContextValue | null>(null);

const STT_PROVIDERS: STTProvider[] = [
  { id: "browser-stt", name: "Browser Speech Recognition" },
  { id: "groq-stt", name: "Groq Whisper", needsApiKey: true },
  { id: "openai-stt", name: "OpenAI Whisper", needsApiKey: true },
];

const TTS_PROVIDERS: TTSProvider[] = [
  { id: "browser-tts", name: "Browser Speech Synthesis" },
  { id: "groq-tts", name: "Groq PlayAI", needsApiKey: true },
  { id: "inworld-tts", name: "Inworld", needsApiKey: true },
];

function hangingRecognition(_opts?: unknown, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort);
    // Intentionally never resolves while listening — drives PTT listening state.
  });
}

function permissionDeniedRecognition(): Promise<string> {
  return Promise.reject(Object.assign(new Error("not-allowed"), { code: "not-allowed" }));
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const fixture = readFixture();

  const value = useMemo<VoiceContextValue>(() => {
    const settings: VoiceSettings = {
      sttProviderId: fixture.voiceSttProviderId,
      ttsProviderId: fixture.voiceTtsProviderId,
      voiceMode: fixture.voiceMode,
      ttsEnabled: fixture.voiceTtsProviderId !== "browser-tts",
      autoSend: true,
      ttsVoice: fixture.voiceTtsProviderId === "browser-tts" ? "" : "alloy",
      ttsModel: "",
      groqApiKey: fixture.voiceGroqApiKeySet ? "••••••••••••mask" : "",
      inworldApiKey: "",
      microphoneId: "",
      smartEndpoint: false,
      gracePeriodMs: 1500,
    };

    const sttBase = STT_PROVIDERS.find((p) => p.id === settings.sttProviderId) ?? STT_PROVIDERS[0];
    let sttProvider: STTProvider | null = { ...sttBase };

    if (fixture.pttMode === "listening") {
      sttProvider = {
        ...sttBase,
        id: "browser-stt",
        startLiveRecognition: hangingRecognition,
      };
    } else if (fixture.pttMode === "error") {
      sttProvider = {
        ...sttBase,
        id: "browser-stt",
        startLiveRecognition: permissionDeniedRecognition,
      };
    } else {
      sttProvider = {
        ...sttBase,
        id: sttBase.id === "browser-stt" ? "browser-stt" : sttBase.id,
        startLiveRecognition:
          sttBase.id === "browser-stt" ? async () => "demo transcript" : undefined,
      };
    }

    return {
      settings,
      updateSettings: () => undefined,
      registry: {
        listSTT: () => STT_PROVIDERS,
        listTTS: () => TTS_PROVIDERS,
      },
      sttProvider,
      ttsProvider: TTS_PROVIDERS.find((p) => p.id === settings.ttsProviderId) ?? TTS_PROVIDERS[0],
      isTranscribing: fixture.pttMode === "transcribing",
      isSpeaking: false,
      speak: async () => undefined,
      cancelSpeech: () => undefined,
      transcribeAudio: async () => "demo transcript",
      ttsVoices:
        settings.ttsProviderId === "browser-tts"
          ? []
          : [
              { id: "alloy", name: "Alloy" },
              { id: "verse", name: "Verse" },
            ],
      ttsModels: [],
      localProvidersLoaded: true,
      ensureLocalProvidersLoaded: async () => undefined,
      ensureRegistryLoaded: async () => undefined,
    };
  }, [fixture]);

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoiceContext(): VoiceContextValue {
  const ctx = useContext(VoiceContext);
  if (!ctx) {
    throw new Error("useVoiceContext requires VoiceProvider in the Phase 6 harness");
  }
  return ctx;
}

export type { VoiceContextValue };
