/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
  bindVoiceRuntime,
  createVoiceRuntimeShell,
  endCall,
  fullCleanup,
  resumeListeningOrIdle,
  stopVoiceActivity,
} from "./voice-runtime";
import type { ConfirmedVoiceSettings } from "./types";

const settings: ConfirmedVoiceSettings = {
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

function makeRuntime(overrides: { stopConversation?: () => void } = {}) {
  const shell = createVoiceRuntimeShell();
  shell.settings.current = settings;
  shell.mounted.current = true;
  const setPhase = vi.fn();
  const setError = vi.fn();
  const setCallActive = vi.fn();
  const stopConversation = overrides.stopConversation ?? vi.fn();
  const rt = bindVoiceRuntime(shell, {
    enabled: true,
    autoSend: true,
    microphoneId: "",
    localStt: null,
    localTts: null,
    sendMessage: vi.fn(),
    stopConversation,
    setPhase,
    setError,
    setCallActive,
    setCallDuration: vi.fn(),
    setInGracePeriod: vi.fn(),
    setGraceProgress: vi.fn(),
    setRecognitionRetry: vi.fn(),
  });
  return { rt, shell, setPhase, setError, setCallActive, stopConversation };
}

describe("voice-runtime generation and cleanup authority", () => {
  it("isLive rejects stale generation and unmounted surface", () => {
    const { rt, shell } = makeRuntime();
    const call = rt.bump("call");
    expect(rt.isLive({ call })).toBe(true);
    rt.bump("call");
    expect(rt.isLive({ call })).toBe(false);

    shell.mounted.current = false;
    const next = rt.bump("utterance");
    expect(rt.isLive({ utterance: next })).toBe(false);
  });

  it("stopVoiceActivity durable-cancels before physical abort and is idempotent", () => {
    const { rt, stopConversation, setPhase } = makeRuntime();
    const abort = vi.fn();
    rt.resources.current.abortControllers.push({ abort } as unknown as AbortController);
    const recognitionAbort = vi.fn();
    rt.resources.current.recognition = { abort: recognitionAbort } as never;
    const cancelTts = vi.fn();
    rt.resources.current.browserTtsCancel = cancelTts;

    const beforeUtterance = rt.generations.current.utterance;
    const beforeResponse = rt.generations.current.response;

    stopVoiceActivity(rt);
    stopVoiceActivity(rt);

    expect(stopConversation).toHaveBeenCalled();
    expect(rt.generations.current.utterance).toBeGreaterThan(beforeUtterance);
    expect(rt.generations.current.response).toBeGreaterThan(beforeResponse);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(recognitionAbort).toHaveBeenCalledTimes(1);
    expect(cancelTts).toHaveBeenCalledTimes(1);
    expect(setPhase).toHaveBeenCalledWith("idle");
    // Stale generation after stop must not be live.
    expect(rt.isLive({ utterance: beforeUtterance, response: beforeResponse })).toBe(false);
  });

  it("endCall durable-cancels an in-flight call turn before releasing resources", () => {
    const order: string[] = [];
    const stopConversation = vi.fn(() => {
      order.push("stopConversation");
    });
    const { rt, shell, setCallActive, setPhase } = makeRuntime({ stopConversation });
    shell.callActive.current = true;
    rt.awaitResponse.current = {
      responseGen: rt.generations.current.response,
      callGen: rt.generations.current.call,
      seenIds: new Set(),
    };
    const destroy = vi.fn(async () => {
      order.push("releasePhysical");
    });
    rt.resources.current.vad = { destroy, pause: vi.fn(), start: vi.fn() } as never;
    const callBefore = rt.generations.current.call;
    const utteranceBefore = rt.generations.current.utterance;
    const responseBefore = rt.generations.current.response;

    endCall(rt);

    expect(stopConversation).toHaveBeenCalledTimes(1);
    expect(order.indexOf("stopConversation")).toBeLessThan(order.indexOf("releasePhysical"));
    expect(rt.generations.current.call).toBeGreaterThan(callBefore);
    expect(rt.generations.current.utterance).toBeGreaterThan(utteranceBefore);
    expect(rt.generations.current.response).toBeGreaterThan(responseBefore);
    expect(rt.awaitResponse.current).toBeNull();
    expect(setCallActive).toHaveBeenCalledWith(false);
    expect(setPhase).toHaveBeenCalledWith("idle");
    expect(destroy).toHaveBeenCalled();
    expect(rt.callActive.current).toBe(false);
    // Late completion fences must reject after End Call.
    expect(rt.isLive({ call: callBefore, response: responseBefore })).toBe(false);
  });

  it("endCall is idempotent when idle and does not resume after a late fence check", () => {
    const stopConversation = vi.fn();
    const { rt, setPhase, setCallActive } = makeRuntime({ stopConversation });
    // Idle end — no active call resources.
    endCall(rt);
    endCall(rt);

    expect(stopConversation).toHaveBeenCalledTimes(2);
    expect(rt.callActive.current).toBe(false);
    expect(rt.awaitResponse.current).toBeNull();
    expect(setPhase).toHaveBeenLastCalledWith("idle");
    expect(setCallActive).toHaveBeenLastCalledWith(false);
    expect(rt.phase.current).toBe("idle");
    // Even after two ends, stale pre-end generations stay dead.
    expect(rt.isLive({ call: 0, utterance: 0, response: 0 })).toBe(false);

    // A late speech completion must not re-enter listening after End Call.
    const resume = vi.fn(async () => undefined);
    rt.resources.current.vad = {
      resume,
      pause: vi.fn(),
      start: vi.fn(),
      destroy: vi.fn(async () => undefined),
    } as never;
    setPhase.mockClear();
    resumeListeningOrIdle(rt);
    expect(setPhase).toHaveBeenCalledWith("idle");
    expect(resume).not.toHaveBeenCalled();
  });

  it("fullCleanup invalidates surface generation after endCall fences", () => {
    const { rt } = makeRuntime();
    const surfaceBefore = rt.generations.current.surface;
    fullCleanup(rt);
    expect(rt.generations.current.surface).toBeGreaterThan(surfaceBefore);
    expect(rt.isLive({ surface: surfaceBefore })).toBe(false);
  });

  it("stop during an active call resumes listening without ending the call", () => {
    const { rt, setPhase, setCallActive } = makeRuntime();
    rt.callActive.current = true;
    const resume = vi.fn(async () => undefined);
    rt.resources.current.vad = {
      resume,
      pause: vi.fn(),
      start: vi.fn(),
      destroy: vi.fn(async () => undefined),
    } as never;

    stopVoiceActivity(rt);

    expect(setPhase).toHaveBeenCalledWith("listening");
    expect(resume).toHaveBeenCalled();
    expect(rt.callActive.current).toBe(true);
    expect(setCallActive).not.toHaveBeenCalledWith(false);
  });
});
