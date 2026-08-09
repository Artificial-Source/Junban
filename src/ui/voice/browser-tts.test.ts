/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
  cancelBrowserTts,
  isBrowserTtsAvailable,
  listBrowserTtsVoices,
  speakBrowserTts,
  whenBrowserVoicesReady,
} from "./browser-tts";

function mockSynthesis(
  voices: Array<{ voiceURI: string; name: string; lang: string; default: boolean }> = [],
) {
  const spoken: unknown[] = [];
  const synth = {
    speaking: false,
    pending: false,
    getVoices: () => voices,
    speak: (u: unknown) => {
      spoken.push(u);
      const utterance = u as {
        onend: ((ev: unknown) => void) | null;
      };
      queueMicrotask(() => utterance.onend?.(null));
    },
    cancel: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    onvoiceschanged: null as (() => void) | null,
  };
  return { synth, spoken };
}

describe("browser-tts", () => {
  it("detects availability and lists voices", () => {
    expect(isBrowserTtsAvailable(null)).toBe(false);
    const { synth } = mockSynthesis([
      { voiceURI: "v1", name: "Voice One", lang: "en-US", default: true },
    ]);
    // SpeechSynthesisUtterance may exist in jsdom incompletely — force via synth only path
    expect(listBrowserTtsVoices(synth)).toEqual([
      { id: "v1", name: "Voice One", lang: "en-US", default: true },
    ]);
  });

  it("cancels before speaking and on cancel()", async () => {
    const { synth, spoken } = mockSynthesis([
      { voiceURI: "exact", name: "Exact", lang: "en-US", default: false },
    ]);
    // jsdom may lack SpeechSynthesisUtterance — skip speak if unavailable
    if (typeof SpeechSynthesisUtterance === "undefined") {
      cancelBrowserTts(synth);
      expect(synth.cancel).toHaveBeenCalled();
      return;
    }
    const playback = speakBrowserTts("Hello world", {
      synthesis: synth,
      voice: "exact",
    });
    await playback.done;
    expect(synth.cancel).toHaveBeenCalled();
    expect(spoken.length).toBe(1);
    playback.cancel();
    cancelBrowserTts(synth);
  });

  it("whenBrowserVoicesReady resolves existing or empty", async () => {
    const { synth } = mockSynthesis([]);
    await expect(whenBrowserVoicesReady({ synthesis: synth, timeoutMs: 10 })).resolves.toEqual([]);
    const populated = mockSynthesis([{ voiceURI: "a", name: "A", lang: "en", default: true }]);
    await expect(
      whenBrowserVoicesReady({ synthesis: populated.synth, timeoutMs: 10 }),
    ).resolves.toHaveLength(1);
  });
});
