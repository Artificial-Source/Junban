/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { detectSpeechRecognitionCtor, isBrowserSttAvailable, startBrowserStt } from "./browser-stt";

type Handlers = {
  onresult: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onend: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
};

function mockRecognitionCtor(control: {
  instances: Handlers[];
  startImpl?: (self: Handlers) => void;
}) {
  return class MockRecognition {
    continuous = false;
    interimResults = false;
    lang = "";
    maxAlternatives = 1;
    onresult: Handlers["onresult"] = null;
    onerror: Handlers["onerror"] = null;
    onend: Handlers["onend"] = null;
    start = vi.fn(() => {
      control.startImpl?.(this as unknown as Handlers);
    });
    stop = vi.fn(() => {
      this.onend?.();
    });
    abort = vi.fn(() => {
      this.onerror?.({ error: "aborted" });
      this.onend?.();
    });
    constructor() {
      control.instances.push(this as unknown as Handlers);
    }
  };
}

describe("browser-stt", () => {
  it("reports unavailable when SpeechRecognition is missing", () => {
    expect(isBrowserSttAvailable({})).toBe(false);
    expect(detectSpeechRecognitionCtor({})).toBeNull();
    const handle = startBrowserStt({ Recognition: null });
    return expect(handle.done).resolves.toMatchObject({
      status: "error",
      error: { code: "unsupported" },
    });
  });

  it("returns a final transcript and ignores interim-only until final", async () => {
    const instances: Handlers[] = [];
    const Recognition = mockRecognitionCtor({
      instances,
      startImpl: (self) => {
        self.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: false, 0: { transcript: "hel" } }],
        });
        self.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: "hello" } }],
        });
      },
    });
    const interim = vi.fn();
    const handle = startBrowserStt({
      Recognition: Recognition as unknown as new () => never,
      onInterim: interim,
    });
    await expect(handle.done).resolves.toEqual({ status: "final", transcript: "hello" });
    expect(interim).toHaveBeenCalledWith("hel");
    expect(instances[0]?.start).toHaveBeenCalled();
  });

  it("maps permission errors and treats abort/no-speech as empty", async () => {
    const deniedInstances: Handlers[] = [];
    const Denied = mockRecognitionCtor({
      instances: deniedInstances,
      startImpl: (self) => self.onerror?.({ error: "not-allowed" }),
    });
    const denied = startBrowserStt({ Recognition: Denied as unknown as new () => never });
    await expect(denied.done).resolves.toMatchObject({
      status: "error",
      error: { code: "permission_denied" },
    });

    const abortedInstances: Handlers[] = [];
    const Aborted = mockRecognitionCtor({
      instances: abortedInstances,
      startImpl: (self) => self.onerror?.({ error: "aborted" }),
    });
    const aborted = startBrowserStt({ Recognition: Aborted as unknown as new () => never });
    await expect(aborted.done).resolves.toEqual({ status: "empty" });
  });

  it("abort() cancels without a transcript and stop() flushes", async () => {
    const instances: Handlers[] = [];
    const Recognition = mockRecognitionCtor({ instances });
    const handle = startBrowserStt({ Recognition: Recognition as unknown as new () => never });
    handle.abort();
    await expect(handle.done).resolves.toEqual({ status: "empty" });
    expect(instances[0]?.abort).toHaveBeenCalled();

    const continuousInstances: Handlers[] = [];
    const Continuous = mockRecognitionCtor({
      instances: continuousInstances,
      startImpl: (self) => {
        self.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: "part" } }],
        });
      },
    });
    const cont = startBrowserStt({
      Recognition: Continuous as unknown as new () => never,
      continuous: true,
    });
    cont.stop();
    await expect(cont.done).resolves.toEqual({ status: "final", transcript: "part" });
  });

  it("never embeds raw error objects in the settled result", async () => {
    const instances: Handlers[] = [];
    const Recognition = mockRecognitionCtor({
      instances,
      startImpl: (self) => self.onerror?.({ error: "network" }),
    });
    const handle = startBrowserStt({ Recognition: Recognition as unknown as new () => never });
    const result = await handle.done;
    expect(result).toMatchObject({ status: "error", error: { code: "network" } });
    expect(JSON.stringify(result)).not.toMatch(/SpeechRecognition|Bearer|sk-/);
  });
});
