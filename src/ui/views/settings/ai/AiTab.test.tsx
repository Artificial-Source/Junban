/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfigResponse } from "../../../ai/types";
import { AiTab } from "./AiTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getAiConfig = vi.fn();
const listAiProviders = vi.fn();
const putAiConfig = vi.fn();
const listAiMemories = vi.fn();
const discoverAiProviderModels = vi.fn();

vi.mock("../../../ai/transport", async () => {
  const actual =
    await vi.importActual<typeof import("../../../ai/transport")>("../../../ai/transport");
  return {
    ...actual,
    getAiConfig: (...args: unknown[]) => getAiConfig(...args),
    listAiProviders: (...args: unknown[]) => listAiProviders(...args),
    putAiConfig: (...args: unknown[]) => putAiConfig(...args),
    listAiMemories: (...args: unknown[]) => listAiMemories(...args),
    discoverAiProviderModels: (...args: unknown[]) => discoverAiProviderModels(...args),
    putAiCredential: vi.fn(),
    deleteAiCredential: vi.fn(),
    createAiMemory: vi.fn(),
    updateAiMemory: vi.fn(),
    deleteAiMemory: vi.fn(),
  };
});

const config = (): AiConfigResponse => ({
  ai: {
    enabled: false,
    provider: null,
    model: null,
    base_url: null,
    credential_id: null,
    custom_instructions: "",
    daily_briefing_enabled: false,
    default_energy: null,
    auto_send: false,
    smart_endpoint: false,
  },
  voice: {
    cloud_speech_enabled: false,
    grace_period_ms: 1000,
    stt_provider: "browser",
    stt_model: null,
    stt_credential_id: null,
    tts_provider: "browser",
    tts_model: null,
    tts_voice: null,
    tts_credential_id: null,
    tts_enabled: true,
    voice_mode: "push_to_talk",
  },
  credentials: { ai_provider: null, voice_stt: null, voice_tts: null },
});

describe("AiTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getAiConfig.mockReset().mockResolvedValue(config());
    listAiProviders.mockReset().mockResolvedValue({
      providers: [
        {
          id: "openai",
          display_name: "OpenAI",
          default_base_url: "https://api.openai.com/v1",
          origin_class: "fixed_cloud_https",
          auth_scheme: "bearer",
          credential_required: true,
          capabilities: ["chat_streaming", "model_discovery"],
        },
        {
          id: "custom",
          display_name: "Custom",
          default_base_url: null,
          origin_class: "operator_custom",
          auth_scheme: "bearer",
          credential_required: true,
          capabilities: ["chat_streaming"],
        },
      ],
    });
    listAiMemories.mockReset().mockResolvedValue({ memories: [], next_cursor: null });
    putAiConfig.mockReset();
    discoverAiProviderModels.mockReset();
    window.history.replaceState({}, "", "/settings/ai");
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function mount() {
    await act(async () => {
      root.render(createElement(AiTab));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("renders provider controls and not-configured status", async () => {
    await mount();
    expect(container.querySelector("#ai-provider")).toBeTruthy();
    expect(container.textContent).toContain("Not configured");
    expect(container.textContent).toContain("Memory");
    expect(container.textContent).toContain("Custom Instructions");
    expect(container.textContent).toContain("Daily Briefing");
  });

  it("shows base URL only for Custom provider", async () => {
    await mount();
    const select = container.querySelector("#ai-provider") as HTMLSelectElement;
    await act(async () => {
      select.value = "custom";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("#ai-base-url")).toBeTruthy();
    await act(async () => {
      select.value = "openai";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("#ai-base-url")).toBeNull();
  });

  it("discovers models only after explicit user action", async () => {
    discoverAiProviderModels.mockResolvedValue({
      provider: "openai",
      models: [{ id: "gpt-4.1", display_name: "GPT-4.1", capabilities: [] }],
    });
    await mount();
    const select = container.querySelector("#ai-provider") as HTMLSelectElement;
    await act(async () => {
      select.value = "openai";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(discoverAiProviderModels).not.toHaveBeenCalled();
    const discover = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Discover models"),
    ) as HTMLButtonElement;
    await act(async () => {
      discover.click();
      await Promise.resolve();
    });
    expect(discoverAiProviderModels).toHaveBeenCalledWith("openai");
  });

  it("exposes accessible labels and live status regions", async () => {
    await mount();
    expect(container.querySelector('label[for="ai-provider"]')).toBeTruthy();
    expect(container.querySelector('label[for="ai-custom-instructions"]')).toBeTruthy();
    expect(container.querySelectorAll('[role="status"]').length).toBeGreaterThan(0);
  });

  it("renders configured fixture without network or secret-looking values", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings/ai?visual-fixture=phase-6&settings-ai=configured",
    );
    await mount();
    expect(getAiConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toMatch(/Configured/);
    expect(container.textContent).not.toMatch(/sk-|api_key_value|secret-token/i);
  });
});
