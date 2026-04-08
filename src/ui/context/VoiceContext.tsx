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
import type {
  STTProviderPlugin,
  TTSProviderPlugin,
  TTSModel,
  Voice,
} from "../../ai/voice/interface.js";
import { createLogger } from "../../utils/logger.js";
import { ENCRYPTED_VALUE_PREFIX } from "../../utils/crypto-constants.js";
import {
  loadStoredVoiceSettings,
  VOICE_SETTINGS_STORAGE_KEY,
  type VoiceSettings,
} from "./voice-settings.js";

const log = createLogger("voice");

function cloneRegistry(source: VoiceProviderRegistry): VoiceProviderRegistry {
  const next = new VoiceProviderRegistry();
  for (const provider of source.listSTT()) {
    next.registerSTT(provider);
  }
  for (const provider of source.listTTS()) {
    next.registerTTS(provider);
  }
  return next;
}

export type { VoiceMode, VoiceSettings } from "./voice-settings.js";

/** Voice setting keys that contain sensitive data (API keys). */
const VOICE_SENSITIVE_KEYS: (keyof VoiceSettings)[] = ["groqApiKey", "inworldApiKey"];

function loadSettings(): VoiceSettings {
  return loadStoredVoiceSettings();
}

/**
 * Decrypt sensitive voice settings after initial load.
 * Returns the settings with API keys decrypted (if they were encrypted).
 */
