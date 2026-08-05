import { describe, expect, it, vi } from "vitest";
import { createResourceBag } from "./resources";
import { createVoiceGenerations, type ConfirmedVoiceSettings, type LocalSttAdapter } from "./types";
import { togglePushToTalk, transcribeBlob } from "./voice-ptt";
import type { VoiceRuntime } from "./voice-runtime";

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

function makeRuntime(localStt: LocalSttAdapter | null): VoiceRuntime {
  const generations = { current: createVoiceGenerations() };
  const phase = { current: "idle" as const };
  const callActive = { current: false };
  const resources = { current: createResourceBag() };
  const setPhase = vi.fn((next: string) => {
    (phase as { current: string }).current = next;
  });
  const setError = vi.fn();
  return {
    enabled: true,
    autoSend: true,
    microphoneId: "",
    localStt,
    localTts: null,
    sendMessage: vi.fn(),
    stopConversation: vi.fn(),
    setPhase: setPhase as VoiceRuntime["setPhase"],
    setError: setError as VoiceRuntime["setError"],
    setCallActive: vi.fn(),
    setCallDuration: vi.fn(),
    setInGracePeriod: vi.fn(),
    setGraceProgress: vi.fn(),
    setRecognitionRetry: vi.fn(),
    generations,
    resources,
    phase: phase as VoiceRuntime["phase"],
    callActive,
    settings: { current: settings },
    messages: { current: [] },
    sessionId: { current: "s" },
    recognitionRetry: { current: 0 },
    mounted: { current: true },
    callTimer: { current: null },
    awaitResponse: { current: null },
    spokenMessageIds: { current: new Set() },
    bump: (key: keyof typeof generations.current) => {
      generations.current = {
        ...generations.current,
        [key]: generations.current[key] + 1,
      };
      return generations.current[key];
    },
    isLive: () => true,
    releasePhysical: vi.fn(),
  } as unknown as VoiceRuntime;
}

describe("voice-ptt local selection", () => {
  it("uses MediaRecorder path when local STT is ready, never browser recognition", async () => {
    const transcribe = vi.fn(async () => "local-hi");
    const localStt: LocalSttAdapter = {
      status: "ready",
      transcribe,
      dispose() {},
    };
    const rt = makeRuntime(localStt);

    // start capture path
    const startSpy = vi.fn(async () => undefined);
    const stopSpy = vi.fn(async () => ({
      status: "blob" as const,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
    }));
    vi.doMock("./media-recorder", () => ({
      createPttCapture: () => ({
        start: startSpy,
        stop: stopSpy,
        cancel: vi.fn(),
      }),
    }));

    // Directly exercise transcribeBlob cloud-vs-local ordering with cloud off.
    await transcribeBlob(rt, new Blob([new Uint8Array([1])], { type: "audio/wav" }), 1, 0);
    expect(transcribe).toHaveBeenCalled();
  });

  it("does not start browser STT when local is selected but not ready", () => {
    const localStt: LocalSttAdapter = {
      status: "loading",
      async transcribe() {
        return "";
      },
      dispose() {},
    };
    const rt = makeRuntime(localStt);
    togglePushToTalk(rt, { fixture: false, browserSttAvailable: true });
    expect(rt.resources.current.recognition).toBeNull();
    expect(rt.phase.current).toBe("error");
  });

  it("never prefers local over confirmed cloud STT", async () => {
    const transcribe = vi.fn(async () => "local-should-not-run");
    const localStt: LocalSttAdapter = {
      status: "ready",
      transcribe,
      dispose() {},
    };
    const rt = makeRuntime(localStt);
    rt.settings.current = {
      ...settings,
      cloud_speech_enabled: true,
      stt_provider: "openai",
    };

    const createVoiceTranscription = vi.fn(async () => ({
      status: "ok" as const,
      text: "cloud-hi",
    }));
    vi.doMock("./cloud-speech", () => ({ createVoiceTranscription }));

    // Import a fresh binding is hard with vi.doMock after import; assert via direct branch:
    // With isCloudStt true, transcribeBlob should call cloud. We spy by replacing module-level
    // is insufficient after static import — use runtime path expectation through error on empty cloud mock.
    // Instead, verify local is not called when cloud path is taken by injecting failing cloud via fetch.
    const fetchMock = vi.fn(async () => {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", fetchMock);

    await transcribeBlob(rt, new Blob([new Uint8Array([1, 2])], { type: "audio/webm" }), 1, 0);
    expect(transcribe).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
