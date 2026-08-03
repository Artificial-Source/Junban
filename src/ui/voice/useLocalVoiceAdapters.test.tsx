/**
 * @vitest-environment jsdom
 */
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_VOICE_PREFERENCES_STORAGE_KEY,
  resetLocalVoicePreferencesSnapshot,
  writeLocalVoicePreferences,
} from "./localPreferences";
import {
  useLocalVoiceAdapters,
  type UseLocalVoiceAdaptersOptions,
  type UseLocalVoiceAdaptersResult,
} from "./useLocalVoiceAdapters";
import type { ConfirmedVoiceSettings } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createLocalWhisperAdapter = vi.fn();
const createLocalTtsAdapter = vi.fn();

vi.mock("./local-adapters", () => ({
  createLocalWhisperAdapter: (...args: unknown[]) => createLocalWhisperAdapter(...args),
  createLocalTtsAdapter: (...args: unknown[]) => createLocalTtsAdapter(...args),
}));

const browserSettings: ConfirmedVoiceSettings = {
  cloud_speech_enabled: false,
  grace_period_ms: 500,
  stt_provider: "browser",
  stt_model: null,
  tts_provider: "browser",
  tts_model: null,
  tts_voice: null,
  stt_credential_id: null,
  tts_credential_id: null,
  tts_enabled: true,
  voice_mode: "push_to_talk",
};

function mockSttOwner(packageId = "whisper-tiny.en-q4") {
  let status: "loading" | "ready" | "unavailable" | "error" = "loading";
  const dispose = vi.fn(() => {
    status = "unavailable";
  });
  return {
    packageId,
    get status() {
      return status;
    },
    set status(next: typeof status) {
      status = next;
    },
    prepare: vi.fn(async () => {
      status = "ready";
    }),
    transcribe: vi.fn(async () => "ok"),
    dispose,
  };
}

function mockTtsOwner(packageId = "kokoro-82m-v1-q8") {
  let status: "loading" | "ready" | "unavailable" | "error" = "loading";
  const dispose = vi.fn(() => {
    status = "unavailable";
  });
  return {
    packageId,
    get status() {
      return status;
    },
    set status(next: typeof status) {
      status = next;
    },
    prepare: vi.fn(async () => {
      status = "ready";
    }),
    speak: vi.fn(async () => undefined),
    cancel: vi.fn(),
    dispose,
  };
}

function Harness({
  options,
  onValue,
}: {
  options: UseLocalVoiceAdaptersOptions;
  onValue: (value: UseLocalVoiceAdaptersResult) => void;
}) {
  const value = useLocalVoiceAdapters(options);
  useEffect(() => {
    onValue(value);
  }, [onValue, value]);
  return null;
}

describe("useLocalVoiceAdapters", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: UseLocalVoiceAdaptersResult | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    latest = null;
    localStorage.clear();
    resetLocalVoicePreferencesSnapshot();
    createLocalWhisperAdapter.mockReset();
    createLocalTtsAdapter.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    resetLocalVoicePreferencesSnapshot();
  });

  async function render(options: UseLocalVoiceAdaptersOptions) {
    await act(async () => {
      root.render(
        createElement(Harness, {
          options,
          onValue: (v) => {
            latest = v;
          },
        }),
      );
    });
    // Flush dynamic import() of local-adapters + prepare().
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it("does not construct local adapters when cloud is confirmed", async () => {
    writeLocalVoicePreferences({
      version: 1,
      stt: "whisper-tiny.en-q4",
      tts: "kokoro-82m-v1-q8",
    });
    await render({
      enabled: true,
      settings: {
        ...browserSettings,
        cloud_speech_enabled: true,
        stt_provider: "openai",
        tts_provider: "groq",
      },
    });
    expect(createLocalWhisperAdapter).not.toHaveBeenCalled();
    expect(createLocalTtsAdapter).not.toHaveBeenCalled();
    expect(latest?.localStt).toBeNull();
    expect(latest?.localTts).toBeNull();
  });

  it("does not construct adapters when preference is browser", async () => {
    await render({ enabled: true, settings: browserSettings });
    expect(createLocalWhisperAdapter).not.toHaveBeenCalled();
    expect(latest?.localStt).toBeNull();
  });

  it("constructs adapters only for explicit local preference under browser provider", async () => {
    const sttOwner = mockSttOwner();
    const ttsOwner = mockTtsOwner();
    createLocalWhisperAdapter.mockImplementation(() => sttOwner);
    createLocalTtsAdapter.mockImplementation(() => ttsOwner);
    writeLocalVoicePreferences({
      version: 1,
      stt: "whisper-tiny.en-q4",
      tts: "kokoro-82m-v1-q8",
    });

    await render({ enabled: true, settings: browserSettings });
    expect({
      whisperCalls: createLocalWhisperAdapter.mock.calls.length,
      ttsCalls: createLocalTtsAdapter.mock.calls.length,
      sttStatus: latest?.sttStatus,
      ttsStatus: latest?.ttsStatus,
      localStt: latest?.localStt?.status ?? null,
      localTts: latest?.localTts?.status ?? null,
      prefs: localStorage.getItem(LOCAL_VOICE_PREFERENCES_STORAGE_KEY),
    }).toEqual({
      whisperCalls: 1,
      ttsCalls: 1,
      sttStatus: "ready",
      ttsStatus: "ready",
      localStt: "ready",
      localTts: "ready",
      prefs: JSON.stringify({
        version: 1,
        stt: "whisper-tiny.en-q4",
        tts: "kokoro-82m-v1-q8",
      }),
    });
    expect(sttOwner.prepare).toHaveBeenCalled();
    expect(ttsOwner.prepare).toHaveBeenCalled();
  });

  it("disposes adapters when selection returns to browser", async () => {
    const sttOwner = mockSttOwner();
    createLocalWhisperAdapter.mockReturnValue(sttOwner);
    writeLocalVoicePreferences({
      version: 1,
      stt: "whisper-tiny.en-q4",
      tts: "browser",
    });
    await render({ enabled: true, settings: browserSettings });
    expect(sttOwner.prepare).toHaveBeenCalled();

    await act(async () => {
      writeLocalVoicePreferences({ version: 1, stt: "browser", tts: "browser" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sttOwner.dispose).toHaveBeenCalled();
    expect(latest?.localStt).toBeNull();
  });

  it("keeps module graph inert when disabled/fixture", async () => {
    writeLocalVoicePreferences({
      version: 1,
      stt: "whisper-tiny.en-q4",
      tts: "kokoro-82m-v1-q8",
    });
    await render({ enabled: false, settings: browserSettings });
    expect(createLocalWhisperAdapter).not.toHaveBeenCalled();
    expect(localStorage.getItem(LOCAL_VOICE_PREFERENCES_STORAGE_KEY)).toContain("whisper");
  });
});
