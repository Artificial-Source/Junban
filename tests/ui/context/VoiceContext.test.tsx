import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

// Use vi.hoisted so the mock registry is available inside vi.mock factories (which are hoisted)
const { mockRegistry } = vi.hoisted(() => ({
  mockRegistry: {
    getSTT: vi.fn().mockReturnValue(undefined),
    getTTS: vi.fn().mockReturnValue(undefined),
    listSTT: vi.fn().mockReturnValue([]),
    listTTS: vi.fn().mockReturnValue([]),
    registerSTT: vi.fn(),
    registerTTS: vi.fn(),
  },
}));

// Mock voice dependencies BEFORE importing the context
vi.mock("../../../src/ai/voice/provider.js", () => ({
  createDefaultVoiceRegistry: vi.fn().mockReturnValue(mockRegistry),
}));

vi.mock("../../../src/ai/voice/registry.js", () => ({
  VoiceProviderRegistry: vi.fn().mockImplementation(() => mockRegistry),
}));

vi.mock("../../../src/ai/voice/adapters/browser-tts.js", () => ({
  BrowserTTSProvider: vi.fn(),
}));

vi.mock("../../../src/ai/voice/audio-utils.js", () => ({
  playAudioBuffer: vi.fn().mockReturnValue({
    promise: Promise.resolve(),
    cancel: vi.fn(),
  }),
}));

import { createDefaultVoiceRegistry } from "../../../src/ai/voice/provider.js";
import { VoiceProvider, useVoiceContext } from "../../../src/ui/context/VoiceContext.js";

function TestConsumer() {
  const {
    settings,
    updateSettings,
    registry,
    sttProvider,
    ttsProvider,
    ttsVoices,
    ttsModels,
    isListening,
    isTranscribing,
    isSpeaking,
    startListening,
    stopListening,
    speak,
    cancelSpeech,
  } = useVoiceContext();
  return (
    <div>
      <span data-testid="settings">{JSON.stringify(settings)}</span>
      <span data-testid="stt-provider">{sttProvider ? "set" : "none"}</span>
      <span data-testid="tts-provider">{ttsProvider ? "set" : "none"}</span>
      <span data-testid="voices">{JSON.stringify(ttsVoices)}</span>
      <span data-testid="models">{JSON.stringify(ttsModels)}</span>
      <span data-testid="listening">{String(isListening)}</span>
      <span data-testid="transcribing">{String(isTranscribing)}</span>
      <span data-testid="speaking">{String(isSpeaking)}</span>
      <span data-testid="registry">{registry ? "exists" : "none"}</span>
      <button
        data-testid="update-stt"
        onClick={() => updateSettings({ sttProviderId: "groq-stt" })}
      >
        Change STT
      </button>
      <button data-testid="update-tts-enabled" onClick={() => updateSettings({ ttsEnabled: true })}>
        Enable TTS
      </button>
      <button
        data-testid="update-groq-key"
        onClick={() => updateSettings({ groqApiKey: "gsk_test123" })}
      >
        Set Groq Key
      </button>
      <button data-testid="start-listening" onClick={() => startListening()}>
        Start Listening
      </button>
      <button data-testid="stop-listening" onClick={() => stopListening()}>
        Stop Listening
      </button>
      <button data-testid="speak" onClick={() => speak("Hello world")}>
        Speak
      </button>
      <button data-testid="cancel-speech" onClick={() => cancelSpeech()}>
        Cancel Speech
      </button>
    </div>
  );
}

