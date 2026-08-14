/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_VOICE_PREFERENCES_EVENT,
  LOCAL_VOICE_PREFERENCES_STORAGE_KEY,
  parseLocalVoicePreferences,
  readLocalVoicePreferences,
  resetLocalVoicePreferencesSnapshot,
  subscribeLocalVoicePreferences,
  writeLocalVoicePreferences,
} from "./localPreferences";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

afterEach(() => {
  localStorage.clear();
  resetLocalVoicePreferencesSnapshot();
  vi.restoreAllMocks();
});

describe("localVoicePreferences", () => {
  it("parses only allowlisted STT/TTS values", () => {
    expect(
      parseLocalVoicePreferences({
        version: 1,
        stt: "whisper-tiny.en-q4",
        tts: "kokoro-82m-v1-q8",
      }),
    ).toEqual({
      version: 1,
      stt: "whisper-tiny.en-q4",
      tts: "kokoro-82m-v1-q8",
    });
    expect(
      parseLocalVoicePreferences({
        version: 1,
        stt: "whisper-tiny.en-q4",
        tts: "piper-en_US-ljspeech-medium",
      }).tts,
    ).toBe("piper-en_US-ljspeech-medium");
  });

  it("fails closed to browser on stale package ids and secrets", () => {
    expect(
      parseLocalVoicePreferences({
        version: 1,
        stt: "whisper-legacy-gone",
        tts: "browser",
      }),
    ).toEqual({ version: 1, stt: "browser", tts: "browser" });
    expect(
      parseLocalVoicePreferences({
        version: 1,
        stt: "sk-secret",
        tts: "browser",
      }).stt,
    ).toBe("browser");
    expect(parseLocalVoicePreferences({ version: 2, stt: "browser", tts: "browser" }).stt).toBe(
      "browser",
    );
  });

  it("reads and writes versioned non-secret prefs and emits same-origin event", () => {
    const storage = memoryStorage();
    const handler = vi.fn();
    window.addEventListener(LOCAL_VOICE_PREFERENCES_EVENT, handler);

    expect(readLocalVoicePreferences(storage)).toEqual({
      version: 1,
      stt: "browser",
      tts: "browser",
    });

    writeLocalVoicePreferences({ version: 1, stt: "whisper-tiny.en-q4", tts: "browser" }, storage);
    expect(storage.dump()[LOCAL_VOICE_PREFERENCES_STORAGE_KEY]).toBe(
      JSON.stringify({
        version: 1,
        stt: "whisper-tiny.en-q4",
        tts: "browser",
      }),
    );
    expect(handler).toHaveBeenCalled();
    expect(readLocalVoicePreferences(storage).stt).toBe("whisper-tiny.en-q4");

    writeLocalVoicePreferences({ version: 1, stt: "browser", tts: "browser" }, storage);
    expect(storage.dump()[LOCAL_VOICE_PREFERENCES_STORAGE_KEY]).toBeUndefined();

    window.removeEventListener(LOCAL_VOICE_PREFERENCES_EVENT, handler);
  });

  it("rejects oversized stored documents", () => {
    const storage = memoryStorage({
      [LOCAL_VOICE_PREFERENCES_STORAGE_KEY]: `${"x".repeat(600)}`,
    });
    expect(readLocalVoicePreferences(storage)).toEqual({
      version: 1,
      stt: "browser",
      tts: "browser",
    });
  });

  it("subscribe fires on custom and storage events", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeLocalVoicePreferences(onChange);
    window.dispatchEvent(new CustomEvent(LOCAL_VOICE_PREFERENCES_EVENT));
    window.dispatchEvent(new StorageEvent("storage", { key: LOCAL_VOICE_PREFERENCES_STORAGE_KEY }));
    expect(onChange).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
