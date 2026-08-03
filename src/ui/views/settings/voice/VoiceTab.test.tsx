/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfigResponse } from "../../../ai/types";
import { VoiceTab } from "./VoiceTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getAiConfig = vi.fn();
const listAiProviders = vi.fn();

vi.mock("../../../ai/transport", async () => {
  const actual =
    await vi.importActual<typeof import("../../../ai/transport")>("../../../ai/transport");
  return {
    ...actual,
    getAiConfig: (...args: unknown[]) => getAiConfig(...args),
    listAiProviders: (...args: unknown[]) => listAiProviders(...args),
    putAiConfig: vi.fn(),
    putAiCredential: vi.fn(),
    deleteAiCredential: vi.fn(),
    discoverAiProviderModels: vi.fn(),
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

describe("VoiceTab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getAiConfig.mockReset().mockResolvedValue(config());
    listAiProviders.mockReset().mockResolvedValue({ providers: [] });
    window.history.replaceState({}, "", "/settings/voice");
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function mount() {
    await act(async () => {
      root.render(createElement(VoiceTab));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("renders browser privacy warning and STT/TTS filters", async () => {
    await mount();
    expect(container.textContent).toMatch(/browser vendor cloud service/i);
    const stt = container.querySelector("#voice-stt-provider") as HTMLSelectElement;
    const tts = container.querySelector("#voice-tts-provider") as HTMLSelectElement;
    const sttValues = Array.from(stt.options).map((option) => option.value);
    const ttsValues = Array.from(tts.options).map((option) => option.value);
    expect(sttValues).toEqual(["browser", "openai", "groq"]);
    expect(sttValues).not.toContain("inworld");
    expect(ttsValues).toEqual(["browser", "openai", "groq", "inworld"]);
  });

  it("shows local model manifest metadata and browser selection controls", async () => {
    await mount();
    // Allow dynamic local module + status refresh.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Local Models");
    expect(container.textContent).toMatch(/Whisper|Kokoro|Piper/i);
    expect(container.textContent).toMatch(/License/);
    expect(container.textContent).toMatch(/Browser speech/i);
    expect(container.querySelector("#local-stt-selection")).toBeTruthy();
    expect(container.querySelector("#local-tts-selection")).toBeTruthy();
    expect(container.textContent).not.toMatch(/connect in a later wave/i);
  });

  it("keeps microphone gated behind explicit permission control", async () => {
    await mount();
    expect(container.textContent).toMatch(/Allow microphone access/);
    expect(container.querySelector("#microphone")).toBeNull();
  });

  it("renders cloud fixture without network or secret values", async () => {
    window.history.replaceState(
      {},
      "",
      "/settings/voice?visual-fixture=phase-6&settings-voice=cloud",
    );
    await mount();
    expect(getAiConfig).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/Configured/);
    expect(container.textContent).not.toMatch(/sk-|secret-token/i);
    const stt = container.querySelector("#voice-stt-provider") as HTMLSelectElement;
    expect(stt.value).toBe("groq");
  });

  it("does not statically import local engine packages from the tab module", async () => {
    const source = (await import("./VoiceTab.tsx?raw")).default as string;
    expect(source).not.toMatch(/@huggingface\/transformers|kokoro-js|piper-tts-web|vad-web/);
    expect(source).not.toMatch(/voice\/local\/engines|worker-host/);
  });
});
