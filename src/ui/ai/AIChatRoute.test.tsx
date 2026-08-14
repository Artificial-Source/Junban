/**
 * Wave 4d AI route: config gate, fixture isolation, live regions.
 * @vitest-environment jsdom
 */
import { act, createElement, Suspense, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIChatRoute } from "./AIChatRoute";
import { AIChatRouteFallback } from "./AIChatRouteFallback";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getAiConfig = vi.fn();
const getTask = vi.fn();

vi.mock("./transport", async () => {
  const actual = await vi.importActual<typeof import("./transport")>("./transport");
  return {
    ...actual,
    getAiConfig: (...args: unknown[]) => getAiConfig(...args),
  };
});

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getTask: (...args: unknown[]) => getTask(...args),
  };
});

async function flushLazy() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AIChatRoute", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    getAiConfig.mockReset();
    getTask.mockReset();
    window.history.replaceState(null, "", "/ai-chat");
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
  });

  it("renders the legacy not-configured shell when disabled", async () => {
    getAiConfig.mockResolvedValue({
      ai: {
        enabled: false,
        provider: null,
        model: null,
        custom_instructions: "",
        daily_briefing_enabled: false,
        smart_endpoint: false,
        auto_send: false,
      },
      voice: {
        voice_mode: "push_to_talk",
        grace_period_ms: 500,
        cloud_speech_enabled: false,
        stt_provider: "browser",
        tts_enabled: false,
        tts_provider: "browser",
      },
      credentials: {},
    });

    const onOpenSettings = vi.fn();

    await act(async () => {
      root.render(createElement(AIChatRoute, { onOpenSettings }));
    });
    await flushLazy();

    expect(getAiConfig).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("AI Assistant");
    expect(container.textContent).toContain(
      "Configure an AI provider in Settings to start chatting.",
    );
    expect(container.querySelector('button[aria-label="Close AI chat"]')).toBeNull();
  });

  it("exposes a stable-dimension Suspense fallback", () => {
    act(() => {
      root.render(createElement(AIChatRouteFallback));
    });
    const status = container.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status?.getAttribute("aria-label")).toBe("Loading AI chat");
    expect(status?.className).toMatch(/h-full/);
    expect(status?.className).toMatch(/w-full/);
    expect(status?.className).toMatch(/min-h-/);
  });

  it("loads through React.lazy + Suspense without eager failure", async () => {
    getAiConfig.mockResolvedValue({
      ai: {
        enabled: false,
        provider: null,
        model: null,
        custom_instructions: "",
        daily_briefing_enabled: false,
        smart_endpoint: false,
        auto_send: false,
      },
      voice: {
        voice_mode: "push_to_talk",
        grace_period_ms: 500,
        cloud_speech_enabled: false,
        stt_provider: "browser",
        tts_enabled: false,
        tts_provider: "browser",
      },
      credentials: {},
    });

    const LazyRoute = (await import("react")).lazy(() =>
      import("./AIChatRoute").then((module) => ({ default: module.AIChatRoute })),
    );
    const onOpenSettings = vi.fn();

    act(() => {
      root.render(
        createElement(
          Suspense,
          { fallback: createElement(AIChatRouteFallback) },
          createElement(LazyRoute, { onOpenSettings }) as ReactNode,
        ),
      );
    });

    await flushLazy();
    expect(container.textContent).toContain("AI Assistant");
  });

  it("fixture forceNotConfigured does not call network config", async () => {
    await act(async () => {
      root.render(
        createElement(AIChatRoute, {
          onOpenSettings: vi.fn(),
          fixture: { forceNotConfigured: true },
        }),
      );
    });
    expect(getAiConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Configure an AI provider");
  });

  it("fixture welcome state renders greeting without network", async () => {
    await act(async () => {
      root.render(
        createElement(AIChatRoute, {
          onOpenSettings: vi.fn(),
          fixture: {
            forceWelcome: true,
            forceOnboarding: false,
            greetingOverride: "Good morning",
            timeOfDayOverride: "morning",
            stats: { overdueCount: 1, todayCount: 2, pendingCount: 3 },
            messages: [],
          },
        }),
      );
    });
    expect(getAiConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Good morning");
    expect(container.textContent).toContain("Let's get things done.");
    expect(container.querySelector('[aria-label="AI chat"]')).toBeTruthy();
  });

  it("fixture path performs no local adapter or worker work", async () => {
    const workerSpy = vi.fn();
    vi.stubGlobal(
      "Worker",
      class {
        constructor(...args: unknown[]) {
          workerSpy(...args);
        }
      },
    );
    localStorage.setItem(
      "junban.voice.local.v1",
      JSON.stringify({
        version: 1,
        stt: "whisper-tiny.en-q4",
        tts: "kokoro-82m-v1-q8",
      }),
    );
    await act(async () => {
      root.render(
        createElement(AIChatRoute, {
          onOpenSettings: vi.fn(),
          fixture: { forceWelcome: true, forceOnboarding: false, messages: [] },
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(workerSpy).not.toHaveBeenCalled();
    expect(getAiConfig).not.toHaveBeenCalled();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("configured fixture exposes live region status for streaming chrome", async () => {
    await act(async () => {
      root.render(
        createElement(AIChatRoute, {
          onOpenSettings: vi.fn(),
          fixture: {
            messages: [
              {
                id: "m1",
                role: "user",
                status: "completed",
                text: "Hi",
                createdAt: "2026-01-01T00:00:00Z",
                sequence: 1,
                turnId: "t",
                focusedTaskId: null,
                briefingDate: null,
                segments: [{ kind: "text", text: "Hi" }],
                proposals: [],
                isError: false,
                retryable: false,
              },
            ],
          },
        }),
      );
    });
    expect(container.querySelector('input[aria-label="Message"]')).toBeTruthy();
    expect(container.textContent).toContain("Hi");
  });
});
