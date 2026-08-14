/**
 * Shared generation fence + physical resource lifecycle authority.
 *
 * Owners (PTT, call, speech) receive this bag; they never invent parallel
 * generation counters or resource bags. Invalidate generations before release.
 */

import type { ChatMessageView } from "../ai/message-view";
import { cancelBrowserTts } from "./browser-tts";
import { createResourceBag, releaseVoiceResources, type VoiceResourceBag } from "./resources";
import {
  createVoiceGenerations,
  type ConfirmedVoiceSettings,
  type LocalSttAdapter,
  type LocalTtsAdapter,
  type VoiceError,
  type VoiceGenerations,
  type VoicePhase,
} from "./types";

export type PendingVoiceResponse = {
  responseGen: number;
  callGen: number;
  seenIds: Set<string>;
};

export type VoiceRuntime = {
  generations: { current: VoiceGenerations };
  resources: { current: VoiceResourceBag };
  mounted: { current: boolean };
  phase: { current: VoicePhase };
  callActive: { current: boolean };
  sessionId: { current: string | null };
  settings: { current: ConfirmedVoiceSettings };
  messages: { current: ChatMessageView[] };
  awaitResponse: { current: PendingVoiceResponse | null };
  spokenMessageIds: { current: Set<string> };
  callTimer: { current: ReturnType<typeof setInterval> | null };
  callStartedAt: { current: number };
  recognitionRetry: { current: number };

  enabled: boolean;
  autoSend: boolean;
  microphoneId: string;
  localStt: LocalSttAdapter | null;
  localTts: LocalTtsAdapter | null;

  sendMessage: (text: string) => void | Promise<void>;
  stopConversation: () => void | Promise<void>;

  setPhase: (phase: VoicePhase) => void;
  setError: (error: VoiceError | null) => void;
  setCallActive: (active: boolean) => void;
  setCallDuration: (seconds: number) => void;
  setInGracePeriod: (active: boolean) => void;
  setGraceProgress: (progress: number) => void;
  setRecognitionRetry: (updater: (n: number) => number) => void;

  bump: (key: keyof VoiceGenerations) => number;
  isLive: (expected?: Partial<VoiceGenerations> & { sessionId?: string | null }) => boolean;
  releasePhysical: () => void;
};

export type VoiceRuntimeUiBindings = {
  enabled: boolean;
  autoSend: boolean;
  microphoneId: string;
  localStt: LocalSttAdapter | null;
  localTts: LocalTtsAdapter | null;
  sendMessage: (text: string) => void | Promise<void>;
  stopConversation: () => void | Promise<void>;
  setPhase: (phase: VoicePhase) => void;
  setError: (error: VoiceError | null) => void;
  setCallActive: (active: boolean) => void;
  setCallDuration: (seconds: number) => void;
  setInGracePeriod: (active: boolean) => void;
  setGraceProgress: (progress: number) => void;
  setRecognitionRetry: (updater: (n: number) => number) => void;
};

/** Create mutable generation/resource refs. UI setters are attached by the facade. */
export function createVoiceRuntimeShell(): Pick<
  VoiceRuntime,
  | "generations"
  | "resources"
  | "mounted"
  | "phase"
  | "callActive"
  | "sessionId"
  | "settings"
  | "messages"
  | "awaitResponse"
  | "spokenMessageIds"
  | "callTimer"
  | "callStartedAt"
  | "recognitionRetry"
> {
  return {
    generations: { current: createVoiceGenerations() },
    resources: { current: createResourceBag() },
    mounted: { current: true },
    phase: { current: "idle" },
    callActive: { current: false },
    sessionId: { current: null },
    settings: {
      current: {
        cloud_speech_enabled: false,
        grace_period_ms: 1000,
        stt_provider: "browser",
        stt_model: null,
        tts_provider: "browser",
        tts_model: null,
        tts_voice: null,
        stt_credential_id: null,
        tts_credential_id: null,
        tts_enabled: false,
        voice_mode: "push_to_talk",
      },
    },
    messages: { current: [] },
    awaitResponse: { current: null },
    spokenMessageIds: { current: new Set() },
    callTimer: { current: null },
    callStartedAt: { current: 0 },
    recognitionRetry: { current: 0 },
  };
}

