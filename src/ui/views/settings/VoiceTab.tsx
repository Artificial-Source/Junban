import { useEffect } from "react";
import { Play } from "lucide-react";
import { useVoiceContext, type VoiceMode } from "../../context/VoiceContext.js";
import { VoiceFeatureProvider } from "../../context/VoiceFeatureProvider.js";
import { MicrophoneSection } from "./voice/MicrophoneSection.js";
import { ProviderApiKeyInput } from "./voice/ProviderApiKeyInput.js";
import { LocalModelsSection } from "./voice/LocalModelsSection.js";

export function VoiceTab() {
  return (
    <VoiceFeatureProvider>
      <VoiceTabContent />
    </VoiceFeatureProvider>
  );
}

function VoiceTabContent() {
  const voice = useVoiceContext();
  const {
    settings,
    updateSettings,
    registry,
    ttsVoices,
    ttsModels,
    localProvidersLoaded,
    ensureLocalProvidersLoaded,
  } = voice;

  useEffect(() => {
    void ensureLocalProvidersLoaded();
  }, [ensureLocalProvidersLoaded]);

  const sttProviders = registry.listSTT();
  const ttsProviders = registry.listTTS();

  const selectedSTT = sttProviders.find((p) => p.id === settings.sttProviderId);
  const selectedTTS = ttsProviders.find((p) => p.id === settings.ttsProviderId);

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-1 text-on-surface">Voice</h2>
      <p className="text-xs text-on-surface-muted mb-5">
        Configure speech-to-text, text-to-speech, microphone, and voice interaction mode.
      </p>

      <div className="space-y-8 max-w-lg">
        {/* ── Microphone ── */}
        <MicrophoneSection selectedId={settings.microphoneId} onSelect={updateSettings} />

        {/* ── Speech-to-Text ── */}
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-on-surface mb-2">Speech-to-Text</legend>

          <div>
            <label className="block text-xs font-medium text-on-surface-secondary mb-1">
              STT Provider
            </label>
            <select
              value={settings.sttProviderId}
              onChange={(e) => updateSettings({ sttProviderId: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
            >
              {sttProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {!localProvidersLoaded && (
              <p className="mt-1 text-xs text-on-surface-muted">Loading local voice providers...</p>
            )}
          </div>

          {selectedSTT?.needsApiKey && (
            <ProviderApiKeyInput
              providerId={selectedSTT.id}
              settings={settings}
              updateSettings={updateSettings}
            />
          )}
        </fieldset>

        {/* ── Text-to-Speech ── */}
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-on-surface mb-2">Text-to-Speech</legend>

          <div>
            <label className="block text-xs font-medium text-on-surface-secondary mb-1">
              TTS Provider
            </label>
            <select
              value={settings.ttsProviderId}
              onChange={(e) => updateSettings({ ttsProviderId: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
            >
              {ttsProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {selectedTTS?.needsApiKey && (
            <ProviderApiKeyInput
              providerId={selectedTTS.id}
              settings={settings}
              updateSettings={updateSettings}
            />
          )}

          {ttsModels.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                Model
              </label>
              <select
                value={settings.ttsModel}
                onChange={(e) => updateSettings({ ttsModel: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
              >
                {ttsModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {ttsVoices.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                Voice
              </label>
              <div className="flex items-center gap-2">
                <select
                  value={settings.ttsVoice}
                  onChange={(e) => updateSettings({ ttsVoice: e.target.value })}
                  className="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
                >
                  <option value="">Default</option>
                  {ttsVoices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => voice.speak("Hello, this is a voice preview.")}
                  disabled={!settings.ttsEnabled || voice.isSpeaking}
                  title="Preview voice"
                  className="shrink-0 flex items-center gap-1 px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface hover:bg-surface-secondary transition-colors disabled:opacity-50"
                >
                  <Play size={14} />
                  Preview
                </button>
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={settings.ttsEnabled}
              onChange={(e) => updateSettings({ ttsEnabled: e.target.checked })}
              className="accent-accent"
            />
            Read AI responses aloud
          </label>
        </fieldset>

        {/* ── Voice Mode ── */}
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-on-surface mb-2">Interaction Mode</legend>

          <div>
            <div className="flex gap-4">
              {(["off", "push-to-talk", "vad"] as VoiceMode[]).map((mode) => (
                <label key={mode} className="flex items-center gap-1.5 text-sm text-on-surface">
                  <input
                    type="radio"
                    name="voiceMode"
                    value={mode}
                    checked={settings.voiceMode === mode}
                    onChange={() => updateSettings({ voiceMode: mode })}
                    className="accent-accent"
                  />
                  {mode === "off"
                    ? "Off"
                    : mode === "push-to-talk"
                      ? "Push-to-Talk"
                      : "VAD (Hands-free)"}
                </label>
              ))}
            </div>
            {settings.voiceMode === "vad" && (
              <p className="mt-2 text-xs text-on-surface-muted">
                Voice Activity Detection automatically detects when you start and stop speaking.
                Requires an audio-based STT provider (Whisper Local or Groq) since VAD produces raw
                audio.
              </p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={settings.autoSend}
              onChange={(e) => updateSettings({ autoSend: e.target.checked })}
              className="accent-accent"
            />
            Auto-send transcribed text to AI
          </label>

          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={settings.smartEndpoint}
              onChange={(e) => updateSettings({ smartEndpoint: e.target.checked })}
              className="accent-accent"
            />
            Smart endpoint detection
          </label>
          {settings.smartEndpoint && (
            <div>
              <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                Grace period: {(settings.gracePeriodMs / 1000).toFixed(1)}s
              </label>
              <input
                type="range"
                min={500}
                max={3000}
                step={100}
                value={settings.gracePeriodMs}
                onChange={(e) => updateSettings({ gracePeriodMs: Number(e.target.value) })}
                className="w-full accent-accent"
              />
              <div className="flex justify-between text-[10px] text-on-surface-muted">
                <span>0.5s</span>
                <span>3.0s</span>
              </div>
              <p className="mt-1 text-xs text-on-surface-muted">
                Waits for you to resume speaking before submitting audio. Helps with natural pauses.
              </p>
            </div>
          )}
        </fieldset>

        {/* ── Local Models ── */}
        <LocalModelsSection registry={registry} />
      </div>
    </section>
  );
}
