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
  useMemo,
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
import { createLogger } from "../../utils/logger.js";
import { encryptValue, decryptValue, isEncryptedValue } from "../../utils/crypto.js";

const log = createLogger("voice");

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

/** Voice setting keys that contain sensitive data (API keys). */
const VOICE_SENSITIVE_KEYS: (keyof VoiceSettings)[] = ["groqApiKey", "inworldApiKey"];

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

/**
 * Decrypt sensitive voice settings after initial load.
 * Returns the settings with API keys decrypted (if they were encrypted).
 */
async function decryptSettings(settings: VoiceSettings): Promise<VoiceSettings> {
  const decrypted = { ...settings };
  for (const key of VOICE_SENSITIVE_KEYS) {
    const val = decrypted[key];
    if (typeof val === "string" && val && isEncryptedValue(val)) {
      (decrypted[key] as string) = await decryptValue(val);
    }
  }
  return decrypted;
}

/**
 * Save settings to localStorage, encrypting sensitive keys.
 */
async function saveSettings(settings: VoiceSettings): Promise<void> {
  try {
    const toStore = { ...settings };
    for (const key of VOICE_SENSITIVE_KEYS) {
      const val = toStore[key];
      if (typeof val === "string" && val && !isEncryptedValue(val)) {
        (toStore[key] as string) = await encryptValue(val);
      }
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
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

  // Decrypt sensitive settings on mount (async)
  useEffect(() => {
    decryptSettings(settings).then((decrypted) => {
      // Only update if something actually changed (was encrypted)
      if (
        decrypted.groqApiKey !== settings.groqApiKey ||
        decrypted.inworldApiKey !== settings.inworldApiKey
      ) {
        setSettings(decrypted);
      }
    });
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build registry whenever API keys change — useMemo avoids the double-create
  // that useState+useEffect caused (init on mount, then useEffect re-creates,
  // triggering a cascade of re-renders through ttsProvider/voices/models).
  const registry = useMemo(
    () =>
      createDefaultVoiceRegistry({
        groqApiKey: settings.groqApiKey || undefined,
        inworldApiKey: settings.inworldApiKey || undefined,
      }),
    [settings.groqApiKey, settings.inworldApiKey],
  );

  const sttProvider = registry.getSTT(settings.sttProviderId);
  const ttsProvider = registry.getTTS(settings.ttsProviderId);

  // Fetch TTS voices when provider changes
  useEffect(() => {
    if (ttsProvider?.getVoices) {
      ttsProvider
        .getVoices()
        .then(setTTSVoices)
        .catch((err: unknown) => {
          log.warn("Failed to fetch TTS voices", {
            error: err instanceof Error ? err.message : String(err),
          });
          setTTSVoices([]);
        });
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
        .catch((err: unknown) => {
          log.warn("Failed to fetch TTS models", {
            error: err instanceof Error ? err.message : String(err),
          });
          setTTSModels([]);
        });
    } else {
      setTTSModels([]);
    }
  }, [ttsProvider]);

  const updateSettings = useCallback((patch: Partial<VoiceSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      // Fire-and-forget async save (encrypts sensitive keys before storing)
      void saveSettings(next);
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
      log.debug("speak() called", {
        provider: ttsProvider?.id,
        enabled: settings.ttsEnabled,
        textLen: text.length,
      });
      if (!ttsProvider || !settings.ttsEnabled) {
        log.debug("speak() skipped — no provider or TTS disabled");
        return;
      }

      const isBrowserTTS = ttsProvider.id === "browser-tts";

      // Cancel any in-progress playback before starting new speech
      playbackCancelRef.current?.();
      playbackCancelRef.current = null;
      speechCancelledRef.current = false;
      setIsSpeaking(true);
      log.debug("setIsSpeaking(true)");

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
          log.debug("speak() skipped — cleaned text is empty");
          setIsSpeaking(false);
          return;
        }

        const maxLen = isBrowserTTS ? 5000 : 2000;
        const truncated = clean.length > maxLen ? clean.slice(0, maxLen) + "..." : clean;
        log.debug("speaking", { text: truncated.slice(0, 80) });

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
        log.debug("speak() completed");
      } catch (err) {
        log.warn("speech synthesis failed", { error: String(err) });
      } finally {
        log.debug("setIsSpeaking(false)");
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

  const value = useMemo(
    () => ({
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
    }),
    [
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
    ],
  );

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoiceContext(): VoiceContextValue {
  const context = useContext(VoiceContext);
  if (!context) {
    throw new Error("useVoiceContext must be used within a VoiceProvider");
  }
  return context;
}
