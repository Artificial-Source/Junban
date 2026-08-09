/**
 * Settings → AI tab (legacy presentation preserved).
 * Lazy-loaded only when the AI settings route is selected.
 */

import { useState } from "react";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { SettingsStatusBanner } from "../settingsComponents";
import { primaryButtonClass, secondaryButtonClass } from "../settingsHelpers";
import {
  capabilityLabels,
  CUSTOM_INSTRUCTIONS_MAX,
  defaultSecretKindForProvider,
  ENERGY_OPTIONS,
  ORIGIN_PRIVACY_COPY,
  PROVIDER_HELP,
} from "./constants";
import { CredentialControl } from "./CredentialControl";
import { MemoryEditor } from "./MemoryEditor";
import { useAiConfigController } from "./useAiConfigController";

export function AiTab() {
  const controller = useAiConfigController();
  const {
    loading,
    saving,
    error,
    statusMessage,
    confirmed,
    providers,
    aiDraft,
    isConfigured,
    selectedProvider,
    discoveredModels,
    modelsLoading,
    modelsError,
    dirty,
    setAiDraft,
    clearError,
    save,
    discoverModels,
    providerCredentialSwitchRequired,
    deleteCredentialThenSave,
    submitCredential,
    removeCredential,
    credentialBusy,
  } = controller;

  const [confirmProviderSwitch, setConfirmProviderSwitch] = useState(false);
  const [useCustomModel, setUseCustomModel] = useState(false);

  if (loading || !aiDraft || !confirmed) {
    return (
      <div
        role="status"
        className="flex min-h-[240px] items-center justify-center text-sm text-on-surface-muted"
      >
        Loading AI settings…
      </div>
    );
  }

  const showBaseUrl = aiDraft.provider === "custom";
  const showDropdown = discoveredModels.length > 0 && !useCustomModel;
  const credentialPresent = Boolean(confirmed.credentials.ai_provider?.present);

  const handleProviderChange = (value: string) => {
    const next = value === "" ? null : (value as NonNullable<typeof aiDraft.provider>);
    const entry = providers.find((p) => p.id === next);
    setAiDraft({
      provider: next,
      model: null,
      base_url: next === "custom" ? aiDraft.base_url : (entry?.default_base_url ?? null),
      enabled: next ? aiDraft.enabled || true : false,
    });
    setUseCustomModel(false);
  };

  const handleSaveClick = () => {
    if (providerCredentialSwitchRequired) {
      setConfirmProviderSwitch(true);
      return;
    }
    void save();
  };

  return (
    <>
      <section className="mb-8" data-testid="ai-settings-tab">
        <h2 className="mb-3 text-lg font-semibold text-on-surface">AI Assistant</h2>

        {(error || statusMessage) && (
          <div className="mb-4 max-w-md space-y-2">
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

        <div className="max-w-md space-y-4">
          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={aiDraft.enabled}
              disabled={!aiDraft.provider}
              onChange={(event) => setAiDraft({ enabled: event.target.checked })}
              className="accent-accent-action"
            />
            Enable AI assistant
          </label>

          <div>
            <label
              htmlFor="ai-provider"
              className="mb-1 block text-xs font-medium text-on-surface-secondary"
            >
              Provider
            </label>
            <select
              id="ai-provider"
              value={aiDraft.provider ?? ""}
              onChange={(event) => handleProviderChange(event.target.value)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
            >
              <option value="">None (disabled)</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.display_name}
                </option>
              ))}
            </select>
          </div>

          {aiDraft.provider && selectedProvider && (
            <>
              <p className="text-xs text-on-surface-muted">
                {ORIGIN_PRIVACY_COPY[selectedProvider.origin_class] ??
                  ORIGIN_PRIVACY_COPY.fixed_cloud_https}
              </p>
              <p className="text-xs text-on-surface-muted">
                Capabilities: {capabilityLabels(selectedProvider.capabilities)}
              </p>

              {selectedProvider.credential_required && (
                <CredentialControl
                  target="ai_provider"
                  label="API Key"
                  helpText={PROVIDER_HELP[aiDraft.provider]}
                  present={credentialPresent}
                  metadata={confirmed.credentials.ai_provider}
                  defaultKind={defaultSecretKindForProvider(aiDraft.provider)}
                  busy={credentialBusy === "ai_provider"}
                  disabled={saving}
                  onSubmit={(body) => submitCredential("ai_provider", body)}
                  onDelete={() => removeCredential("ai_provider")}
                />
              )}

              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label
                    htmlFor="ai-model"
                    className="block text-xs font-medium text-on-surface-secondary"
                  >
                    Model
                    {modelsLoading && (
                      <span className="ml-2 font-normal text-on-surface-muted">Loading…</span>
                    )}
                  </label>
                  <button
                    type="button"
                    disabled={modelsLoading || saving}
                    onClick={() => void discoverModels()}
                    className="text-xs text-accent-foreground hover:text-accent-foreground-hover disabled:opacity-50"
                  >
                    Discover models
                  </button>
                </div>
                {showDropdown ? (
                  <>
                    <select
                      id="ai-model"
                      value={aiDraft.model ?? ""}
                      onChange={(event) => {
                        if (event.target.value === "__custom__") {
                          setUseCustomModel(true);
                          setAiDraft({ model: "" });
                          return;
                        }
                        setAiDraft({ model: event.target.value || null });
                      }}
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
                    >
                      {!aiDraft.model && <option value="">Select a model…</option>}
                      {discoveredModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.display_name || model.id}
                        </option>
                      ))}
                      <option value="__custom__">Custom…</option>
                    </select>
                  </>
                ) : (
                  <>
                    <input
                      id="ai-model"
                      type="text"
                      value={aiDraft.model ?? ""}
                      onChange={(event) => setAiDraft({ model: event.target.value || null })}
                      placeholder="Enter model name"
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
                    />
                    {useCustomModel && discoveredModels.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setUseCustomModel(false)}
                        className="mt-1 text-xs text-accent-foreground hover:text-accent-foreground-hover"
                      >
                        Back to model list
                      </button>
                    )}
                  </>
                )}
                {modelsError && (
                  <p role="status" className="mt-1 text-xs text-on-surface-muted">
                    {modelsError}
                  </p>
                )}
              </div>

              {showBaseUrl && (
                <div>
                  <label
                    htmlFor="ai-base-url"
                    className="mb-1 block text-xs font-medium text-on-surface-secondary"
                  >
                    Base URL
                  </label>
                  <input
                    id="ai-base-url"
                    type="url"
                    value={aiDraft.base_url ?? ""}
                    onChange={(event) => setAiDraft({ base_url: event.target.value || null })}
                    placeholder="https://example.com/v1"
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
                  />
                  <p className="mt-1 text-xs text-on-surface-muted">
                    HTTPS anywhere or loopback HTTP only. No credentials in the URL.
                  </p>
                </div>
              )}

              <label className="flex items-center gap-2 text-sm text-on-surface">
                <input
                  type="checkbox"
                  checked={aiDraft.auto_send}
                  onChange={(event) => setAiDraft({ auto_send: event.target.checked })}
                  className="accent-accent-action"
                />
                Auto-send transcribed text to AI
              </label>

              <label className="flex items-center gap-2 text-sm text-on-surface">
                <input
                  type="checkbox"
                  checked={aiDraft.smart_endpoint}
                  onChange={(event) => setAiDraft({ smart_endpoint: event.target.checked })}
                  className="accent-accent-action"
                />
                Smart endpoint detection
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={saving || !dirty}
                  onClick={handleSaveClick}
                  className={primaryButtonClass(saving || !dirty)}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </>
          )}

          <p
            role="status"
            className={`text-xs ${isConfigured ? "text-success" : "text-on-surface-muted"}`}
          >
            {isConfigured ? "Connected" : "Not configured"}
          </p>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-lg font-semibold text-on-surface">Daily Briefing</h2>
        <p className="mb-3 text-xs text-on-surface-muted">
          Automatically start your morning with a day plan when you open the AI chat.
        </p>
        <div className="max-w-md space-y-3">
          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={aiDraft.daily_briefing_enabled}
              onChange={(event) => setAiDraft({ daily_briefing_enabled: event.target.checked })}
              className="accent-accent-action"
            />
            Auto-show morning briefing
            <span className="text-xs text-on-surface-muted">(5am–12pm)</span>
          </label>
          <div>
            <label
              htmlFor="ai-default-energy"
              className="mb-1 block text-xs font-medium text-on-surface-secondary"
            >
              Default energy level
            </label>
            <select
              id="ai-default-energy"
              value={aiDraft.default_energy?.toString() ?? ""}
              onChange={(event) => {
                const option = ENERGY_OPTIONS.find((item) => item.value === event.target.value);
                setAiDraft({ default_energy: option?.energy ?? null });
              }}
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
            >
              {ENERGY_OPTIONS.map((option) => (
                <option key={option.value || "none"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={saving || !dirty}
            onClick={handleSaveClick}
            className={secondaryButtonClass(saving || !dirty)}
          >
            Save briefing preferences
          </button>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-lg font-semibold text-on-surface">Custom Instructions</h2>
        <p className="mb-3 text-xs text-on-surface-muted">
          Add instructions the AI will always follow. These are injected into every conversation.
        </p>
        <label htmlFor="ai-custom-instructions" className="sr-only">
          Custom Instructions
        </label>
        <textarea
          id="ai-custom-instructions"
          value={aiDraft.custom_instructions}
          rows={4}
          maxLength={CUSTOM_INSTRUCTIONS_MAX}
          onChange={(event) =>
            setAiDraft({
              custom_instructions: event.target.value.slice(0, CUSTOM_INSTRUCTIONS_MAX),
            })
          }
          placeholder="e.g., 'Always suggest time estimates', 'You're a project manager for a software team'"
          className="w-full max-w-lg resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            disabled={saving || !dirty}
            onClick={handleSaveClick}
            className="rounded-lg bg-on-surface px-3 py-1.5 text-xs text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Save
          </button>
          <span className="text-xs text-on-surface-muted">
            {aiDraft.custom_instructions.length}/{CUSTOM_INSTRUCTIONS_MAX}
          </span>
        </div>
      </section>

      <MemoryEditor />

      <ConfirmDialog
        open={confirmProviderSwitch}
        title="Change provider credential?"
        message="The current provider has a stored credential. Changing providers will remove that binding before saving the new configuration."
        confirmLabel="Remove credential and save"
        cancelLabel="Cancel"
        pending={saving}
        onConfirm={() => {
          setConfirmProviderSwitch(false);
          void deleteCredentialThenSave("ai_provider");
        }}
        onCancel={() => setConfirmProviderSwitch(false)}
      />
    </>
  );
}

export default AiTab;
