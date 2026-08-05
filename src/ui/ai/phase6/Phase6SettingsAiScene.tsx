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

  // Unconfigured capture is denser. Configured keeps a roomy provider block (mb-8) so
  // Daily Briefing stays near the frozen row, then packs Custom/Memory tightly so the
  // Memory footer remains on-canvas with the wide instructions field.
  const sectionMb = configured ? "mb-8" : "mb-1";
  const sectionMbBriefing = configured ? "mb-0" : "mb-2";
  const sectionMbCustom = configured ? "mb-0" : "mb-2";

  return (
    <>
      <section className={sectionMb}>
        <h2
          className={
            configured
              ? "text-lg font-bold mb-2 text-on-surface"
              : "text-lg font-semibold mb-2 text-on-surface"
          }
          style={configured ? { letterSpacing: "-0.009em" } : undefined}
        >
          AI Assistant
        </h2>

        <div className="space-y-3 max-w-md">
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
              <div
                className="mb-1"
                style={configured ? { marginTop: -11, paddingBottom: 11 } : undefined}
              >
                <p className="block text-xs font-medium text-on-surface-secondary mb-1">
                  Authentication
                </p>
                <div
                  className={
                    configured
                      ? "flex items-center gap-4 rounded-lg bg-surface-secondary px-3 py-1.5 w-full"
                      : "inline-flex items-center gap-4 rounded-lg bg-surface-secondary px-3 py-1.5"
                  }
                >
                  <label className="flex items-center gap-1.5 text-sm text-on-surface">
                    <input
                      type="radio"
                      name="ai-auth-type"
                      checked={authType === "api-key"}
                      onChange={() => setAuthType("api-key")}
                    />
                    API Key
                  </label>
                  <label className="flex items-center gap-1.5 text-sm text-on-surface">
                    <input
                      type="radio"
                      name="ai-auth-type"
                      checked={authType === "oauth"}
                      onChange={() => setAuthType("oauth")}
                    />
                    OAuth Token
                  </label>
                </div>
              </div>

              {authType === "api-key" ? (
                <div>
                  <label
                    htmlFor="ai-api-key"
                    className="block text-xs font-medium text-on-surface-secondary mb-1"
                  >
                    {hasKey
                      ? [
                          "API Key",
                          <span
                            key="set"
                            className={
                              configured
                                ? "font-normal text-on-surface-secondary"
                                : "ml-2 font-normal text-success"
                            }
                          >
                            {configured ? "Set" : " Set"}
                          </span>,
                        ]
                      : "API Key"}
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

              <button type="button" className="px-0 py-2 text-sm text-on-surface">
                Save
              </button>

              <p
                role="status"
                className={configured ? "text-xs text-success" : "text-xs text-on-surface"}
              >
                {configured ? "Connected" : "Not configured"}
              </p>
            </>
          )}
        </div>
      </section>

      <section className={sectionMbBriefing}>
        <h2 className="text-lg font-semibold mb-1 text-on-surface">Daily Briefing</h2>
        <p className="text-xs text-on-surface-muted mb-2">
          Automatically start your morning with a day plan when you open the AI chat.
        </p>
        <div className="space-y-2 max-w-md">
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

      <section className={sectionMbCustom}>
        <h2 className="text-lg font-semibold mb-1 text-on-surface">Custom Instructions</h2>
        <p className="text-xs text-on-surface-muted mb-2">
          Add instructions the AI will always follow. These are injected into every conversation.
        </p>
        <label
          htmlFor="ai-custom-instructions"
          className={
            configured ? "block text-xs font-medium text-on-surface-secondary mb-1" : "sr-only"
          }
        >
          Custom Instructions
        </label>
        {!configured && (
          <p className="block text-xs font-medium text-on-surface-secondary mb-1">
            Custom Instructions
          </p>
        )}
        <textarea
          id="ai-custom-instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value.slice(0, 2000))}
          placeholder="e.g., 'Always suggest time estimates', 'You're a project manager for a software team', 'Respond in Spanish'"
          rows={4}
          className={
            configured
              ? "w-full px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
              : "w-full max-w-2xl px-3 py-2 text-sm border border-border rounded-lg bg-surface text-on-surface"
          }
        />
        <div className="flex items-center gap-3 mt-1">
          <button type="button" className="px-0 py-1 text-xs text-on-surface">
            Save
          </button>
          <span className="text-xs text-on-surface-muted">{instructions.length}/2000</span>
        </div>
      </section>

      <section className="mb-2">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold text-on-surface">Memory</h2>
        </div>
        <p className="text-sm text-on-surface-muted">
          No memories yet. The AI will remember important things you share in conversations.
        </p>
      </section>
    </>
  );
}
