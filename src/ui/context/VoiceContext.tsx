/**
 * Voice state management context.
 * Manages STT/TTS providers, voice mode, and voice state.
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { VoiceProviderRegistry } from "../../ai/voice/registry.js";
import { createDefaultVoiceRegistry } from "../../ai/voice/provider.js";
import type {
  STTProviderPlugin,
  TTSProviderPlugin,
  TTSModel,
  Voice,
} from "../../ai/voice/interface.js";
import { BrowserTTSProvider } from "../../ai/voice/adapters/browser-tts.js";
import { playAudioBuffer } from "../../ai/voice/audio-utils.js";

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

const DEFAULT_SETTINGS: VoiceSettings = {
  sttProviderId: "browser-stt",
  ttsProviderId: "browser-tts",
  voiceMode: "push-to-talk",
  ttsEnabled: false,
  autoSend: true,
  ttsVoice: "",
  ttsModel: "",
  groqApiKey: "",
  inworldApiKey: "",
  microphoneId: "",
  smartEndpoint: false,
  gracePeriodMs: 1500,
};

const STORAGE_KEY = "saydo-voice-settings";

function loadSettings(): VoiceSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: VoiceSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

interface VoiceContextValue {
  settings: VoiceSettings;
  updateSettings: (patch: Partial<VoiceSettings>) => void;
  registry: VoiceProviderRegistry;
  sttProvider: STTProviderPlugin | undefined;
  ttsProvider: TTSProviderPlugin | undefined;
  ttsVoices: Voice[];
  ttsModels: TTSModel[];
  isListening: boolean;
  isTranscribing: boolean;
  isSpeaking: boolean;
  startListening: () => void;
  stopListening: () => void;
  speak: (text: string) => Promise<void>;
  cancelSpeech: () => void;
  transcribeAudio: (audio: Blob) => Promise<string>;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<VoiceSettings>(loadSettings);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [ttsVoices, setTTSVoices] = useState<Voice[]>([]);
  const [ttsModels, setTTSModels] = useState<TTSModel[]>([]);
  const speechCancelledRef = useRef(false);
  const playbackCancelRef = useRef<(() => void) | null>(null);

  // Build registry whenever API keys change
  const [registry, setRegistry] = useState<VoiceProviderRegistry>(() =>
    createDefaultVoiceRegistry({
      groqApiKey: settings.groqApiKey || undefined,
      inworldApiKey: settings.inworldApiKey || undefined,
    }),
  );

  useEffect(() => {
    setRegistry(
      createDefaultVoiceRegistry({
        groqApiKey: settings.groqApiKey || undefined,
        inworldApiKey: settings.inworldApiKey || undefined,
      }),
    );
  }, [settings.groqApiKey, settings.inworldApiKey]);

  const sttProvider = registry.getSTT(settings.sttProviderId);
  const ttsProvider = registry.getTTS(settings.ttsProviderId);

  // Fetch TTS voices when provider changes
  useEffect(() => {
    if (ttsProvider?.getVoices) {
      ttsProvider
        .getVoices()
        .then(setTTSVoices)
        .catch(() => setTTSVoices([]));
    } else {
      setTTSVoices([]);
    }
  }, [ttsProvider]);

  // Fetch TTS models when provider changes
  useEffect(() => {
    if (ttsProvider?.getModels) {
      ttsProvider
        .getModels()
        .then(setTTSModels)
        .catch(() => setTTSModels([]));
    } else {
      setTTSModels([]);
    }
  }, [ttsProvider]);

  const updateSettings = useCallback((patch: Partial<VoiceSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const startListening = useCallback(() => {
    setIsListening(true);
  }, []);

  const stopListening = useCallback(() => {
    setIsListening(false);
  }, []);

  const transcribeAudio = useCallback(
    async (audio: Blob): Promise<string> => {
      if (!sttProvider) throw new Error("No STT provider configured");
      setIsTranscribing(true);
      try {
        // Browser STT can't transcribe blobs — this path is for Groq/API-based STT
        return await sttProvider.transcribe(audio);
      } finally {
        setIsTranscribing(false);
      }
    },
    [sttProvider],
  );

  const speak = useCallback(
    async (text: string) => {
      console.log(
        "[VoiceCall:TTS] speak() called — provider:",
        ttsProvider?.id,
        "enabled:",
        settings.ttsEnabled,
        "textLen:",
        text.length,
      );
      if (!ttsProvider || !settings.ttsEnabled) {
        console.log("[VoiceCall:TTS] speak() SKIPPED — no provider or TTS disabled");
        return;
      }

      const isBrowserTTS = ttsProvider.id === "browser-tts";

      // Cancel any in-progress playback before starting new speech
      playbackCancelRef.current?.();
      playbackCancelRef.current = null;
      speechCancelledRef.current = false;
      setIsSpeaking(true);
      console.log("[VoiceCall:TTS] setIsSpeaking(true)");

      try {
        // Strip markdown formatting for cleaner speech
        const clean = text
          .replace(/```[\s\S]*?```/g, "") // remove code blocks
          .replace(/`[^`]+`/g, "") // remove inline code
          .replace(/[#*_~>|[\]()-]/g, "") // remove markdown punctuation
          .replace(/\n{2,}/g, ". ") // paragraph breaks → pauses
          .replace(/\n/g, " ") // single newlines → spaces
          .trim();
        if (!clean) {
          console.log("[VoiceCall:TTS] speak() SKIPPED — cleaned text is empty");
          setIsSpeaking(false);
          return;
        }

        const maxLen = isBrowserTTS ? 5000 : 2000;
        const truncated = clean.length > maxLen ? clean.slice(0, maxLen) + "..." : clean;
        console.log(
          "[VoiceCall:TTS] speaking:",
          truncated.slice(0, 80) + (truncated.length > 80 ? "..." : ""),
        );

        if (ttsProvider instanceof BrowserTTSProvider) {
          await ttsProvider.speakDirect(truncated, { voice: settings.ttsVoice || undefined });
        } else {
          const buffer = await ttsProvider.synthesize(truncated, {
            voice: settings.ttsVoice || undefined,
            model: settings.ttsModel || undefined,
          });
          if (!speechCancelledRef.current && buffer.byteLength > 0) {
            const playback = playAudioBuffer(buffer);
            playbackCancelRef.current = playback.cancel;
            await playback.promise;
            playbackCancelRef.current = null;
          }
        }
        console.log("[VoiceCall:TTS] speak() completed successfully");
      } catch (err) {
        console.warn("[VoiceCall:TTS] Speech synthesis failed:", err);
      } finally {
        console.log("[VoiceCall:TTS] setIsSpeaking(false)");
        setIsSpeaking(false);
      }
    },
    [ttsProvider, settings.ttsEnabled, settings.ttsVoice, settings.ttsModel],
  );

  const cancelSpeech = useCallback(() => {
    speechCancelledRef.current = true;
    playbackCancelRef.current?.();
    playbackCancelRef.current = null;
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  }, []);

  return (
    <VoiceContext.Provider
      value={{
        settings,
        updateSettings,
        registry,
        sttProvider,
        ttsProvider,
        ttsVoices,
        ttsModels,
        isListening,
        isTranscribing,
        isSpeaking,
        startListening,
        stopListening,
        speak,
        cancelSpeech,
        transcribeAudio,
      }}
    >
      {children}
    </VoiceContext.Provider>
  );
}

export function useVoiceContext(): VoiceContextValue {
  const context = useContext(VoiceContext);
  if (!context) {
    throw new Error("useVoiceContext must be used within a VoiceProvider");
  }
  return context;
}