async function decryptSettings(settings: VoiceSettings): Promise<VoiceSettings> {
  const decrypted = { ...settings };
  const { decryptValue } = await import("../../utils/crypto.js");
  for (const key of VOICE_SENSITIVE_KEYS) {
    const val = decrypted[key];
    if (typeof val === "string" && val && val.startsWith(ENCRYPTED_VALUE_PREFIX)) {
      const nextValue = await decryptValue(val);
      (decrypted[key] as string) = nextValue.startsWith(ENCRYPTED_VALUE_PREFIX) ? "" : nextValue;
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
    const { encryptValue } = await import("../../utils/crypto.js");
    for (const key of VOICE_SENSITIVE_KEYS) {
      const val = toStore[key];
      if (typeof val === "string" && val && !val.startsWith(ENCRYPTED_VALUE_PREFIX)) {
        (toStore[key] as string) = await encryptValue(val);
      }
    }
    window.localStorage.setItem(VOICE_SETTINGS_STORAGE_KEY, JSON.stringify(toStore));
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
  ensureRegistryLoaded: () => Promise<void>;
  localProvidersLoaded: boolean;
  ensureLocalProvidersLoaded: () => Promise<void>;
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
  const [registry, setRegistry] = useState(() => new VoiceProviderRegistry());
  const [localProvidersLoaded, setLocalProvidersLoaded] = useState(false);
  const speechCancelledRef = useRef(false);
  const playbackCancelRef = useRef<(() => void) | null>(null);
  const registryRef = useRef<VoiceProviderRegistry>(registry);
  const providerModuleRef = useRef<null | typeof import("../../ai/voice/provider.js")>(null);
  const registryLoadRef = useRef<Promise<void> | null>(null);
  const registrySignatureRef = useRef<string | null>(null);
  const localProviderLoadRef = useRef<Promise<void> | null>(null);

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

  useEffect(() => {
    registryRef.current = registry;
  }, [registry]);

  const registrySignature = `${settings.groqApiKey ?? ""}::${settings.inworldApiKey ?? ""}`;

  const ensureRegistryLoaded = useCallback(async () => {
    let attempts = 0;
    while (
      registrySignatureRef.current !== registrySignature ||
      registryRef.current.listSTT().length === 0
    ) {
      attempts += 1;
      if (attempts > 3) {
        throw new Error("Failed to initialize voice provider registry");
      }

      if (!registryLoadRef.current) {
        registryLoadRef.current = import("../../ai/voice/provider.js")
          .then((module) => {
            providerModuleRef.current = module;
            const nextRegistry = module.createDefaultVoiceRegistry({
              groqApiKey: settings.groqApiKey || undefined,
              inworldApiKey: settings.inworldApiKey || undefined,
            });
            registrySignatureRef.current = registrySignature;
            registryRef.current = nextRegistry;
            setRegistry(nextRegistry);
            setLocalProvidersLoaded(module.hasLocalVoiceProviders(nextRegistry));
            localProviderLoadRef.current = null;
          })
          .finally(() => {
            registryLoadRef.current = null;
          });
      }

      await registryLoadRef.current;
    }
  }, [registrySignature, settings.groqApiKey, settings.inworldApiKey]);

  useEffect(() => {
    const shouldWarmRegistry =
      settings.ttsEnabled ||
      Boolean(settings.groqApiKey) ||
      Boolean(settings.inworldApiKey) ||
      settings.sttProviderId !== "browser-stt" ||
      settings.ttsProviderId !== "browser-tts";

    if (shouldWarmRegistry) {
      void ensureRegistryLoaded();
    }
  }, [
    ensureRegistryLoaded,
    settings.groqApiKey,
    settings.inworldApiKey,
    settings.sttProviderId,
    settings.ttsEnabled,
    settings.ttsProviderId,
  ]);

  const ensureLocalProvidersLoaded = useCallback(async () => {
    await ensureRegistryLoaded();
    const activeRegistry = registryRef.current;
    const providerModule = providerModuleRef.current;
    if (!providerModule) return;
    if (providerModule.hasLocalVoiceProviders(activeRegistry)) {
      setLocalProvidersLoaded(true);
      return;
    }
    if (!localProviderLoadRef.current) {
      localProviderLoadRef.current = providerModule
        .registerLocalVoiceProviders(activeRegistry)
        .then(() => {
          setLocalProvidersLoaded(true);
          setRegistry(cloneRegistry(activeRegistry));
        })
        .finally(() => {
          localProviderLoadRef.current = null;
        });
    }
    await localProviderLoadRef.current;
  }, [ensureRegistryLoaded]);

  useEffect(() => {
    const shouldLoadLocalProviders =
      settings.voiceMode === "vad" ||
      settings.sttProviderId === "whisper-local-stt" ||
      settings.ttsProviderId === "piper-local-tts" ||
      settings.ttsProviderId === "kokoro-local-tts";

    if (shouldLoadLocalProviders) {
      void ensureLocalProvidersLoaded();
    }
  }, [
    ensureLocalProvidersLoaded,
    settings.sttProviderId,
    settings.ttsProviderId,
    settings.voiceMode,
  ]);

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
      let activeProvider = sttProvider;
      if (!activeProvider) {
        await ensureRegistryLoaded();
        activeProvider = registryRef.current.getSTT(settings.sttProviderId);
      }
      if (!activeProvider) throw new Error("No STT provider configured");
      setIsTranscribing(true);
      try {
        // Browser STT can't transcribe blobs — this path is for Groq/API-based STT
        return await activeProvider.transcribe(audio);
      } finally {
        setIsTranscribing(false);
      }
    },
    [ensureRegistryLoaded, settings.sttProviderId, sttProvider],
  );

  const speak = useCallback(
    async (text: string) => {
      let activeProvider = ttsProvider;
      if (!activeProvider && settings.ttsEnabled) {
        await ensureRegistryLoaded();
        activeProvider = registryRef.current.getTTS(settings.ttsProviderId);
      }

      log.debug("speak() called", {
        provider: activeProvider?.id,
        enabled: settings.ttsEnabled,
        textLen: text.length,
      });
      if (!activeProvider || !settings.ttsEnabled) {
        log.debug("speak() skipped — no provider or TTS disabled");
        return;
      }

      const isBrowserTTS = activeProvider.id === "browser-tts";

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

        if (
          isBrowserTTS &&
          "speakDirect" in activeProvider &&
          typeof activeProvider.speakDirect === "function"
        ) {
          await activeProvider.speakDirect(truncated, { voice: settings.ttsVoice || undefined });
        } else {
          const buffer = await activeProvider.synthesize(truncated, {
            voice: settings.ttsVoice || undefined,
            model: settings.ttsModel || undefined,
          });
          if (!speechCancelledRef.current && buffer.byteLength > 0) {
            const { playAudioBuffer } = await import("../../ai/voice/audio-utils.js");
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
    [
      ensureRegistryLoaded,
      settings.ttsEnabled,
      settings.ttsModel,
      settings.ttsProviderId,
      settings.ttsVoice,
      ttsProvider,
    ],
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
      ensureRegistryLoaded,
      localProvidersLoaded,
      ensureLocalProvidersLoaded,
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
      ensureRegistryLoaded,
      localProvidersLoaded,
      ensureLocalProvidersLoaded,
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
