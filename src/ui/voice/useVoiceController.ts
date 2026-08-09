/**
 * Generation-fenced half-duplex voice controller (composition facade).
 *
 * Phases: idle → arming → listening → transcribing → thinking → speaking → idle/error
 *
 * Ownership is split across:
 * - `voice-runtime` — generations + physical lifecycle
 * - `voice-ptt` — push-to-talk capture/transcription
 * - `voice-call` — hands-free VAD / call cycle
 * - `voice-speech` — terminal assistant matching + TTS
 * - `controller-presentation` — fixture/result mapping
 *
 * No global VoiceContext.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { readMicPreferences } from "./micPreferences";
import { releaseVoiceResources } from "./resources";
import type { VoiceError, VoicePhase } from "./types";
import { settingsIdentityKey } from "./voice-capabilities";
import { beginBrowserCallListenLoop, startCall as startCallOwned } from "./voice-call";
import { mapControllerPresentation, resolveCapabilityFlags } from "./controller-presentation";
import {
  bindVoiceRuntime,
  createVoiceRuntimeShell,
  endCall as endCallOwned,
  endLogicalCall,
  fullCleanup,
  stopVoiceActivity,
} from "./voice-runtime";
import { observeTerminalAssistant } from "./voice-speech";
import { togglePushToTalk as togglePttOwned } from "./voice-ptt";
import type { UseVoiceControllerOptions, UseVoiceControllerResult } from "./controller-types";

export type { UseVoiceControllerOptions, UseVoiceControllerResult } from "./controller-types";

export function useVoiceController(options: UseVoiceControllerOptions): UseVoiceControllerResult {
  const {
    settings,
    autoSend,
    messages,
    isStreaming,
    activeSessionId,
    sendMessage,
    stopConversation,
    enabled = true,
    fixture = null,
    localStt = null,
    localTts = null,
  } = options;

  const microphoneId = options.microphoneId ?? (fixture ? "" : readMicPreferences().deviceId);

  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState<VoiceError | null>(null);
  const [isCallActive, setCallActive] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [isInGracePeriod, setInGracePeriod] = useState(false);
  const [gracePeriodProgress, setGraceProgress] = useState(0);
  const [recognitionRetry, setRecognitionRetry] = useState(0);

  const shellRef = useRef(createVoiceRuntimeShell());
  const shell = shellRef.current;

  // Keep live inputs on the shared runtime shell.
  shell.sessionId.current = activeSessionId;
  shell.messages.current = messages;
  shell.settings.current = settings;
  shell.recognitionRetry.current = recognitionRetry;

  const rt = useMemo(
    () =>
      bindVoiceRuntime(shell, {
        enabled,
        autoSend,
        microphoneId,
        localStt,
        localTts,
        sendMessage,
        stopConversation,
        setPhase,
        setError,
        setCallActive,
        setCallDuration,
        setInGracePeriod,
        setGraceProgress,
        setRecognitionRetry,
      }),
    [shell, enabled, autoSend, microphoneId, localStt, localTts, sendMessage, stopConversation],
  );

  // Mount / unmount — invalidate generations, release physical, clear timer.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const resources = shell.resources;
    const generations = shell.generations;
    const callTimer = shell.callTimer;
    const mounted = shell.mounted;
    mounted.current = true;
    return () => {
      mounted.current = false;
      generations.current = {
        surface: generations.current.surface + 1,
        call: generations.current.call + 1,
        utterance: generations.current.utterance + 1,
        response: generations.current.response + 1,
      };
      // Stable resources bag — not `rt`, which may change across renders.
      releaseVoiceResources(resources.current);
      if (callTimer.current) clearInterval(callTimer.current);
    };
  }, []);

  useLayoutEffect(() => {
    if (!enabled) {
      fullCleanup(rt);
      rt.setError(null);
    }
  }, [enabled, rt]);

  const settingsIdentity = settingsIdentityKey(settings);
  const settingsIdentityRef = useRef(settingsIdentity);
  useLayoutEffect(() => {
    if (settingsIdentityRef.current === settingsIdentity) return;
    settingsIdentityRef.current = settingsIdentity;
    // Confirmed settings identity changed — drop physical work; no silent privacy fallback.
    rt.releasePhysical();
    if (shell.callActive.current) {
      rt.bump("call");
      endLogicalCall(rt);
      rt.setPhase("idle");
    } else if (shell.phase.current !== "idle" && shell.phase.current !== "error") {
      rt.bump("utterance");
      rt.setPhase("idle");
    }
  }, [settingsIdentity, rt, shell]);

  const sessionSeenRef = useRef(activeSessionId);
  useEffect(() => {
    if (sessionSeenRef.current === activeSessionId) return;
    sessionSeenRef.current = activeSessionId;
    if (!shell.callActive.current) return;
    rt.bump("call");
    rt.releasePhysical();
    endLogicalCall(rt);
    rt.setPhase("idle");
  }, [activeSessionId, rt, shell]);

  const caps = resolveCapabilityFlags(settings, localStt, localTts, fixture);

  // Terminal assistant observation (speech owner).
  useEffect(() => {
    observeTerminalAssistant(rt, isStreaming, messages);
  }, [isStreaming, messages, rt]);

  const togglePushToTalk = useCallback(() => {
    togglePttOwned(rt, {
      fixture: Boolean(fixture),
      browserSttAvailable: caps.browserSttAvailable,
    });
  }, [caps.browserSttAvailable, fixture, rt]);

  const startCall = useCallback(() => {
    startCallOwned(rt, {
      fixture: Boolean(fixture),
      sttReady: caps.sttReady,
      ttsAvailable: caps.ttsAvailable,
      browserSttAvailable: caps.browserSttAvailable,
    });
  }, [caps, fixture, rt]);

  // Browser STT loop during call listening (call owner).
  useEffect(() => {
    return (
      beginBrowserCallListenLoop(rt, {
        fixture: Boolean(fixture),
        isCallActive,
        phase,
        browserSttAvailable: caps.browserSttAvailable,
      }) ?? undefined
    );
    // recognitionRetry retriggers empty-result loops via state.
  }, [
    caps.browserSttAvailable,
    fixture,
    isCallActive,
    phase,
    recognitionRetry,
    rt,
    settings.stt_provider,
    localStt?.status,
  ]);

  const endCall = useCallback(() => {
    endCallOwned(rt);
  }, [rt]);

  const stop = useCallback(() => {
    stopVoiceActivity(rt);
  }, [rt]);

  const retryRecognition = useCallback(() => {
    rt.setError(null);
    rt.setRecognitionRetry((n) => n + 1);
    if (shell.callActive.current) {
      rt.setPhase("listening");
    } else if (settings.voice_mode === "push_to_talk") {
      togglePushToTalk();
    }
  }, [rt, settings.voice_mode, shell, togglePushToTalk]);

  const dismissError = useCallback(() => {
    rt.setError(null);
    if (shell.phase.current === "error") rt.setPhase("idle");
  }, [rt, shell]);

  return useMemo(
    () =>
      mapControllerPresentation({
        settings,
        enabled,
        fixture,
        phase,
        error,
        isCallActive,
        callDuration,
        isInGracePeriod,
        gracePeriodProgress,
        localStt,
        localTts,
        actions: {
          togglePushToTalk,
          startCall,
          endCall,
          stop,
          retryRecognition,
          dismissError,
        },
      }),
    [
      settings,
      enabled,
      fixture,
      phase,
      error,
      isCallActive,
      callDuration,
      isInGracePeriod,
      gracePeriodProgress,
      localStt,
      localTts,
      togglePushToTalk,
      startCall,
      endCall,
      stop,
      retryRecognition,
      dismissError,
    ],
  );
}
