/**
 * Phase 6 AI Settings visual fixture — legacy presentation shape.
 * Uses the same labels/hierarchy as the immutable capture; no network.
 */

import { useState } from "react";
import type { AiSettingsVisualState } from "../../views/settings/ai/aiFixture";
import { fixtureAiConfig, fixtureAiProviders } from "../../views/settings/ai/aiFixture";

export function Phase6SettingsAiScene({ state }: { state: AiSettingsVisualState }) {
  const config = fixtureAiConfig(state);
  const providers = fixtureAiProviders();
  const [provider, setProvider] = useState(config.ai.provider ?? "");
  const [model, setModel] = useState(config.ai.model ?? "");
  const [authType, setAuthType] = useState<"api-key" | "oauth">("api-key");
  const [briefing, setBriefing] = useState(true);
  const [energy, setEnergy] = useState("medium");
  const [instructions, setInstructions] = useState(config.ai.custom_instructions);
  const hasKey = Boolean(config.credentials.ai_provider?.present);
  const configured = state === "configured";

  return (
    <>
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3 text-on-surface">AI Assistant</h2>

        <div className="space-y-4 max-w-md">
          <div>
            <label
              htmlFor="ai-provider"
              className="block text-xs font-medium text-on-surface-secondary mb-1"
            >
              Provider
            </label>
            <select
              id="ai-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
            >
              <option value="">None (disabled)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </div>

          {provider && (
            <>
              <div className="mb-3">
                <p className="block text-xs font-medium text-on-surface-secondary mb-1">
                  Authentication
                </p>
                <div className="inline-flex rounded-lg bg-surface-secondary p-0.5 gap-0.5">
                  <button
                    type="button"
                    onClick={() => setAuthType("api-key")}
                    className={`px-3 py-1.5 text-xs rounded-md ${
                      authType === "api-key"
                        ? "bg-surface text-on-surface shadow-sm"
                        : "text-on-surface-muted"
                    }`}
                  >
                    API Key
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthType("oauth")}
                    className={`px-3 py-1.5 text-xs rounded-md ${
                      authType === "oauth"
                        ? "bg-surface text-on-surface shadow-sm"
                        : "text-on-surface-muted"
                    }`}
                  >
                    OAuth Token
                  </button>
                </div>
              </div>

              {authType === "api-key" ? (
                <div>
                  <label
                    htmlFor="ai-api-key"
                    className="block text-xs font-medium text-on-surface-secondary mb-1"
                  >
                    API Key
                    {hasKey && <span className="font-normal text-success ml-2">Set</span>}
                  </label>
                  <input
                    id="ai-api-key"
                    type="password"
                    value=""
                    readOnly
                    placeholder={hasKey ? "Enter new key to update" : "Enter API key"}
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
                  />
                  <p className="mt-1 text-xs text-on-surface-muted">
                    Get your API key at platform.openai.com.
                  </p>
                </div>
              ) : (
                <div>
                  <label
                    htmlFor="ai-oauth-token"
                    className="block text-xs font-medium text-on-surface-secondary mb-1"
                  >
                    OAuth Token
                  </label>
                  <input
                    id="ai-oauth-token"
                    type="password"
                    value=""
                    readOnly
                    placeholder="Paste your OAuth token"
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
                  />
                </div>
              )}

              <div>
                <label
                  htmlFor="ai-model"
                  className="block text-xs font-medium text-on-surface-secondary mb-1"
                >
                  Model
                </label>
                <select
                  id="ai-model"
                  value={model || "gpt-4o"}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
                >
                  <option value="gpt-4o">GPT-4o</option>
                  <option value="gpt-4o-mini">GPT-4o mini</option>
                </select>
              </div>

              <button
                type="button"
                className="rounded-lg bg-accent-action px-4 py-2 text-sm font-medium text-on-accent-action"
              >
                Save
              </button>

              <p
                role="status"
                className={`text-xs ${configured ? "text-success" : "text-on-surface-muted"}`}
              >
                {configured ? "Connected" : "Not configured"}
              </p>
            </>
          )}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-1 text-on-surface">Daily Briefing</h2>
        <p className="text-xs text-on-surface-muted mb-3">
          Automatically start your morning with a day plan when you open the AI chat.
        </p>
        <div className="space-y-3 max-w-md">
          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={briefing}
              onChange={(e) => setBriefing(e.target.checked)}
            />
            Auto-show morning briefing
            <span className="text-xs text-on-surface-muted">(5am-12pm)</span>
          </label>

          <div className="flex items-center gap-3">
            <label
              htmlFor="ai-default-energy"
              className="text-xs font-medium text-on-surface-secondary"
            >
              Default energy level
            </label>
            <select
              id="ai-default-energy"
              value={energy}
              onChange={(e) => setEnergy(e.target.value)}
              className="px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-1 text-on-surface">Custom Instructions</h2>
        <p className="text-xs text-on-surface-muted mb-3">
          Add instructions the AI will always follow. These are injected into every conversation.
        </p>
        <label htmlFor="ai-custom-instructions" className="sr-only">
          Custom Instructions
        </label>
        {/* Visible label matching legacy capture hierarchy */}
        <p className="block text-xs font-medium text-on-surface-secondary mb-1">
          Custom Instructions
        </p>
        <textarea
          id="ai-custom-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value.slice(0, 2000))}
          placeholder="e.g., 'Always suggest time estimates', 'You're a project manager for a software team', 'Respond in Spanish'"
          rows={4}
          className="w-full max-w-lg px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface resize-none"
        />
        <div className="flex items-center gap-3 mt-2">
          <button
            type="button"
            className="rounded-lg bg-on-surface px-3 py-1.5 text-xs text-surface transition-opacity hover:opacity-90"
          >
            Save
          </button>
          <span className="text-xs text-on-surface-muted">{instructions.length}/2000</span>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold text-on-surface mb-3">Memory</h2>
        <p className="text-sm text-on-surface-muted">
          No memories yet. The AI will remember important things you share in conversations.
        </p>
      </section>
    </>
  );
}
