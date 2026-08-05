/**
 * @vitest-environment jsdom
 */
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfigResponse, AiProviderRegistryResponse } from "../../../ai/types";
import { useAiConfigController, type UseAiConfigControllerResult } from "./useAiConfigController";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getAiConfig = vi.fn();
const listAiProviders = vi.fn();
const putAiConfig = vi.fn();
const putAiCredential = vi.fn();
const deleteAiCredential = vi.fn();
const discoverAiProviderModels = vi.fn();

vi.mock("../../../ai/transport", async () => {
  const actual =
    await vi.importActual<typeof import("../../../ai/transport")>("../../../ai/transport");
  return {
    ...actual,
    getAiConfig: (...args: unknown[]) => getAiConfig(...args),
    listAiProviders: (...args: unknown[]) => listAiProviders(...args),
    putAiConfig: (...args: unknown[]) => putAiConfig(...args),
    putAiCredential: (...args: unknown[]) => putAiCredential(...args),
    deleteAiCredential: (...args: unknown[]) => deleteAiCredential(...args),
    discoverAiProviderModels: (...args: unknown[]) => discoverAiProviderModels(...args),
  };
});

const baseConfig = (): AiConfigResponse => ({
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
  credentials: {
    ai_provider: null,
    voice_stt: null,
    voice_tts: null,
  },
});

const registry = (): AiProviderRegistryResponse => ({
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
      id: "ollama",
      display_name: "Ollama",
      default_base_url: "http://127.0.0.1:11434/v1",
      origin_class: "loopback",
      auth_scheme: "none",
      credential_required: false,
      capabilities: ["chat_streaming", "model_discovery"],
    },
  ],
});

function Probe({ onReady }: { onReady: (value: UseAiConfigControllerResult) => void }) {
  const value = useAiConfigController();
  useEffect(() => {
    onReady(value);
  }, [onReady, value]);
  return createElement("div", {
    "data-loading": String(value.loading),
    "data-configured": String(value.isConfigured),
  });
}

