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

export function Phase6SettingsVoiceScene({ state }: { state: VoiceSettingsVisualState }) {
  void fixtureVoiceConfig(state); // keep fixture path exercised for type parity
  const isCloud = state === "cloud";
  const [stt, setStt] = useState(isCloud ? "groq" : "browser");
  const [tts, setTts] = useState(isCloud ? "groq" : "browser");
  // Legacy capture: browser defaults leave TTS read-aloud off; cloud enables it.
  const [ttsEnabled, setTtsEnabled] = useState(isCloud);
  const [mode, setMode] = useState<"off" | "push-to-talk" | "vad">(
    isCloud ? "vad" : "push-to-talk",
  );
  const [autoSend, setAutoSend] = useState(true);
  const [smartEndpoint, setSmartEndpoint] = useState(false);
  const sttNeedsKey = stt !== "browser";
  const ttsNeedsKey = tts !== "browser";

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-1 text-on-surface">Voice</h2>
      <p className="text-xs text-on-surface-muted mb-5">
        Configure speech-to-text, text-to-speech, microphone, and voice interaction mode.
      </p>

      <div className="space-y-6 max-w-lg">
        <div>
          <h3 className="text-sm font-semibold text-on-surface mb-1">Microphone</h3>
          <p className="text-xs text-on-surface-muted mb-3">
            Grant microphone access to enable voice input.
          </p>
          <button
            type="button"
            className="inline-flex items-center gap-2 text-sm text-on-surface-secondary hover:text-on-surface"
          >
            <Mic size={14} aria-hidden="true" />
            Allow microphone access
          </button>
        </div>

        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-on-surface mb-2">Speech-to-Text</legend>
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
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
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
                <span className="font-normal text-success ml-2">Set</span>
              </label>
              <input
                id="voice-stt-key"
                type="password"
                value=""
                readOnly
                placeholder="Enter new key to update"
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
              />
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-on-surface mb-2">Text-to-Speech</legend>
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
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
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
                <span className="font-normal text-success ml-2">Set</span>
              </label>
              <input
                id="voice-tts-key"
                type="password"
                value=""
                readOnly
                placeholder="Enter new key to update"
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
              />
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
              <select
                id="voice-tts-voice"
                defaultValue="alloy"
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
              >
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
              className="accent-accent-action"
            />
            Read AI responses aloud
          </label>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-on-surface mb-2">Interaction Mode</legend>
          <div className="flex gap-4">
            {(
              [
                { id: "off", label: "Off" },
                { id: "push-to-talk", label: "Push-to-Talk" },
                { id: "vad", label: "VAD (Hands-free)" },
              ] as const
            ).map((option) => (
              <label key={option.id} className="flex items-center gap-1.5 text-sm text-on-surface">
                <input
                  type="radio"
                  name="voiceMode"
                  value={option.id}
                  checked={mode === option.id}
                  onChange={() => setMode(option.id)}
                  className="accent-accent-action"
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
              className="accent-accent-action"
            />
            Auto-send transcribed text to AI
          </label>

          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={smartEndpoint}
              onChange={(e) => setSmartEndpoint(e.target.checked)}
              className="accent-accent-action"
            />
            Smart endpoint detection
          </label>
        </fieldset>
      </div>
    </section>
  );
}