export function bindVoiceRuntime(
  shell: ReturnType<typeof createVoiceRuntimeShell>,
  ui: VoiceRuntimeUiBindings,
): VoiceRuntime {
  const bump = (key: keyof VoiceGenerations): number => {
    shell.generations.current = {
      ...shell.generations.current,
      [key]: shell.generations.current[key] + 1,
    };
    return shell.generations.current[key];
  };

  const isLive = (
    expected?: Partial<VoiceGenerations> & { sessionId?: string | null },
  ): boolean => {
    if (!shell.mounted.current) return false;
    if (!ui.enabled) return false;
    const gens = shell.generations.current;
    if (expected?.surface !== undefined && expected.surface !== gens.surface) return false;
    if (expected?.call !== undefined && expected.call !== gens.call) return false;
    if (expected?.utterance !== undefined && expected.utterance !== gens.utterance) return false;
    if (expected?.response !== undefined && expected.response !== gens.response) return false;
    if (expected?.sessionId !== undefined && expected.sessionId !== shell.sessionId.current) {
      return false;
    }
    return true;
  };

  const releasePhysical = () => {
    releaseVoiceResources(shell.resources.current);
  };

  const setPhase = (phase: VoicePhase) => {
    shell.phase.current = phase;
    if (shell.mounted.current) ui.setPhase(phase);
  };

  return {
    ...shell,
    enabled: ui.enabled,
    autoSend: ui.autoSend,
    microphoneId: ui.microphoneId,
    localStt: ui.localStt,
    localTts: ui.localTts,
    sendMessage: ui.sendMessage,
    stopConversation: ui.stopConversation,
    setPhase,
    setError: (error) => {
      if (shell.mounted.current) ui.setError(error);
    },
    setCallActive: (active) => {
      shell.callActive.current = active;
      if (shell.mounted.current) ui.setCallActive(active);
    },
    setCallDuration: ui.setCallDuration,
    setInGracePeriod: ui.setInGracePeriod,
    setGraceProgress: ui.setGraceProgress,
    setRecognitionRetry: ui.setRecognitionRetry,
    bump,
    isLive,
    releasePhysical,
  };
}

export function clearCallTimer(rt: VoiceRuntime): void {
  if (rt.callTimer.current) {
    clearInterval(rt.callTimer.current);
    rt.callTimer.current = null;
  }
  rt.callStartedAt.current = 0;
  if (rt.mounted.current) rt.setCallDuration(0);
}

export function startCallTimer(rt: VoiceRuntime): void {
  clearCallTimer(rt);
  rt.callStartedAt.current = Date.now();
  rt.callTimer.current = setInterval(() => {
    if (!rt.mounted.current) return;
    rt.setCallDuration(Math.floor((Date.now() - rt.callStartedAt.current) / 1000));
  }, 1000);
}

export function endLogicalCall(rt: VoiceRuntime): void {
  rt.callActive.current = false;
  if (rt.mounted.current) rt.setCallActive(false);
  clearCallTimer(rt);
  rt.setInGracePeriod(false);
  rt.setGraceProgress(0);
  rt.awaitResponse.current = null;
}

/** Invalidate all generations and drop physical + logical call state. */
export function fullCleanup(rt: VoiceRuntime): void {
  rt.bump("surface");
  rt.bump("call");
  rt.bump("utterance");
  rt.bump("response");
  rt.releasePhysical();
  endLogicalCall(rt);
  rt.setPhase("idle");
}

/**
 * Stop path: invalidate utterance/response first, durable cancel, then abort
 * speech/recognition. Call resources stay alive when a call is active.
 */
export function stopVoiceActivity(rt: VoiceRuntime): void {
  rt.bump("utterance");
  rt.bump("response");
  rt.awaitResponse.current = null;
  void rt.stopConversation();

  const bag = rt.resources.current;
  for (const c of bag.abortControllers.splice(0)) {
    try {
      c.abort();
    } catch {
      // ignore
    }
  }
  try {
    bag.recognition?.abort();
  } catch {
    // ignore
  }
  bag.recognition = null;
  try {
    bag.cloudPlaybackStop?.();
  } catch {
    // ignore
  }
  bag.cloudPlaybackStop = null;
  try {
    bag.browserTtsCancel?.();
  } catch {
    // ignore
  }
  bag.browserTtsCancel = null;
  cancelBrowserTts();
  if (bag.recorder) {
    bag.recorder.cancel();
    bag.recorder = null;
  }
  if (rt.callActive.current) {
    rt.setPhase("listening");
    void bag.vad?.resume();
  } else {
    rt.releasePhysical();
    rt.setPhase("idle");
  }
}

/**
 * End Call path: fence generations, durable-cancel the in-flight chat run
 * exactly once, then release media/VAD/TTS and settle ended state.
 * Idempotent — repeated ends re-fence and re-cancel safely without resuming.
 */
export function endCall(rt: VoiceRuntime): void {
  rt.bump("call");
  rt.bump("utterance");
  rt.bump("response");
  rt.awaitResponse.current = null;
  // Cancel durable AI conversation before tearing down physical resources so
  // a late assistant/tool completion cannot persist after End Call.
  void rt.stopConversation();
  rt.releasePhysical();
  endLogicalCall(rt);
  rt.setError(null);
  rt.setPhase("idle");
}

/** Resume listening after a terminal speech/turn outcome when a call is active. */
export function resumeListeningOrIdle(rt: VoiceRuntime): void {
  if (rt.callActive.current) {
    rt.setPhase("listening");
    void rt.resources.current.vad?.resume();
  } else {
    rt.setPhase("idle");
  }
}
