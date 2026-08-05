/**
 * Phase 6 Voice Settings visual fixture — legacy presentation shape.
 * No microphone, network, model, or credential side effects.
 */

import { useState } from "react";
import { Mic } from "lucide-react";
import type { VoiceSettingsVisualState } from "../../views/settings/voice/voiceFixture";
import { fixtureVoiceConfig } from "../../views/settings/voice/voiceFixture";

const STT_OPTIONS = [
  { id: "browser", label: "Browser Speech Recognition" },
  { id: "groq", label: "Groq Whisper" },
  { id: "openai", label: "OpenAI Whisper" },
] as const;

const TTS_OPTIONS = [
  { id: "browser", label: "Browser Speech Synthesis" },
  { id: "groq", label: "Groq PlayAI" },
  { id: "inworld", label: "Inworld" },
] as const;

/** Synthetic masked presence only — never a real secret. */
const MASKED_KEY = "";

export function Phase6SettingsVoiceScene({ state }: { state: VoiceSettingsVisualState }) {
  void fixtureVoiceConfig(state);
  const isCloud = state === "cloud";
  const [stt, setStt] = useState(isCloud ? "groq" : "browser");
  const [tts, setTts] = useState(isCloud ? "groq" : "browser");
  const [ttsEnabled, setTtsEnabled] = useState(isCloud);
  const [mode, setMode] = useState<"off" | "push-to-talk" | "vad">(
    isCloud ? "vad" : "push-to-talk",
  );
  const [autoSend, setAutoSend] = useState(true);
  const [smartEndpoint, setSmartEndpoint] = useState(false);
  const sttNeedsKey = stt !== "browser";
  const ttsNeedsKey = tts !== "browser";
  // Dark cloud capture froze quieter field chrome than default border tokens.
  const fieldClass = isCloud
    ? "w-full px-3 py-1.5 text-sm border border-transparent rounded-lg bg-surface text-on-surface h-9"
    : "w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface";

  return (
    <section className="mb-8" style={isCloud ? { fontSize: "11px" } : undefined}>
      <h2 className="text-lg font-semibold mb-1 text-on-surface">Voice</h2>
      <p className="text-xs text-on-surface-muted mb-3">
        Configure speech-to-text, text-to-speech, microphone, and voice interaction mode.
      </p>

      {/* Cloud capture is denser; browser-defaults capture matches space-y-8. */}
      <div className={`${isCloud ? "flex flex-col gap-[15px]" : "space-y-8"} max-w-lg`}>
        <div>
          <h3 className="text-sm font-semibold text-on-surface mb-1">Microphone</h3>
          <p className="text-xs text-on-surface-muted mb-2">
            Grant microphone access to enable voice input.
          </p>
          <button
            type="button"
            className="inline-flex items-center gap-2 text-sm text-on-surface-muted hover:text-on-surface"
          >
            <Mic size={14} aria-hidden="true" />
            Allow microphone access
          </button>
        </div>

        <fieldset className={isCloud ? "space-y-4" : "space-y-2"}>
          <legend className="text-sm font-semibold text-on-surface mb-1">Speech-to-Text</legend>
          <div>
            <label
              htmlFor="voice-stt-provider"
              className="block text-xs font-medium text-on-surface-secondary mb-1"
            >
              STT Provider
            </label>
            <select
              id="voice-stt-provider"
              value={stt}
              onChange={(e) => setStt(e.target.value)}
              className={fieldClass}
            >
              {STT_OPTIONS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          {sttNeedsKey && (
            <div>
              <label
                htmlFor="voice-stt-key"
                className="block text-xs font-medium text-on-surface-secondary mb-1"
              >
                API Key
                {/* Capture froze "Set" without a strong success tint on dark. */}
                <span className="font-normal text-on-surface-secondary">Set</span>
              </label>
              <input
                id="voice-stt-key"
                type="password"
                value={MASKED_KEY}
                readOnly
                className={fieldClass}
              />
              <p className="mt-1 text-xs text-on-surface-muted">
                Enables Groq Whisper (STT) and PlayAI (TTS). Free tier available at groq.com.
              </p>
            </div>
          )}
        </fieldset>

        <fieldset className={isCloud ? "space-y-4" : "space-y-2"}>
          <legend className="text-sm font-semibold text-on-surface mb-1">Text-to-Speech</legend>
          <div>
            <label
              htmlFor="voice-tts-provider"
              className="block text-xs font-medium text-on-surface-secondary mb-1"
            >
              TTS Provider
            </label>
            <select
              id="voice-tts-provider"
              value={tts}
              onChange={(e) => setTts(e.target.value)}
              className={fieldClass}
            >
              {TTS_OPTIONS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          {ttsNeedsKey && (
            <div>
              <label
                htmlFor="voice-tts-key"
                className="block text-xs font-medium text-on-surface-secondary mb-1"
              >
                API Key
              </label>
              <input
                id="voice-tts-key"
                type="password"
                value={MASKED_KEY}
                readOnly
                className={fieldClass}
              />
              <p className="mt-1 text-xs text-on-surface-muted">
                Enables Groq Whisper (STT) and PlayAI (TTS). Free tier available at groq.com.
              </p>
            </div>
          )}
          {isCloud && (
            <div>
              <label
                htmlFor="voice-tts-voice"
                className="block text-xs font-medium text-on-surface-secondary mb-1"
              >
                Voice
              </label>
              {/* Capture froze voice without a Preview control. */}
              <select id="voice-tts-voice" defaultValue="alloy" className={fieldClass}>
                <option value="alloy">Alloy</option>
                <option value="verse">Verse</option>
              </select>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={ttsEnabled}
              onChange={(e) => setTtsEnabled(e.target.checked)}
            />
            Read AI responses aloud
          </label>
        </fieldset>

        <fieldset className={isCloud ? "space-y-4" : "space-y-2"}>
          <legend className="text-sm font-semibold text-on-surface mb-1">Interaction Mode</legend>
          <div className={isCloud ? "flex flex-wrap gap-x-0 gap-y-0" : "flex gap-2"}>
            {(
              [
                { id: "off", label: "Off" },
                { id: "push-to-talk", label: "Push-to-Talk" },
                { id: "vad", label: "VAD (Hands-free)" },
              ] as const
            ).map((option) => (
              <label key={option.id} className="flex items-center gap-0 text-sm text-on-surface">
                <input
                  type="radio"
                  name="voiceMode"
                  value={option.id}
                  checked={mode === option.id}
                  onChange={() => setMode(option.id)}
                />
                {option.label}
              </label>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={autoSend}
              onChange={(e) => setAutoSend(e.target.checked)}
            />
            Auto-send transcribed text to AI
          </label>

          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={smartEndpoint}
              onChange={(e) => setSmartEndpoint(e.target.checked)}
            />
            Smart endpoint detection
          </label>
        </fieldset>
      </div>
    </section>
  );
}
