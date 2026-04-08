import { useState, useEffect } from "react";
import { useAIContext } from "../../context/AIContext.js";
import { AIFeatureProvider } from "../../context/AIFeatureProvider.js";
import { api, type AIProviderInfo, type ModelDiscoveryInfo } from "../../api/index.js";
import { PROVIDER_HELP } from "./ai/ai-tab-constants.js";
import { MemorySection } from "./ai/MemorySection.js";
import { CustomInstructionsSection } from "./ai/CustomInstructionsSection.js";
import { DailyBriefingSection } from "./ai/DailyBriefingSection.js";

export function AITab() {
  return (
    <AIFeatureProvider>
      <AITabContent />
    </AIFeatureProvider>
  );
}

function AITabContent() {
  const { config, isConfigured, updateConfig, refreshConfig } = useAIContext();
  const [providers, setProviders] = useState<AIProviderInfo[]>([]);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [authType, setAuthType] = useState<"api-key" | "oauth">("api-key");
  const [oauthToken, setOauthToken] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelDiscoveryInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsFailed, setModelsFailed] = useState(false);
  const [useCustomModel, setUseCustomModel] = useState(false);
  const [modelLoadingId, setModelLoadingId] = useState<string | null>(null);

  useEffect(() => {
    api
      .listAIProviders()
      .then(setProviders)
      .catch((err: unknown) => console.error("[settings:ai] Failed to load providers:", err));
  }, []);

  useEffect(() => {
    if (config && !loaded) {
      setProvider(config.provider ?? "");
      setModel(config.model ?? "");
      setBaseUrl(config.baseUrl ?? "");
      setAuthType(config.authType ?? "api-key");
      setLoaded(true);
    }
  }, [config, loaded]);

  // Fetch available models when provider or baseUrl changes
  useEffect(() => {
    if (!provider) {
      setAvailableModels([]);
      setModelsFailed(false);
      return;
    }

    setModelsLoading(true);
    setModelsFailed(false);
    setUseCustomModel(false);

    const timer = setTimeout(() => {
      api
        .fetchModels(provider, baseUrl || undefined)
        .then((models) => {
          setAvailableModels(models);
          setModelsFailed(false);
          if (models.length > 0) {
            const isPlaceholder = !model || model === "default";
            if (isPlaceholder) {
              // Auto-select first loaded model, or first model
              const firstLoaded = models.find((m) => m.loaded);
              setModel((firstLoaded ?? models[0]).id);
            } else if (!models.some((m) => m.id === model)) {
              setUseCustomModel(true);
            }
          }
        })
        .catch(() => {
          setAvailableModels([]);
          setModelsFailed(true);
        })
        .finally(() => setModelsLoading(false));
    }, 300);

    return () => clearTimeout(timer);
  }, [provider, baseUrl]);

  const currentProvider = providers.find((p) => p.name === provider);
  const supportsAutoLoad = provider === "lmstudio";
  const [autoManage, setAutoManage] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("junban.ai.auto-manage-lmstudio") === "1";
  });

  const handleProviderChange = async (newProvider: string) => {
    setProvider(newProvider);
    setApiKey("");
    setAuthType("api-key");
    setOauthToken("");
    const prov = providers.find((p) => p.name === newProvider);
    setModel(prov?.defaultModel ?? "");
    setBaseUrl(prov?.defaultBaseUrl ?? "");
    setUseCustomModel(false);

    if (!newProvider) {
      await updateConfig({
        provider: "",
        apiKey: "",
        model: "",
        baseUrl: "",
        authType: "",
        oauthToken: "",
      });
    }
  };

  const handleModelSelect = async (selectedId: string) => {
    if (selectedId === "__custom__") {
      setUseCustomModel(true);
      setModel("");
      return;
    }
    setModel(selectedId);

    // Auto-load if the model isn't loaded yet (LM Studio)
    const modelInfo = availableModels.find((m) => m.id === selectedId);
    if (supportsAutoLoad && modelInfo && !modelInfo.loaded) {
      setModelLoadingId(selectedId);
      try {
        await api.loadModel(provider, selectedId, baseUrl || undefined);
        // Update loaded status in state
        setAvailableModels((prev) =>
          prev.map((m) => (m.id === selectedId ? { ...m, loaded: true } : m)),
        );
      } catch {
        // Model load failed — still set the model, user can retry
      } finally {
        setModelLoadingId(null);
      }
    }
  };

  const handleSave = async () => {
    await updateConfig({
      provider: provider || undefined,
      apiKey: apiKey || undefined,
      model: model || undefined,
      baseUrl: baseUrl || undefined,
      authType: authType || undefined,
      oauthToken: oauthToken || undefined,
    });
    setApiKey("");
    setOauthToken("");
    await refreshConfig();
    // Re-fetch models after save (API key may have changed)
    if (provider) {
      api
        .fetchModels(provider, baseUrl || undefined)
        .then((models) => {
          setAvailableModels(models);
          setModelsFailed(false);
        })
        .catch((err: unknown) => console.warn("[settings:ai] Failed to fetch models:", err));
    }
  };

  const showDropdown = availableModels.length > 0 && !useCustomModel;

  return (
    <>
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3 text-on-surface">AI Assistant</h2>

        <div className="space-y-4 max-w-md">
          <div>
            <label className="block text-xs font-medium text-on-surface-secondary mb-1">
              Provider
            </label>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
            >
              <option value="">None (disabled)</option>
              {providers.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.displayName}
                  {p.pluginId ? " (plugin)" : ""}
                </option>
              ))}
            </select>
          </div>

          {provider && (
            <>
              {(currentProvider?.needsApiKey || currentProvider?.optionalApiKey) && (
                <div>
                  {currentProvider?.supportsOAuth && (
                    <div className="mb-3">
                      <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                        Authentication
                      </label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setAuthType("api-key")}
                          className={`px-3 py-1.5 text-xs rounded-lg border ${
                            authType === "api-key"
                              ? "bg-accent text-white border-accent"
                              : "bg-surface text-on-surface-secondary border-border hover:border-on-surface-muted"
                          }`}
                        >
                          API Key
                        </button>
                        <button
                          type="button"
                          onClick={() => setAuthType("oauth")}
                          className={`px-3 py-1.5 text-xs rounded-lg border ${
                            authType === "oauth"
                              ? "bg-accent text-white border-accent"
                              : "bg-surface text-on-surface-secondary border-border hover:border-on-surface-muted"
                          }`}
                        >
                          OAuth Token
                        </button>
                      </div>
                    </div>
                  )}

                  {authType === "api-key" ? (
                    <>
                      <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                        API Key
                        {currentProvider?.optionalApiKey && !currentProvider?.needsApiKey && (
                          <span className="font-normal text-on-surface-muted ml-1">(optional)</span>
                        )}
                        {config?.hasApiKey && (
                          <span className="font-normal text-success ml-2">Set</span>
                        )}
                      </label>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={
                          config?.hasApiKey
                            ? "Enter new key to update"
                            : currentProvider?.optionalApiKey
                              ? "Enter API key for remote servers"
                              : "Enter API key"
                        }
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
                      />
                      {PROVIDER_HELP[provider] && (
                        <p className="mt-1 text-xs text-on-surface-muted">
                          {PROVIDER_HELP[provider]}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                        OAuth Token
                        {config?.hasOAuthToken && (
                          <span className="font-normal text-success ml-2">Set</span>
                        )}
                      </label>
                      <input
                        type="password"
                        value={oauthToken}
                        onChange={(e) => setOauthToken(e.target.value)}
                        placeholder={
                          config?.hasOAuthToken
                            ? "Enter new token to update"
                            : "Paste your OAuth token"
                        }
                        className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
                      />
                      <p className="mt-1 text-xs text-on-surface-muted">
                        Use your existing {currentProvider?.displayName} subscription. Paste your
                        OAuth access token above. Full OAuth flow will be available in a future
                        update.
                      </p>
                      <div className="mt-3 p-3 rounded-lg border border-warning/30 bg-warning/5">
                        <p className="text-xs text-on-surface-muted">
                          <strong>Personal use only.</strong> Using your subscription OAuth token in
                          third-party apps may not be supported by all providers. Ensure your usage
                          complies with your provider{"'"}s terms. Your token is stored locally and
                          never leaves your device.
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                  Model
                  {modelsLoading && (
                    <span className="font-normal text-on-surface-muted ml-2">Loading...</span>
                  )}
                </label>
                {showDropdown ? (
                  <>
                    <select
                      value={model}
                      onChange={(e) => handleModelSelect(e.target.value)}
                      disabled={!!modelLoadingId}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface disabled:opacity-60"
                    >
                      {!model && <option value="">Select a model...</option>}
                      {availableModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                          {m.loaded ? "" : " (not loaded)"}
                        </option>
                      ))}
                      <option value="__custom__">Custom...</option>
                    </select>
                    {modelLoadingId && (
                      <p className="mt-1 text-xs text-accent">Loading model into LM Studio...</p>
                    )}
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder={currentProvider?.defaultModel ?? "Enter model name"}
                      className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
                    />
                    {useCustomModel && availableModels.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setUseCustomModel(false);
                          if (!availableModels.some((m) => m.id === model)) {
                            const firstLoaded = availableModels.find((m) => m.loaded);
                            setModel((firstLoaded ?? availableModels[0]).id);
                          }
                        }}
                        className="mt-1 text-xs text-accent hover:text-accent-hover"
                      >
                        Back to model list
                      </button>
                    )}
                    {modelsFailed && (
                      <p className="mt-1 text-xs text-on-surface-muted">
                        {provider === "lmstudio"
                          ? "Could not connect to LM Studio. Make sure LM Studio is running and its local server is started."
                          : provider === "ollama"
                            ? "Could not connect to Ollama. Make sure Ollama is running."
                            : "Could not fetch models — enter a model name manually."}
                      </p>
                    )}
                  </>
                )}
              </div>

              {currentProvider?.showBaseUrl && (
                <div>
                  <label className="block text-xs font-medium text-on-surface-secondary mb-1">
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={currentProvider?.defaultBaseUrl ?? ""}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
                  />
                </div>
              )}

              <button
                onClick={handleSave}
                className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover"
              >
                Save
              </button>

              <p className={`text-xs ${isConfigured ? "text-success" : "text-on-surface-muted"}`}>
                {isConfigured ? "Connected" : "Not configured"}
              </p>

              {supportsAutoLoad && (
                <label className="flex items-center gap-2 text-sm text-on-surface mt-2">
                  <input
                    type="checkbox"
                    checked={autoManage}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setAutoManage(checked);
                      window.localStorage.setItem(
                        "junban.ai.auto-manage-lmstudio",
                        checked ? "1" : "0",
                      );
                    }}
                    className="accent-accent"
                  />
                  Auto-manage LM Studio models
                  <span className="text-xs text-on-surface-muted ml-1">
                    (load on chat open, unload on close)
                  </span>
                </label>
              )}
            </>
          )}
        </div>
      </section>

      <DailyBriefingSection />

      <CustomInstructionsSection />

      <MemorySection />
    </>
  );
}
