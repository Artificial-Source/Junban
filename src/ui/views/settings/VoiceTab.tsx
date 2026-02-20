import { useState, useEffect, useCallback } from "react";
import {
  Mic,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  Play,
  Trash2,
} from "lucide-react";
import { useVoiceContext, type VoiceMode, type VoiceSettings } from "../../context/VoiceContext.js";
import {
  enumerateMicrophones,
  triggerMicPermissionPrompt,
  type MicrophoneInfo,
} from "../../../ai/voice/audio-utils.js";
import type { VoiceProviderRegistry } from "../../../ai/voice/registry.js";
import type { ModelStatus } from "../../../ai/voice/adapters/whisper-local-stt.js";

export function VoiceTab() {
  const voice = useVoiceContext();
  const { settings, updateSettings, registry, ttsVoices, ttsModels } = voice;

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

/** Maps a voice provider ID to the settings key holding its API key. */
const PROVIDER_KEY_MAP: Record<
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

function ProviderApiKeyInput({
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
  const [permissionState, setPermissionState] = useState<PermissionState | null>(null);
  const [promptTimedOut, setPromptTimedOut] = useState(false);

  // Enumerate devices (no permission request — assumes permission already granted)
  const refreshMicrophones = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const mics = await enumerateMicrophones();
      setMicrophones(mics);
      setPermissionGranted(mics.length > 0);
    } catch {
      setError("Could not access microphones.");
      setPermissionGranted(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // Check and watch permission state (without prompting)
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.permissions) return;

    const handleChange = (status: PermissionStatus) => {
      setPermissionState(status.state);
      if (status.state === "granted") {
        refreshMicrophones();
      }
    };

    let permStatus: PermissionStatus | null = null;
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((status) => {
        permStatus = status;
        setPermissionState(status.state);
        if (status.state === "granted") {
          refreshMicrophones();
        }
        status.addEventListener("change", () => handleChange(status));
      })
      .catch(() => {
        // permissions.query not supported for microphone in some browsers
      });

    return () => {
      if (permStatus) {
        permStatus.onchange = null;
      }
    };
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
    if (
      selectedId &&
      microphones.length > 0 &&
      !microphones.some((m) => m.deviceId === selectedId)
    ) {
      onSelect({ microphoneId: "" });
    }
  }, [selectedId, microphones, onSelect]);

  const handleRequestPermission = async () => {
    setLoading(true);
    setError(null);
    setPromptTimedOut(false);

    // Fire getUserMedia to trigger the browser permission dialog.
    // This may hang on some systems (e.g. Linux + PipeWire) even after the user
    // clicks Allow, so we use a timeout. The Permissions API change listener
    // above will detect the grant independently and enumerate devices.
    const ok = await triggerMicPermissionPrompt(8000);

    if (ok) {
      // getUserMedia resolved — permission granted and device opened successfully
      await refreshMicrophones();
    } else {
      // Timed out or failed. Check if permission was actually granted
      // (browser dialog might have worked but getUserMedia hung on device open).
      try {
        const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
        if (status.state === "granted") {
          // Permission was granted but getUserMedia hung — enumerate directly
          await refreshMicrophones();
        } else {
          setPromptTimedOut(true);
          setLoading(false);
        }
      } catch {
        setPromptTimedOut(true);
        setLoading(false);
      }
    }
  };

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-on-surface mb-2">Microphone</legend>

      {!permissionGranted && !loading && !error && (
        <div className="space-y-3">
          {promptTimedOut ? (
            <div className="p-3 rounded-lg border border-warning/30 bg-warning/5 space-y-2">
              <p className="text-xs text-on-surface">
                The browser permission dialog didn't respond. This can happen on Linux with
                PipeWire/PulseAudio.
              </p>
              <p className="text-xs text-on-surface-muted">
                Try granting microphone access directly: click the lock/site icon in your browser's
                address bar, find "Microphone", and set it to "Allow". The page will detect the
                change automatically.
              </p>
              <button
                type="button"
                onClick={handleRequestPermission}
                className="flex items-center gap-2 px-3 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
              >
                <Mic size={14} />
                Try again
              </button>
            </div>
          ) : (
            <>
              <p className="text-xs text-on-surface-muted">
                Grant microphone access to enable voice input.
              </p>
              <button
                type="button"
                onClick={handleRequestPermission}
                className="flex items-center gap-2 px-3 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors"
              >
                <Mic size={14} />
                Allow microphone access
              </button>
            </>
          )}
          {permissionState === "denied" && (
            <p className="text-xs text-warning flex items-start gap-1.5">
              <AlertCircle size={12} className="shrink-0 mt-0.5" />
              <span>
                Microphone access was denied. Click the lock/site icon in your browser's address bar
                to reset the permission, then try again.
              </span>
            </p>
          )}
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
  checkCached?: () => Promise<boolean>;
  deleteModel?: () => Promise<void>;
  getModelSize?: () => Promise<number>;
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
      checkCached:
        typeof provider.checkCached === "function" ? () => provider.checkCached() : undefined,
      deleteModel:
        typeof provider.deleteModel === "function" ? () => provider.deleteModel() : undefined,
      getModelSize:
        typeof provider.getModelSize === "function" ? () => provider.getModelSize() : undefined,
      get onStatusChange() {
        return provider.onStatusChange;
      },
      set onStatusChange(cb) {
        provider.onStatusChange = cb;
      },
    };
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LocalModelsSection({ registry }: { registry: VoiceProviderRegistry }) {
  const [, forceUpdate] = useState(0);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [modelSizes, setModelSizes] = useState<Map<string, number>>(new Map());

  const localModels: LocalModelInfo[] = [
    ...registry
      .listSTT()
      .map((p) => toLocalModelInfo(p, "STT"))
      .filter((m): m is LocalModelInfo => m !== null),
    ...registry
      .listTTS()
      .map((p) => toLocalModelInfo(p, "TTS"))
      .filter((m): m is LocalModelInfo => m !== null),
  ];

  const checkCacheStatus = useCallback(async () => {
    const found = new Set<string>();
    const sizes = new Map<string, number>();
    for (const model of localModels) {
      if (!model.checkCached) continue;
      try {
        if (await model.checkCached()) {
          found.add(model.id);
          if (model.getModelSize) {
            try {
              const size = await model.getModelSize();
              if (size > 0) sizes.set(model.id, size);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    if (found.size > 0) setCachedIds(found);
    else setCachedIds(new Set());
    setModelSizes(sizes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check which models are already downloaded in browser cache (lightweight, no WASM loading)
  useEffect(() => {
    let cancelled = false;
    checkCacheStatus().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [checkCacheStatus]);

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
    // Re-check cache status after download
    await checkCacheStatus();
  };

  const handleDelete = async (model: LocalModelInfo) => {
    if (!model.deleteModel) return;
    setDeletingId(model.id);
    setConfirmDeleteId(null);
    try {
      await model.deleteModel();
    } catch {
      // Deletion failed — ignore
    }
    setDeletingId(null);
    forceUpdate((n) => n + 1);
    // Re-check cache status after delete
    await checkCacheStatus();
  };

  return (
    <fieldset className="space-y-4">
      <legend className="text-sm font-semibold text-on-surface mb-2">Local Models</legend>
      <p className="text-xs text-on-surface-muted -mt-2">
        Local models run entirely in your browser. Models are downloaded once and cached.
      </p>

      <div className="space-y-3">
        {localModels.map((model) => {
          const isCached = cachedIds.has(model.id);
          const modelSize = modelSizes.get(model.id);
          return (
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
                  {isCached && modelSize !== undefined && (
                    <span className="text-[10px] text-on-surface-muted">
                      {formatBytes(modelSize)}
                    </span>
                  )}
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
                      {isCached ? "Loading model..." : "Downloading model..."} {model.progress}%
                    </p>
                  </div>
                )}

                {/* Delete confirmation */}
                {confirmDeleteId === model.id && (
                  <div className="mt-2 flex items-center gap-2 p-2 rounded bg-error/5 border border-error/20">
                    <p className="text-xs text-on-surface flex-1">Delete this model?</p>
                    <button
                      onClick={() => handleDelete(model)}
                      className="px-2 py-0.5 text-xs bg-error text-white rounded hover:bg-error/90 transition-colors"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="px-2 py-0.5 text-xs border border-border rounded text-on-surface-secondary hover:bg-surface-tertiary transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>

              <div className="ml-3 shrink-0 flex items-center gap-2">
                {model.status === "ready" ? (
                  <>
                    <span className="flex items-center gap-1 text-xs text-success">
                      <CheckCircle2 size={12} />
                      Ready
                    </span>
                    {model.deleteModel && (
                      <button
                        onClick={() => setConfirmDeleteId(model.id)}
                        disabled={!!deletingId}
                        title="Delete model"
                        className="p-1 text-on-surface-muted hover:text-error transition-colors disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </>
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
                ) : deletingId === model.id ? (
                  <Loader2 size={14} className="animate-spin text-on-surface-muted" />
                ) : isCached ? (
                  <>
                    <span className="flex items-center gap-1 text-xs text-success">
                      <CheckCircle2 size={12} />
                      Downloaded
                    </span>
                    {model.deleteModel && (
                      <button
                        onClick={() => setConfirmDeleteId(model.id)}
                        disabled={!!deletingId}
                        title="Delete model"
                        className="p-1 text-on-surface-muted hover:text-error transition-colors disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </>
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
          );
        })}
      </div>
    </fieldset>
  );
}
