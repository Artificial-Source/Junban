import { useState, useEffect, useCallback } from "react";
import { Mic, RefreshCw, AlertCircle, CheckCircle2, Download, Loader2 } from "lucide-react";
import { useVoiceContext, type VoiceMode, type VoiceSettings } from "../../context/VoiceContext.js";
import {
  enumerateMicrophones,
  type MicrophoneInfo,
} from "../../../ai/voice/audio-utils.js";
import type { VoiceProviderRegistry } from "../../../ai/voice/registry.js";
import type { ModelStatus } from "../../../ai/voice/adapters/whisper-local-stt.js";

export function VoiceTab() {
  const { settings, updateSettings, registry, ttsVoices } = useVoiceContext();

  const sttProviders = registry.listSTT();
  const ttsProviders = registry.listTTS();

  return (
    <section className="mb-8">
      <h2 className="text-lg font-semibold mb-1 text-on-surface">Voice</h2>
      <p className="text-xs text-on-surface-muted mb-5">
        Configure speech-to-text, text-to-speech, microphone, and voice interaction mode.
      </p>

      <div className="space-y-8 max-w-lg">
        {/* ── Microphone ── */}
        <MicrophoneSection
          selectedId={settings.microphoneId}
          onSelect={updateSettings}
        />

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
          </div>
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

          {ttsVoices.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                Voice
              </label>
              <select
                value={settings.ttsVoice}
                onChange={(e) => updateSettings({ ttsVoice: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
              >
                <option value="">Default</option>
                {ttsVoices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
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
                Requires an audio-based STT provider (Whisper Local or Groq) since VAD produces raw audio.
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
        </fieldset>

        {/* ── Local Models ── */}
        <LocalModelsSection registry={registry} />

        {/* ── Groq API Key ── */}
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-on-surface mb-2">Groq Cloud Voice</legend>
          <div>
            <label className="block text-xs font-medium text-on-surface-secondary mb-1">
              API Key
              {settings.groqApiKey && (
                <span className="font-normal text-success ml-2">Set</span>
              )}
            </label>
            <input
              type="password"
              value={settings.groqApiKey}
              onChange={(e) => updateSettings({ groqApiKey: e.target.value })}
              placeholder="Enter Groq API key"
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
            />
            <p className="mt-1 text-xs text-on-surface-muted">
              Enables Groq Whisper (STT) and PlayAI (TTS). Free tier available at groq.com.
            </p>
          </div>
        </fieldset>
      </div>
    </section>
  );
}

function MicrophoneSection({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (patch: Partial<VoiceSettings>) => void;
}) {
  const [microphones, setMicrophones] = useState<MicrophoneInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);

  const refreshMicrophones = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const mics = await enumerateMicrophones();
      setMicrophones(mics);
      setPermissionGranted(mics.length > 0);
    } catch {
      setError("Could not access microphones. Check browser permissions.");
      setPermissionGranted(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // Check if permission was previously granted (without prompting)
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.permissions) return;
    navigator.permissions.query({ name: "microphone" as PermissionName }).then((status) => {
      if (status.state === "granted") {
        refreshMicrophones();
      }
    }).catch(() => {
      // permissions.query not supported for microphone in some browsers
    });
  }, [refreshMicrophones]);

  // Listen for device changes (plug/unplug) — only when already granted
  useEffect(() => {
    if (!permissionGranted) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    const handler = () => refreshMicrophones();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
  }, [permissionGranted, refreshMicrophones]);

  // Reset selected mic if it's no longer available
  useEffect(() => {
    if (selectedId && microphones.length > 0 && !microphones.some((m) => m.deviceId === selectedId)) {
      onSelect({ microphoneId: "" });
    }
  }, [selectedId, microphones, onSelect]);

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-on-surface mb-2">Microphone</legend>

      {!permissionGranted && !loading && !error && (
        <div className="space-y-2">
          <p className="text-xs text-on-surface-muted">
            Grant microphone access to enable voice input.
          </p>
          <button
            type="button"
            onClick={refreshMicrophones}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
          >
            <Mic size={14} />
            Allow microphone access
          </button>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-xs text-on-surface-muted">
          <RefreshCw size={12} className="animate-spin" />
          Detecting microphones...
        </div>
      )}

      {error && (
        <div className="space-y-2">
          <span className="text-xs text-error flex items-center gap-1.5">
            <AlertCircle size={12} />
            {error}
          </span>
          <button
            type="button"
            onClick={refreshMicrophones}
            className="px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {permissionGranted && (
        <>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-success flex items-center gap-1.5">
              <CheckCircle2 size={12} />
              {microphones.length} microphone{microphones.length !== 1 ? "s" : ""} detected
            </span>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={selectedId}
              onChange={(e) => onSelect({ microphoneId: e.target.value })}
              className="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
            >
              <option value="">System default</option>
              {microphones.map((mic) => (
                <option key={mic.deviceId} value={mic.deviceId}>
                  {mic.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={refreshMicrophones}
              disabled={loading}
              title="Refresh microphones"
              className="shrink-0 p-2 text-on-surface-muted hover:text-on-surface rounded-lg hover:bg-surface-secondary transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </>
      )}
    </fieldset>
  );
}

interface LocalModelInfo {
  id: string;
  name: string;
  modelId: string;
  type: "STT" | "TTS";
  status: ModelStatus;
  progress: number;
  preload: () => Promise<void>;
  onStatusChange?: ((status: ModelStatus, progress: number) => void) | undefined;
}

/** Extract local model info from a provider via duck typing. */
function toLocalModelInfo(provider: any, type: "STT" | "TTS"): LocalModelInfo | null {
  if (provider && typeof provider.status === "string" && typeof provider.preload === "function") {
    return {
      id: provider.id,
      name: provider.name,
      modelId: provider.modelId,
      type,
      status: provider.status,
      progress: provider.progress,
      preload: () => provider.preload(),
      get onStatusChange() { return provider.onStatusChange; },
      set onStatusChange(cb) { provider.onStatusChange = cb; },
    };
  }
  return null;
}

function LocalModelsSection({ registry }: { registry: VoiceProviderRegistry }) {
  const [, forceUpdate] = useState(0);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const localModels: LocalModelInfo[] = [
    ...registry.listSTT().map((p) => toLocalModelInfo(p, "STT")).filter((m): m is LocalModelInfo => m !== null),
    ...registry.listTTS().map((p) => toLocalModelInfo(p, "TTS")).filter((m): m is LocalModelInfo => m !== null),
  ];

  if (localModels.length === 0) return null;

  const handlePreload = async (model: LocalModelInfo) => {
    if (model.status === "ready" || model.status === "loading") return;
    setLoadingId(model.id);
    const originalCallback = model.onStatusChange;
    model.onStatusChange = (status: ModelStatus, progress: number) => {
      originalCallback?.(status, progress);
      forceUpdate((n) => n + 1);
    };
    try {
      await model.preload();
    } catch {
      // error state already set by the provider
    }
    model.onStatusChange = originalCallback;
    setLoadingId(null);
    forceUpdate((n) => n + 1);
  };

  return (
    <fieldset className="space-y-4">
      <legend className="text-sm font-semibold text-on-surface mb-2">Local Models</legend>
      <p className="text-xs text-on-surface-muted -mt-2">
        Local models run entirely in your browser. Models are downloaded once and cached.
      </p>

      <div className="space-y-3">
        {localModels.map((model) => (
          <div
            key={model.id}
            className="flex items-center justify-between p-3 rounded-lg border border-border bg-surface-secondary"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-on-surface">{model.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-tertiary text-on-surface-muted">
                  {model.type}
                </span>
              </div>
              <p className="text-xs text-on-surface-muted mt-0.5 truncate">{model.modelId}</p>

              {/* Progress bar */}
              {model.status === "loading" && (
                <div className="mt-2">
                  <div className="w-full h-1.5 bg-surface-tertiary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full transition-all duration-300"
                      style={{ width: `${model.progress}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-on-surface-muted mt-0.5">
                    Downloading model... {model.progress}%
                  </p>
                </div>
              )}
            </div>

            <div className="ml-3 shrink-0">
              {model.status === "ready" ? (
                <span className="flex items-center gap-1 text-xs text-success">
                  <CheckCircle2 size={12} />
                  Ready
                </span>
              ) : model.status === "loading" ? (
                <Loader2 size={14} className="animate-spin text-accent" />
              ) : model.status === "error" ? (
                <button
                  onClick={() => handlePreload(model)}
                  className="flex items-center gap-1 text-xs text-error hover:text-on-surface transition-colors"
                >
                  <AlertCircle size={12} />
                  Retry
                </button>
              ) : (
                <button
                  onClick={() => handlePreload(model)}
                  disabled={loadingId !== null}
                  className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors disabled:opacity-50"
                >
                  <Download size={12} />
                  Download
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