describe("VoiceContext", () => {
  let mockLocalStorage: Record<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage = {};

    // Mock localStorage
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(
      (key: string) => mockLocalStorage[key] ?? null,
    );
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string, value: string) => {
      mockLocalStorage[key] = value;
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation((key: string) => {
      delete mockLocalStorage[key];
    });

    // Reset mock registry
    mockRegistry.getSTT.mockReturnValue(undefined);
    mockRegistry.getTTS.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when used outside provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow(
      "useVoiceContext must be used within a VoiceProvider",
    );
    spy.mockRestore();
  });

  it("provides default settings on mount", async () => {
    render(
      <VoiceProvider>
        <TestConsumer />
      </VoiceProvider>,
    );

    const settings = JSON.parse(screen.getByTestId("settings").textContent!);
    expect(settings.sttProviderId).toBe("browser-stt");
    expect(settings.ttsProviderId).toBe("browser-tts");
    expect(settings.voiceMode).toBe("push-to-talk");
    expect(settings.ttsEnabled).toBe(false);
    expect(settings.autoSend).toBe(true);
    expect(settings.gracePeriodMs).toBe(1500);
  });

  it("loads settings from localStorage on mount", async () => {
    mockLocalStorage["saydo-voice-settings"] = JSON.stringify({
      sttProviderId: "groq-stt",
      ttsEnabled: true,
      voiceMode: "vad",
    });

    render(
      <VoiceProvider>
        <TestConsumer />
      </VoiceProvider>,
    );

    const settings = JSON.parse(screen.getByTestId("settings").textContent!);
    expect(settings.sttProviderId).toBe("groq-stt");
    expect(settings.ttsEnabled).toBe(true);
    expect(settings.voiceMode).toBe("vad");
    // Defaults still applied for unset fields
    expect(settings.autoSend).toBe(true);
  });

  it("updateSettings persists to localStorage", async () => {
    render(
      <VoiceProvider>
        <TestConsumer />
      </VoiceProvider>,
    );

    act(() => {
      screen.getByTestId("update-stt").click();
    });

    const settings = JSON.parse(screen.getByTestId("settings").textContent!);
    expect(settings.sttProviderId).toBe("groq-stt");

    // Verify localStorage was updated
    expect(mockLocalStorage["saydo-voice-settings"]).toBeDefined();
    const stored = JSON.parse(mockLocalStorage["saydo-voice-settings"]);
    expect(stored.sttProviderId).toBe("groq-stt");
  });

  it("updateSettings with groqApiKey recreates registry", async () => {
    render(
      <VoiceProvider>
        <TestConsumer />
      </VoiceProvider>,
    );

    // The registry is created once on mount
    const initialCallCount = (createDefaultVoiceRegistry as any).mock.calls.length;

    await act(async () => {
      screen.getByTestId("update-groq-key").click();
    });

    // Registry should be recreated with the new key via useMemo
    await waitFor(() => {
      expect((createDefaultVoiceRegistry as any).mock.calls.length).toBeGreaterThan(
        initialCallCount,
      );
    });

    const lastCall = (createDefaultVoiceRegistry as any).mock.calls.at(-1);
    expect(lastCall[0]).toEqual(expect.objectContaining({ groqApiKey: "gsk_test123" }));
  });

  it("startListening sets isListening to true", async () => {
    render(
      <VoiceProvider>
        <TestConsumer />
      </VoiceProvider>,
    );

    expect(screen.getByTestId("listening").textContent).toBe("false");

    act(() => {
      screen.getByTestId("start-listening").click();
    });

    expect(screen.getByTestId("listening").textContent).toBe("true");
  });

  it("stopListening sets isListening to false", async () => {
    render(
      <VoiceProvider>
        <TestConsumer />
      </VoiceProvider>,
    );

    act(() => {
      screen.getByTestId("start-listening").click();
    });

    expect(screen.getByTestId("listening").textContent).toBe("true");

    act(() => {
      screen.getByTestId("stop-listening").click();
    });

    expect(screen.getByTestId("listening").textContent).toBe("false");
  });

  it("speak does nothing when TTS is disabled", async () => {
    render(
      <VoiceProvider>
        <TestConsumer />
      </VoiceProvider>,
    );

    await act(async () => {
      screen.getByTestId("speak").click();
    });

    // isSpeaking should remain false since ttsEnabled is false by default
    expect(screen.getByTestId("speaking").textContent).toBe("false");
  });

  it("cancelSpeech sets isSpeaking to false and cancels window.speechSynthesis", async () => {
    // Mock speechSynthesis
    const cancelMock = vi.fn();
    Object.defineProperty(window, "speechSynthesis", {
      value: { cancel: cancelMock },
      writable: true,
      configurable: true,
    });

    render(
      <VoiceProvider>
        <TestConsumer />
      </VoiceProvider>,
    );

    act(() => {
      screen.getByTestId("cancel-speech").click();
    });

    expect(screen.getByTestId("speaking").textContent).toBe("false");
    expect(cancelMock).toHaveBeenCalled();
  });

  it("creates registry with correct config", async () => {
    render(
      <VoiceProvider>
        <TestConsumer />
      </VoiceProvider>,
    );

    expect(screen.getByTestId("registry").textContent).toBe("exists");
    expect(createDefaultVoiceRegistry).toHaveBeenCalled();
  });

  it("fetches TTS voices when provider changes", async () => {
    const mockVoices = [{ id: "v1", name: "Voice 1" }];
    const mockTTSProvider = {
      id: "browser-tts",
      name: "Browser TTS",
      getVoices: vi.fn().mockResolvedValue(mockVoices),
      getModels: vi.fn().mockResolvedValue([]),
    };
    mockRegistry.getTTS.mockReturnValue(mockTTSProvider);

    render(
      <VoiceProvider>
        <TestConsumer />
      </VoiceProvider>,
    );

    await waitFor(() => {
      const voices = JSON.parse(screen.getByTestId("voices").textContent!);
      expect(voices.length).toBe(1);
      expect(voices[0].name).toBe("Voice 1");
    });
  });

  it("fetches TTS models when provider changes", async () => {
    const mockModels = [{ id: "m1", name: "Model 1" }];
    const mockTTSProvider = {
      id: "browser-tts",
      name: "Browser TTS",
      getVoices: vi.fn().mockResolvedValue([]),
      getModels: vi.fn().mockResolvedValue(mockModels),
    };
    mockRegistry.getTTS.mockReturnValue(mockTTSProvider);

    render(
      <VoiceProvider>
        <TestConsumer />
      </VoiceProvider>,
    );

    await waitFor(() => {
      const models = JSON.parse(screen.getByTestId("models").textContent!);
      expect(models.length).toBe(1);
      expect(models[0].name).toBe("Model 1");
    });
  });
});
