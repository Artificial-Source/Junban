/**
 * Settings → Voice tab (legacy presentation preserved).
 * Lazy-loaded only when the Voice settings route is selected.
 */

import { useMemo, useState } from "react";
import type { SpeechProviderPresetDto } from "../../../ai/types";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { SettingsStatusBanner } from "../settingsComponents";
import { primaryButtonClass } from "../settingsHelpers";
import { CredentialControl } from "../ai/CredentialControl";
import { useAiConfigController } from "../ai/useAiConfigController";
import {
  BROWSER_SPEECH_WARNING,
  CLOUD_SPEECH_HELP,
  GRACE_PERIOD_MS_MAX,
  GRACE_PERIOD_MS_MIN,
  speechProviderHelp,
  speechSecretKind,
  speechSecretKindOptions,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  VOICE_MODE_OPTIONS,
} from "./constants";
import { LocalModelsSection } from "./LocalModelCard";
import { MicrophoneSelector } from "./MicrophoneSelector";
import { useLocalModelController } from "./useLocalModelController";

function isCloudProvider(id: SpeechProviderPresetDto): boolean {
  return id !== "browser";
}

export function VoiceTab() {
  const controller = useAiConfigController();
  const localModels = useLocalModelController();
  const {
    loading,
    saving,
    error,
    statusMessage,
    confirmed,
    voiceDraft,
    dirty,
    setVoiceDraft,
    clearError,
    save,
    submitCredential,
    removeCredential,
    credentialBusy,
  } = controller;

  const [confirmSttSwitch, setConfirmSttSwitch] = useState(false);
  const [confirmTtsSwitch, setConfirmTtsSwitch] = useState(false);
  const [pendingStt, setPendingStt] = useState<SpeechProviderPresetDto | null>(null);
  const [pendingTts, setPendingTts] = useState<SpeechProviderPresetDto | null>(null);

  const sttNeedsCredential = voiceDraft ? isCloudProvider(voiceDraft.stt_provider) : false;
  const ttsNeedsCredential = voiceDraft ? isCloudProvider(voiceDraft.tts_provider) : false;

  const sttPresent = Boolean(confirmed?.credentials.voice_stt?.present);
  const ttsPresent = Boolean(confirmed?.credentials.voice_tts?.present);

  const filteredStt = useMemo(() => STT_PROVIDERS, []);
  const filteredTts = useMemo(() => TTS_PROVIDERS, []);

  if (loading || !voiceDraft || !confirmed) {
    return (
      <div
        role="status"
        className="flex min-h-[240px] items-center justify-center text-sm text-on-surface-muted"
      >
        Loading voice settings…
      </div>
    );
  }

  const handleSttChange = (value: SpeechProviderPresetDto) => {
    if (
      value !== confirmed.voice.stt_provider &&
      confirmed.credentials.voice_stt?.present &&
      confirmed.voice.stt_provider !== "browser"
    ) {
      setPendingStt(value);
      setConfirmSttSwitch(true);
      return;
    }
    setVoiceDraft({
      stt_provider: value,
      cloud_speech_enabled:
        isCloudProvider(value) || isCloudProvider(voiceDraft.tts_provider)
          ? voiceDraft.cloud_speech_enabled || isCloudProvider(value)
          : false,
    });
  };

  const handleTtsChange = (value: SpeechProviderPresetDto) => {
    if (
      value !== confirmed.voice.tts_provider &&
      confirmed.credentials.voice_tts?.present &&
      confirmed.voice.tts_provider !== "browser"
    ) {
      setPendingTts(value);
      setConfirmTtsSwitch(true);
      return;
    }
    setVoiceDraft({
      tts_provider: value,
      cloud_speech_enabled:
        isCloudProvider(value) || isCloudProvider(voiceDraft.stt_provider)
          ? voiceDraft.cloud_speech_enabled || isCloudProvider(value)
          : false,
    });
  };

  const confirmSttProviderSwitch = async () => {
    setConfirmSttSwitch(false);
    if (!pendingStt) return;
    const ok = await removeCredential("voice_stt");
    if (!ok) return;
    setVoiceDraft({
      stt_provider: pendingStt,
      cloud_speech_enabled: isCloudProvider(pendingStt) || isCloudProvider(voiceDraft.tts_provider),
    });
    setPendingStt(null);
  };

  const confirmTtsProviderSwitch = async () => {
    setConfirmTtsSwitch(false);
    if (!pendingTts) return;
    const ok = await removeCredential("voice_tts");
    if (!ok) return;
    setVoiceDraft({
      tts_provider: pendingTts,
      cloud_speech_enabled: isCloudProvider(pendingTts) || isCloudProvider(voiceDraft.stt_provider),
    });
    setPendingTts(null);
  };

  return (
    <section className="mb-8" data-testid="voice-settings-tab">
      <h2 className="mb-1 text-lg font-semibold text-on-surface">Voice</h2>
      <p className="mb-5 text-xs text-on-surface-muted">
        Configure speech-to-text, text-to-speech, microphone, and voice interaction mode.
      </p>

      {(error || statusMessage) && (
        <div className="mb-4 max-w-lg space-y-2">
          {error && (
            <SettingsStatusBanner kind="error">
              <div className="flex items-start justify-between gap-3">
                <span>{error}</span>
                <button type="button" className="text-xs underline" onClick={clearError}>
                  Dismiss
                </button>
              </div>
            </SettingsStatusBanner>
          )}
          {statusMessage && !error && (
            <SettingsStatusBanner kind="success">{statusMessage}</SettingsStatusBanner>
          )}
        </div>
      )}

      <div className="max-w-lg space-y-8">
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
          <p className="text-xs text-on-surface-muted">{BROWSER_SPEECH_WARNING}</p>
        </div>

        <MicrophoneSelector />

        <fieldset className="space-y-4">
          <legend className="mb-2 text-sm font-semibold text-on-surface">Speech-to-Text</legend>

          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={voiceDraft.cloud_speech_enabled}
              onChange={(event) => setVoiceDraft({ cloud_speech_enabled: event.target.checked })}
              className="accent-accent-action"
            />
            Enable cloud speech
          </label>
          <p className="text-xs text-on-surface-muted">{CLOUD_SPEECH_HELP}</p>

          <div>
            <label
              htmlFor="voice-stt-provider"
              className="mb-1 block text-xs font-medium text-on-surface-secondary"
            >
              STT Provider
            </label>
            <select
              id="voice-stt-provider"
              value={voiceDraft.stt_provider}
              onChange={(event) => handleSttChange(event.target.value as SpeechProviderPresetDto)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
            >
              {filteredStt.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
            {/* Guard: Inworld must never appear for STT. */}
            {!filteredStt.some((p) => p.id === "inworld") && null}
          </div>

          {sttNeedsCredential && (
            <CredentialControl
              target="voice_stt"
              label="STT API Key"
              helpText={speechProviderHelp(voiceDraft.stt_provider)}
              present={sttPresent}
              metadata={confirmed.credentials.voice_stt}
              defaultKind={speechSecretKind(voiceDraft.stt_provider)}
              kindOptions={speechSecretKindOptions(voiceDraft.stt_provider)}
              busy={credentialBusy === "voice_stt"}
              disabled={saving}
              onSubmit={(body) => submitCredential("voice_stt", body)}
              onDelete={() => removeCredential("voice_stt")}
            />
          )}

          {sttNeedsCredential && (
            <div>
              <label
                htmlFor="voice-stt-model"
                className="mb-1 block text-xs font-medium text-on-surface-secondary"
              >
                STT model
              </label>
              <input
                id="voice-stt-model"
                type="text"
                value={voiceDraft.stt_model ?? ""}
                onChange={(event) => setVoiceDraft({ stt_model: event.target.value || null })}
                placeholder="Optional model id"
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
              />
              <p className="mt-1 text-xs text-on-surface-muted">
                Model discovery for speech is not available yet — enter a provider model id if
                needed.
              </p>
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="mb-2 text-sm font-semibold text-on-surface">Text-to-Speech</legend>

          <div>
            <label
              htmlFor="voice-tts-provider"
              className="mb-1 block text-xs font-medium text-on-surface-secondary"
            >
              TTS Provider
            </label>
            <select
              id="voice-tts-provider"
              value={voiceDraft.tts_provider}
              onChange={(event) => handleTtsChange(event.target.value as SpeechProviderPresetDto)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
            >
              {filteredTts.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </div>

          {ttsNeedsCredential && (
            <CredentialControl
              target="voice_tts"
              label="TTS API Key"
              helpText={speechProviderHelp(voiceDraft.tts_provider)}
              present={ttsPresent}
              metadata={confirmed.credentials.voice_tts}
              defaultKind={speechSecretKind(voiceDraft.tts_provider)}
              kindOptions={speechSecretKindOptions(voiceDraft.tts_provider)}
              busy={credentialBusy === "voice_tts"}
              disabled={saving}
              onSubmit={(body) => submitCredential("voice_tts", body)}
              onDelete={() => removeCredential("voice_tts")}
            />
          )}

          <div>
            <label
              htmlFor="voice-tts-model"
              className="mb-1 block text-xs font-medium text-on-surface-secondary"
            >
              Model
            </label>
            <input
              id="voice-tts-model"
              type="text"
              value={voiceDraft.tts_model ?? ""}
              onChange={(event) => setVoiceDraft({ tts_model: event.target.value || null })}
              placeholder="Optional model id"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
            />
          </div>

          <div>
            <label
              htmlFor="voice-tts-voice"
              className="mb-1 block text-xs font-medium text-on-surface-secondary"
            >
              Voice
            </label>
            <input
              id="voice-tts-voice"
              type="text"
              value={voiceDraft.tts_voice ?? ""}
              onChange={(event) => setVoiceDraft({ tts_voice: event.target.value || null })}
              placeholder="Optional voice id"
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
            />
            <p className="mt-1 text-xs text-on-surface-muted">
              Voice lists are not discovered in this wave — enter a provider voice id if needed.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={voiceDraft.tts_enabled}
              onChange={(event) => setVoiceDraft({ tts_enabled: event.target.checked })}
              className="accent-accent-action"
            />
            Read AI responses aloud
          </label>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="mb-2 text-sm font-semibold text-on-surface">Interaction Mode</legend>
          <div className="flex flex-wrap gap-4">
            {VOICE_MODE_OPTIONS.map((mode) => (
              <label key={mode.id} className="flex items-center gap-1.5 text-sm text-on-surface">
                <input
                  type="radio"
                  name="voiceMode"
                  value={mode.id}
                  checked={voiceDraft.voice_mode === mode.id}
                  onChange={() => setVoiceDraft({ voice_mode: mode.id })}
                  className="accent-accent-action"
                />
                {mode.label}
              </label>
            ))}
          </div>
          {voiceDraft.voice_mode === "hands_free" && (
            <p className="text-xs text-on-surface-muted">
              Voice Activity Detection automatically detects when you start and stop speaking.
            </p>
          )}

          <div>
            <label
              htmlFor="voice-grace-period"
              className="mb-1 block text-xs font-medium text-on-surface-secondary"
            >
              Grace period: {(voiceDraft.grace_period_ms / 1000).toFixed(1)}s
            </label>
            <input
              id="voice-grace-period"
              type="range"
              min={GRACE_PERIOD_MS_MIN}
              max={GRACE_PERIOD_MS_MAX}
              step={100}
              value={voiceDraft.grace_period_ms}
              onChange={(event) => setVoiceDraft({ grace_period_ms: Number(event.target.value) })}
              className="w-full accent-accent-action"
            />
            <div className="flex justify-between text-[10px] text-on-surface-muted">
              <span>{(GRACE_PERIOD_MS_MIN / 1000).toFixed(1)}s</span>
              <span>{(GRACE_PERIOD_MS_MAX / 1000).toFixed(1)}s</span>
            </div>
            <p className="mt-1 text-xs text-on-surface-muted">
              Waits for you to resume speaking before submitting audio. Helps with natural pauses.
            </p>
          </div>
        </fieldset>

        <LocalModelsSection controller={localModels} />

        <button
          type="button"
          disabled={saving || !dirty}
          onClick={() => void save()}
          className={primaryButtonClass(saving || !dirty)}
        >
          {saving ? "Saving…" : "Save voice settings"}
        </button>
      </div>

      <ConfirmDialog
        open={confirmSttSwitch}
        title="Change STT credential?"
        message="The current speech-to-text provider has a stored credential. Changing providers will remove that binding."
        confirmLabel="Remove credential"
        pending={credentialBusy === "voice_stt"}
        onConfirm={() => void confirmSttProviderSwitch()}
        onCancel={() => {
          setConfirmSttSwitch(false);
          setPendingStt(null);
        }}
      />
      <ConfirmDialog
        open={confirmTtsSwitch}
        title="Change TTS credential?"
        message="The current text-to-speech provider has a stored credential. Changing providers will remove that binding."
        confirmLabel="Remove credential"
        pending={credentialBusy === "voice_tts"}
        onConfirm={() => void confirmTtsProviderSwitch()}
        onCancel={() => {
          setConfirmTtsSwitch(false);
          setPendingTts(null);
        }}
      />
    </section>
  );
}

export default VoiceTab;
