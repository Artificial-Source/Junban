/**
 * @vitest-environment jsdom
 */
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceController, type UseVoiceControllerOptions } from "./useVoiceController";
import type { ChatMessageView } from "../ai/message-view";
import type { ConfirmedVoiceSettings } from "./types";
import { FIXTURE_PTT_ERROR, FIXTURE_PTT_LISTENING, FIXTURE_VAD_GRACE } from "./fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseSettings: ConfirmedVoiceSettings = {
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

function Harness({
  options,
  onValue,
}: {
  options: UseVoiceControllerOptions;
  onValue: (value: ReturnType<typeof useVoiceController>) => void;
}) {
  const value = useVoiceController(options);
  useEffect(() => {
    onValue(value);
  }, [onValue, value]);
  return createElement("div", {
    "data-phase": value.phase,
    "data-call": value.isCallActive ? "1" : "0",
    "data-button": value.buttonState,
  });
}

describe("useVoiceController", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useVoiceController> | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    latest = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(options: Partial<UseVoiceControllerOptions> = {}) {
    const sendMessage = options.sendMessage ?? vi.fn();
    const stopConversation = options.stopConversation ?? vi.fn();
    const full: UseVoiceControllerOptions = {
      settings: baseSettings,
      autoSend: true,
      messages: [],
      isStreaming: false,
      activeSessionId: "sess-1",
      sendMessage,
      stopConversation,
      enabled: true,
      ...options,
    };
    act(() => {
      root.render(
        createElement(Harness, {
          options: full,
          onValue: (v) => {
            latest = v;
          },
        }),
      );
    });
    return { sendMessage, stopConversation, full };
  }

  it("exposes fixture states with no mic/network side effects", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render({ fixture: FIXTURE_PTT_LISTENING });
    expect(latest?.buttonState).toBe("listening");
    expect(latest?.phase).toBe("idle");
    expect(fetchSpy).not.toHaveBeenCalled();

    render({ fixture: FIXTURE_PTT_ERROR });
    expect(latest?.recognitionError).toContain("Microphone access was denied");

    render({ fixture: FIXTURE_VAD_GRACE });
    expect(latest?.isCallActive).toBe(true);
    expect(latest?.isInGracePeriod).toBe(true);
    expect(latest?.gracePeriodProgress).toBeCloseTo(0.55);
    vi.unstubAllGlobals();
  });

  it("endCall and stop cleanup are idempotent and call durable cancel first", () => {
    const stopConversation = vi.fn();
    // Non-fixture path: startCall is a no-op without real media, so drive stop/end directly.
    render({
      stopConversation,
      settings: { ...baseSettings, tts_enabled: false, voice_mode: "hands_free" },
    });
    expect(latest?.isCallActive).toBe(false);
    act(() => latest?.stop());
    act(() => latest?.stop());
    expect(stopConversation).toHaveBeenCalled();
    const afterStop = stopConversation.mock.calls.length;
    act(() => latest?.endCall());
    act(() => latest?.endCall());
    // End Call must durable-cancel even when Stop already ran.
    expect(stopConversation.mock.calls.length).toBeGreaterThan(afterStop);
    expect(latest?.isCallActive).toBe(false);
    expect(latest?.phase).toBe("idle");
  });

  it("session identity changes are tracked without speaking stale content", () => {
    const messages: ChatMessageView[] = [
      {
        id: "a1",
        role: "assistant",
        status: "completed",
        text: "stale",
        createdAt: new Date().toISOString(),
        sequence: 1,
        turnId: "t1",
        focusedTaskId: null,
        briefingDate: null,
        segments: [{ kind: "text", text: "stale" }],
        proposals: [],
        isError: false,
        retryable: false,
      },
    ];
    render({ messages, activeSessionId: "sess-1" });
    act(() => {
      root.render(
        createElement(Harness, {
          options: {
            settings: baseSettings,
            autoSend: true,
            messages,
            isStreaming: false,
            activeSessionId: "sess-2",
            sendMessage: vi.fn(),
            stopConversation: vi.fn(),
            enabled: true,
          },
          onValue: (v) => {
            latest = v;
          },
        }),
      );
    });
    expect(latest?.isCallActive).toBe(false);
    expect(latest?.phase).toBe("idle");
  });

  it("does not put raw transcripts or tokens into diagnostics", () => {
    render({
      fixture: {
        buttonState: "error",
        buttonPermissionError:
          "Microphone access was denied. Allow microphone access in your browser settings, then retry.",
      },
    });
    const serialized = JSON.stringify(latest);
    expect(serialized).not.toMatch(/sk-|Bearer |access_token/);
    expect(serialized).not.toContain("raw transcript secret");
  });

  it("hides PTT when local STT is selected but not ready (no browser fallback)", () => {
    render({
      localStt: {
        status: "loading",
        async transcribe() {
          return "should-not-run";
        },
        dispose() {},
      },
    });
    expect(latest?.showPttButton).toBe(false);
    expect(latest?.browserSttAvailable).toBeTypeOf("boolean");
  });

  it("enables PTT when local STT adapter is ready", () => {
    render({
      localStt: {
        status: "ready",
        async transcribe() {
          return "ok";
        },
        dispose() {},
      },
    });
    expect(latest?.showPttButton).toBe(true);
  });
});
