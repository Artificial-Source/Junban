import type { VoiceSettings } from "../../../../ui/context/VoiceContext.js";

/** Maps a voice provider ID to the settings key holding its API key. */
export const PROVIDER_KEY_MAP: Record<
  string,
  { settingsKey: keyof VoiceSettings; placeholder: string; helpText: string }
> = {
  "groq-stt": {
    settingsKey: "groqApiKey",
    placeholder: "Enter Groq API key",
    helpText: "Enables Groq Whisper (STT) and PlayAI (TTS). Free tier available at groq.com.",
  },
  "groq-tts": {
    settingsKey: "groqApiKey",
    placeholder: "Enter Groq API key",
    helpText: "Enables Groq Whisper (STT) and PlayAI (TTS). Free tier available at groq.com.",
  },
  "inworld-tts": {
    settingsKey: "inworldApiKey",
    placeholder: "Enter Inworld API credential",
    helpText: "High-quality TTS with voice cloning. Get credentials at platform.inworld.ai.",
  },
};

export function ProviderApiKeyInput({
  providerId,
  settings,
  updateSettings,
}: {
  providerId: string;
  settings: VoiceSettings;
  updateSettings: (patch: Partial<VoiceSettings>) => void;
}) {
  const info = PROVIDER_KEY_MAP[providerId];
  if (!info) return null;

  const currentValue = settings[info.settingsKey] as string;

  return (
    <div>
      <label className="block text-xs font-medium text-on-surface-secondary mb-1">
        API Key
        {currentValue && <span className="font-normal text-success ml-2">Set</span>}
      </label>
      <input
        type="password"
        value={currentValue}
        onChange={(e) => updateSettings({ [info.settingsKey]: e.target.value })}
        placeholder={info.placeholder}
        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
      />
      <p className="mt-1 text-xs text-on-surface-muted">{info.helpText}</p>
    </div>
  );
}
