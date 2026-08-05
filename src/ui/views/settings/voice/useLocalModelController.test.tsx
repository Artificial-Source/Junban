/**
 * @vitest-environment jsdom
 */
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readLocalVoicePreferences,
  resetLocalVoicePreferencesSnapshot,
  writeLocalVoicePreferences,
} from "../../../voice/localPreferences";
import {
  useLocalModelController,
  type UseLocalModelControllerResult,
} from "./useLocalModelController";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getAllLocalEngineStatuses = vi.fn();
const downloadLocalEnginePackage = vi.fn();
const removeLocalEnginePackage = vi.fn();

vi.mock("../../../voice/local/index", () => ({
  getAllLocalEngineStatuses: (...args: unknown[]) => getAllLocalEngineStatuses(...args),
  downloadLocalEnginePackage: (...args: unknown[]) => downloadLocalEnginePackage(...args),
  removeLocalEnginePackage: (...args: unknown[]) => removeLocalEnginePackage(...args),
}));

function Harness({ onValue }: { onValue: (value: UseLocalModelControllerResult) => void }) {
  const value = useLocalModelController();
  useEffect(() => {
    onValue(value);
  }, [onValue, value]);
  return null;
}

describe("useLocalModelController", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: UseLocalModelControllerResult | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    latest = null;
    localStorage.clear();
    resetLocalVoicePreferencesSnapshot();
    getAllLocalEngineStatuses.mockReset().mockResolvedValue([
      { packageId: "whisper-tiny.en-q4", verified: false },
      { packageId: "kokoro-82m-v1-q8", verified: true },
      { packageId: "piper-en_US-ljspeech-medium", verified: false },
    ]);
    downloadLocalEnginePackage.mockReset().mockResolvedValue({});
    removeLocalEnginePackage.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    resetLocalVoicePreferencesSnapshot();
  });

  async function mount() {
    await act(async () => {
      root.render(
        createElement(Harness, {
          onValue: (v) => {
            latest = v;
          },
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("loads local module after mount and reports verified status without workers", async () => {
    const workerSpy = vi.fn();
    vi.stubGlobal(
      "Worker",
      class {
        constructor(...args: unknown[]) {
          workerSpy(...args);
        }
      },
    );
    await mount();
    expect(getAllLocalEngineStatuses).toHaveBeenCalled();
    expect(latest?.getStatus?.("kokoro-82m-v1-q8")).toBe("ready");
    expect(latest?.getStatus?.("whisper-tiny.en-q4")).toBe("not_loaded");
    expect(workerSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("consent load downloads package and selects it", async () => {
    await mount();
    await act(async () => {
      await latest?.onConsentLoad?.("whisper-tiny.en-q4");
    });
    expect(downloadLocalEnginePackage).toHaveBeenCalledWith(
      "whisper-tiny.en-q4",
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(readLocalVoicePreferences().stt).toBe("whisper-tiny.en-q4");
  });

  it("remove clears package and matching selection", async () => {
    writeLocalVoicePreferences({
      version: 1,
      stt: "browser",
      tts: "kokoro-82m-v1-q8",
    });
    await mount();
    await act(async () => {
      await latest?.onRemove?.("kokoro-82m-v1-q8");
    });
    expect(removeLocalEnginePackage).toHaveBeenCalledWith("kokoro-82m-v1-q8");
    expect(readLocalVoicePreferences().tts).toBe("browser");
  });

  it("surfaces safe errors without raw messages", async () => {
    downloadLocalEnginePackage.mockRejectedValue(new Error("ECONNRESET secret-token sk-abc"));
    await mount();
    await act(async () => {
      await latest?.onConsentLoad?.("whisper-tiny.en-q4");
    });
    expect(latest?.error).toMatch(/Could not download or verify/);
    expect(latest?.error).not.toMatch(/secret-token|sk-abc|ECONNRESET/);
  });

  it("selectStt/selectTts write preferences", async () => {
    await mount();
    act(() => latest?.selectStt("browser"));
    act(() => latest?.selectTts("browser"));
    expect(readLocalVoicePreferences()).toEqual({
      version: 1,
      stt: "browser",
      tts: "browser",
    });
  });
});
