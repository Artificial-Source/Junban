import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Download, Loader2, AlertCircle, CheckCircle2, Trash2 } from "lucide-react";
import type { VoiceProviderRegistry } from "../../../../ai/voice/registry.js";
import type { ModelStatus } from "../../../../ai/voice/adapters/whisper-local-stt.js";

export interface LocalModelInfo {
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toLocalModelInfo(provider: any, type: "STT" | "TTS"): LocalModelInfo | null {
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

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LocalModelsSection({ registry }: { registry: VoiceProviderRegistry }) {
  const [modelVersion, setModelVersion] = useState(0);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [modelSizes, setModelSizes] = useState<Map<string, number>>(new Map());

  // Memoize localModels to avoid recreating on every render.
  // modelVersion is bumped after preload/delete to pick up status changes.
  const localModels = useMemo<LocalModelInfo[]>(
    () => [
      ...registry
        .listSTT()
        .map((p) => toLocalModelInfo(p, "STT"))
        .filter((m): m is LocalModelInfo => m !== null),
      ...registry
        .listTTS()
        .map((p) => toLocalModelInfo(p, "TTS"))
        .filter((m): m is LocalModelInfo => m !== null),
    ],
    [registry, modelVersion],
  );

  // Keep a ref so async callbacks always see the latest models
  const localModelsRef = useRef(localModels);
  useEffect(() => {
    localModelsRef.current = localModels;
  }, [localModels]);

  // Phase 1: fast check — just whether models are cached (no size computation)
  const checkCacheStatus = useCallback(async () => {
    const models = localModelsRef.current;
    const checkable = models.filter((m) => m.checkCached);
    if (checkable.length === 0) {
      setCachedIds(new Set());
      return;
    }

    const results = await Promise.all(
      checkable.map(async (model) => {
        try {
          return { id: model.id, cached: await model.checkCached!() };
        } catch {
          return { id: model.id, cached: false };
        }
      }),
    );

    const found = new Set<string>();
    for (const r of results) {
      if (r.cached) found.add(r.id);
    }
    setCachedIds(found.size > 0 ? found : new Set());
    return found;
  }, []);

  // Phase 2: slow — fetch sizes only for cached models, after the UI has rendered
  const fetchModelSizes = useCallback(async (cachedModelIds: Set<string>) => {
    if (cachedModelIds.size === 0) {
      setModelSizes(new Map());
      return;
    }
    const models = localModelsRef.current;
    const cachedModels = models.filter((m) => cachedModelIds.has(m.id) && m.getModelSize);

    const results = await Promise.all(
      cachedModels.map(async (model) => {
        try {
          const size = await model.getModelSize!();
          return { id: model.id, size };
        } catch {
          return { id: model.id, size: 0 };
        }
      }),
    );

    const sizes = new Map<string, number>();
    for (const r of results) {
      if (r.size > 0) sizes.set(r.id, r.size);
    }
    setModelSizes(sizes);
  }, []);

  // On mount: check cache status quickly, then lazily fetch sizes
  useEffect(() => {
    let cancelled = false;
    checkCacheStatus().then((found) => {
      if (cancelled || !found) return;
      // Defer size fetching so the tab renders fast with just cached/not-cached status
      const defer =
        typeof requestIdleCallback === "function"
          ? requestIdleCallback
          : (cb: () => void) => setTimeout(cb, 50);
      defer(() => {
        if (!cancelled) fetchModelSizes(found);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [checkCacheStatus, fetchModelSizes]);

  if (localModels.length === 0) return null;

  const handlePreload = async (model: LocalModelInfo) => {
    if (model.status === "ready" || model.status === "loading") return;
    setLoadingId(model.id);
    const originalCallback = model.onStatusChange;
    model.onStatusChange = (status: ModelStatus, progress: number) => {
      originalCallback?.(status, progress);
      setModelVersion((n) => n + 1);
    };
    try {
      await model.preload();
    } catch {
      // error state already set by the provider
    }
    model.onStatusChange = originalCallback;
    setLoadingId(null);
    setModelVersion((n) => n + 1);
    const found = await checkCacheStatus();
    if (found) fetchModelSizes(found);
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
    setModelVersion((n) => n + 1);
    const found = await checkCacheStatus();
    if (found) fetchModelSizes(found);
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
