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

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
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

export const VOICE_SETTINGS_STORAGE_KEY = "junban-voice-settings";

export function loadStoredVoiceSettings(): VoiceSettings {
  if (typeof window === "undefined") return DEFAULT_VOICE_SETTINGS;
  try {
    const stored = window.localStorage.getItem(VOICE_SETTINGS_STORAGE_KEY);
    if (stored) return { ...DEFAULT_VOICE_SETTINGS, ...JSON.parse(stored) };
  } catch {
    // ignore
  }
  return DEFAULT_VOICE_SETTINGS;
}

export function ensureVoiceModeEnabledForChatLaunch(): void {
  if (typeof window === "undefined") return;
  try {
    const settings = loadStoredVoiceSettings();
    if (settings.voiceMode !== "off") return;
    window.localStorage.setItem(
      VOICE_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...settings, voiceMode: "push-to-talk" satisfies VoiceMode }),
    );
  } catch {
    // ignore
  }
}