describe("useAiConfigController", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: UseAiConfigControllerResult | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    latest = null;
    getAiConfig.mockReset();
    listAiProviders.mockReset();
    putAiConfig.mockReset();
    putAiCredential.mockReset();
    deleteAiCredential.mockReset();
    discoverAiProviderModels.mockReset();
    window.history.replaceState({}, "", "/settings/ai");
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    window.history.replaceState({}, "", "/");
  });

  async function mount() {
    await act(async () => {
      root.render(
        createElement(Probe, {
          onReady: (value) => {
            latest = value;
          },
        }),
      );
    });
    // Allow effects + promises
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("loads confirmed config without applying drafts to configured state", async () => {
    getAiConfig.mockResolvedValue(baseConfig());
    listAiProviders.mockResolvedValue(registry());
    await mount();
    expect(latest?.loading).toBe(false);
    expect(latest?.isConfigured).toBe(false);
    expect(getAiConfig).toHaveBeenCalledTimes(1);

    await act(async () => {
      latest?.setAiDraft({
        enabled: true,
        provider: "openai",
        model: "gpt-4.1",
      });
    });
    expect(latest?.dirty).toBe(true);
    expect(latest?.isConfigured).toBe(false);
  });

  it("saves full ai+voice body and refetches confirmed config", async () => {
    const initial = baseConfig();
    const saved: AiConfigResponse = {
      ...initial,
      ai: {
        ...initial.ai,
        enabled: true,
        provider: "ollama",
        model: "llama3",
      },
    };
    getAiConfig.mockResolvedValueOnce(initial).mockResolvedValueOnce(saved);
    listAiProviders.mockResolvedValue(registry());
    putAiConfig.mockResolvedValue(saved);

    await mount();
    await act(async () => {
      latest?.setAiDraft({
        enabled: true,
        provider: "ollama",
        model: "llama3",
      });
    });
    let ok = false;
    await act(async () => {
      ok = (await latest?.save()) ?? false;
    });
    expect(ok).toBe(true);
    expect(putAiConfig).toHaveBeenCalledTimes(1);
    const body = putAiConfig.mock.calls[0]?.[0];
    expect(body.ai.provider).toBe("ollama");
    expect(body.voice.stt_provider).toBe("browser");
    expect(putAiConfig.mock.calls[0]?.[1]?.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(getAiConfig).toHaveBeenCalledTimes(2);
    expect(latest?.isConfigured).toBe(true);
  });

  it("retains draft on save failure", async () => {
    getAiConfig.mockResolvedValue(baseConfig());
    listAiProviders.mockResolvedValue(registry());
    putAiConfig.mockRejectedValue(new Error("server rejected"));
    await mount();
    await act(async () => {
      latest?.setAiDraft({ enabled: true, provider: "ollama", model: "x" });
    });
    await act(async () => {
      await latest?.save();
    });
    expect(latest?.error).toBeTruthy();
    expect(latest?.aiDraft?.model).toBe("x");
    expect(latest?.dirty).toBe(true);
  });

  it("requires credential delete before provider switch save", async () => {
    const configured = baseConfig();
    configured.ai = {
      ...configured.ai,
      enabled: true,
      provider: "openai",
      model: "gpt-4.1",
      credential_id: "00000000-0000-4000-8000-000000000001",
    };
    configured.credentials.ai_provider = {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "api_key",
      present: true,
      updated_at: "2026-08-02T15:00:00.000Z",
    };
    getAiConfig.mockResolvedValue(configured);
    listAiProviders.mockResolvedValue(registry());
    await mount();
    await act(async () => {
      latest?.setAiDraft({ provider: "ollama", model: "llama3" });
    });
    expect(latest?.providerCredentialSwitchRequired).toBe(true);
    await act(async () => {
      await latest?.save();
    });
    expect(putAiConfig).not.toHaveBeenCalled();
    expect(latest?.error).toMatch(/credential/i);
  });

  it("deletes prior credential then saves with a fresh operation id per step", async () => {
    const configured = baseConfig();
    configured.ai = {
      ...configured.ai,
      enabled: true,
      provider: "openai",
      model: "gpt-4.1",
    };
    configured.credentials.ai_provider = {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "api_key",
      present: true,
      updated_at: "2026-08-02T15:00:00.000Z",
    };
    const after: AiConfigResponse = {
      ...configured,
      ai: { ...configured.ai, provider: "ollama", model: "llama3", credential_id: null },
      credentials: { ...configured.credentials, ai_provider: null },
    };
    getAiConfig.mockResolvedValueOnce(configured).mockResolvedValueOnce(after);
    listAiProviders.mockResolvedValue(registry());
    deleteAiCredential.mockResolvedValue({ target: "ai_provider", credential: null });
    putAiConfig.mockResolvedValue(after);

    await mount();
    await act(async () => {
      latest?.setAiDraft({ provider: "ollama", model: "llama3" });
    });
    await act(async () => {
      await latest?.deleteCredentialThenSave("ai_provider");
    });
    expect(deleteAiCredential).toHaveBeenCalledTimes(1);
    expect(putAiConfig).toHaveBeenCalledTimes(1);
    const deleteOp = deleteAiCredential.mock.calls[0]?.[1]?.operationId;
    const saveOp = putAiConfig.mock.calls[0]?.[1]?.operationId;
    expect(deleteOp).toBeTruthy();
    expect(saveOp).toBeTruthy();
    expect(deleteOp).not.toBe(saveOp);
  });

  it("submits write-only credentials without retaining secret in draft state", async () => {
    getAiConfig.mockResolvedValueOnce(baseConfig()).mockResolvedValueOnce({
      ...baseConfig(),
      credentials: {
        ai_provider: {
          id: "00000000-0000-4000-8000-000000000099",
          kind: "api_key",
          present: true,
          updated_at: "2026-08-02T15:00:00.000Z",
        },
        voice_stt: null,
        voice_tts: null,
      },
    });
    listAiProviders.mockResolvedValue(registry());
    putAiCredential.mockResolvedValue({
      target: "ai_provider",
      credential: {
        id: "00000000-0000-4000-8000-000000000099",
        kind: "api_key",
        present: true,
        updated_at: "2026-08-02T15:00:00.000Z",
      },
    });
    await mount();
    let seenSecret: string | undefined;
    putAiCredential.mockImplementation(async (_target, body) => {
      seenSecret = body.secret;
      return {
        target: "ai_provider",
        credential: {
          id: "00000000-0000-4000-8000-000000000099",
          kind: "api_key",
          present: true,
          updated_at: "2026-08-02T15:00:00.000Z",
        },
      };
    });
    await act(async () => {
      await latest?.submitCredential("ai_provider", {
        kind: "api_key",
        secret: "sk-test-secret-value",
      });
    });
    expect(putAiCredential).toHaveBeenCalledTimes(1);
    expect(putAiCredential.mock.calls[0]?.[0]).toBe("ai_provider");
    expect(putAiCredential.mock.calls[0]?.[1]?.kind).toBe("api_key");
    expect(seenSecret).toBe("sk-test-secret-value");
    expect(putAiCredential.mock.calls[0]?.[2]?.operationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(latest)).not.toContain("sk-test-secret-value");
    expect(latest?.confirmed?.credentials.ai_provider?.present).toBe(true);
  });

  it("discovers models only on user action", async () => {
    getAiConfig.mockResolvedValue({
      ...baseConfig(),
      ai: { ...baseConfig().ai, provider: "openai", enabled: true },
    });
    listAiProviders.mockResolvedValue(registry());
    discoverAiProviderModels.mockResolvedValue({
      provider: "openai",
      models: [{ id: "gpt-4.1", display_name: "GPT-4.1", capabilities: [] }],
    });
    await mount();
    expect(discoverAiProviderModels).not.toHaveBeenCalled();
    await act(async () => {
      latest?.setAiDraft({ provider: "openai" });
      await latest?.discoverModels();
    });
    expect(discoverAiProviderModels).toHaveBeenCalledWith("openai");
    expect(latest?.discoveredModels[0]?.id).toBe("gpt-4.1");
  });

  it("uses presentation fixture without network when query requests it", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings/ai?visual-fixture=phase-6&settings-ai=configured",
    );
    await mount();
    expect(getAiConfig).not.toHaveBeenCalled();
    expect(latest?.isConfigured).toBe(true);
    expect(latest?.confirmed?.ai.provider).toBe("openai");
    expect(JSON.stringify(latest?.confirmed)).not.toMatch(/sk-|secret/i);
  });
});
