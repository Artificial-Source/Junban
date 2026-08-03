/**
 * Generation-fenced half-duplex voice controller.
 *
 * Phases: idle → arming → listening → transcribing → thinking → speaking → idle/error
 * Modes: push_to_talk | hands_free (call).
 *
 * Ownership is split: this hook owns the reducer + orchestration; physical
 * resources live in `resources.ts`; browser/cloud adapters are pure modules.
 * No global VoiceContext.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessageView } from "../ai/message-view";
import { startBrowserStt, isBrowserSttAvailable, type BrowserSttHandle } from "./browser-stt";
import { cancelBrowserTts, speakBrowserTts, whenBrowserVoicesReady } from "./browser-tts";
import { createVoiceSpeech, createVoiceTranscription, playCloudAudioBlob } from "./cloud-speech";
import { createPttCapture, type PttCaptureHandle } from "./media-recorder";
import { readMicPreferences } from "./micPreferences";
import { createResourceBag, releaseVoiceResources, type VoiceResourceBag } from "./resources";
import { isPermissionVoiceError, voiceError } from "./speech-errors";
import {
  BROWSER_STT_PRIVACY_NOTE,
  MICROPHONE_PERMISSION_GUIDANCE,
  createVoiceGenerations,
  type ConfirmedVoiceSettings,
  type LocalSttAdapter,
  type LocalTtsAdapter,
  type VoiceButtonPresentationState,
  type VoiceCallPresentationState,
  type VoiceError,
  type VoiceFixture,
  type VoiceGenerations,
  type VoicePhase,
} from "./types";
import { createVadSession, type VadSession } from "./vad-session";
import {
  isCloudStt,
  isCloudTts,
  phaseToButtonState,
  phaseToCallState,
  resolveSttReady,
  resolveTtsAvailable,
  settingsIdentityKey,
} from "./voice-capabilities";

export type UseVoiceControllerOptions = {
  settings: ConfirmedVoiceSettings;
  /** Confirmed AI auto-send — voice transcripts always send during a call. */
  autoSend: boolean;
  messages: ChatMessageView[];
  isStreaming: boolean;
  activeSessionId: string | null;
  sendMessage: (text: string) => void | Promise<void>;
  /** Durable conversation cancel; invoked before physical abort on Stop. */
  stopConversation: () => void | Promise<void>;
  enabled?: boolean;
  microphoneId?: string;
  fixture?: VoiceFixture | null;
  localStt?: LocalSttAdapter | null;
  localTts?: LocalTtsAdapter | null;
};

export type UseVoiceControllerResult = {
  phase: VoicePhase;
  error: VoiceError | null;
  isCallActive: boolean;
  callState: VoiceCallPresentationState | "idle";
  callDuration: number;
  isInGracePeriod: boolean;
  gracePeriodProgress: number;
  buttonState: VoiceButtonPresentationState;
  showPttButton: boolean;
  showCallButton: boolean;
  ttsAvailable: boolean;
  browserSttAvailable: boolean;
  privacyNote: string | null;
  recognitionError: string | null;
  /** Push-to-talk toggle (start/stop). */
  togglePushToTalk: () => void;
  startCall: () => void;
  endCall: () => void;
  /** Stop generating + speech (keeps call alive when in call). */
  stop: () => void;
  retryRecognition: () => void;
  dismissError: () => void;
};

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

  const generationsRef = useRef<VoiceGenerations>(createVoiceGenerations());
  const resourcesRef = useRef<VoiceResourceBag>(createResourceBag());
  const mountedRef = useRef(true);
  const phaseRef = useRef<VoicePhase>("idle");
  const callActiveRef = useRef(false);
  const sessionRef = useRef(activeSessionId);
  const streamingRef = useRef(isStreaming);
  const messagesRef = useRef(messages);
  const settingsRef = useRef(settings);
  const awaitResponseRef = useRef<{
    responseGen: number;
    callGen: number;
    seenIds: Set<string>;
  } | null>(null);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callStartedAtRef = useRef(0);
  const spokenMessageIdsRef = useRef<Set<string>>(new Set());

  sessionRef.current = activeSessionId;
  streamingRef.current = isStreaming;
  messagesRef.current = messages;
  settingsRef.current = settings;

  const setPhaseSafe = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    if (mountedRef.current) setPhase(next);
  }, []);

  const setErrorSafe = useCallback((next: VoiceError | null) => {
    if (mountedRef.current) setError(next);
  }, []);

  const bump = useCallback((key: keyof VoiceGenerations) => {
    generationsRef.current = {
      ...generationsRef.current,
      [key]: generationsRef.current[key] + 1,
    };
    return generationsRef.current[key];
  }, []);

  const isLive = useCallback(
    (expected?: Partial<VoiceGenerations> & { sessionId?: string | null }) => {
      if (!mountedRef.current) return false;
      if (!enabled) return false;
      const gens = generationsRef.current;
      if (expected?.surface !== undefined && expected.surface !== gens.surface) return false;
      if (expected?.call !== undefined && expected.call !== gens.call) return false;
      if (expected?.utterance !== undefined && expected.utterance !== gens.utterance) return false;
      if (expected?.response !== undefined && expected.response !== gens.response) return false;
      if (expected?.sessionId !== undefined && expected.sessionId !== sessionRef.current) {
        return false;
      }
      return true;
    },
    [enabled],
  );

  const releasePhysical = useCallback(() => {
    releaseVoiceResources(resourcesRef.current);
  }, []);

  const clearCallTimer = useCallback(() => {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
    callStartedAtRef.current = 0;
    if (mountedRef.current) setCallDuration(0);
  }, []);

  const startCallTimer = useCallback(() => {
    clearCallTimer();
    callStartedAtRef.current = Date.now();
    callTimerRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      setCallDuration(Math.floor((Date.now() - callStartedAtRef.current) / 1000));
    }, 1000);
  }, [clearCallTimer]);

  const endLogicalCall = useCallback(() => {
    callActiveRef.current = false;
    if (mountedRef.current) setCallActive(false);
    clearCallTimer();
    setInGracePeriod(false);
    setGraceProgress(0);
    awaitResponseRef.current = null;
  }, [clearCallTimer]);

  const fullCleanup = useCallback(() => {
    bump("surface");
    bump("call");
    bump("utterance");
    bump("response");
    releasePhysical();
    endLogicalCall();
    setPhaseSafe("idle");
  }, [bump, endLogicalCall, releasePhysical, setPhaseSafe]);

  // Mount / unmount
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      bump("surface");
      bump("call");
      bump("utterance");
      bump("response");
      releasePhysical();
      if (callTimerRef.current) clearInterval(callTimerRef.current);
    };
  }, [bump, releasePhysical]);

  // Disable / settings provider change — invalidate and release.
  useLayoutEffect(() => {
    if (!enabled) {
      fullCleanup();
      setErrorSafe(null);
    }
  }, [enabled, fullCleanup, setErrorSafe]);

  const settingsIdentity = settingsIdentityKey(settings);
  const settingsIdentityRef = useRef(settingsIdentity);
  useLayoutEffect(() => {
    if (settingsIdentityRef.current === settingsIdentity) return;
    settingsIdentityRef.current = settingsIdentity;
    // Confirmed settings identity changed — drop physical work; no silent privacy fallback.
    releasePhysical();
    if (callActiveRef.current) {
      bump("call");
      endLogicalCall();
      setPhaseSafe("idle");
    } else if (phaseRef.current !== "idle" && phaseRef.current !== "error") {
      bump("utterance");
      setPhaseSafe("idle");
    }
  }, [settingsIdentity, bump, endLogicalCall, releasePhysical, setPhaseSafe]);

  // Session change ends the call (skip the initial mount value).
  const sessionSeenRef = useRef(activeSessionId);
  useEffect(() => {
    if (sessionSeenRef.current === activeSessionId) return;
    sessionSeenRef.current = activeSessionId;
    if (!callActiveRef.current) return;
    bump("call");
    releasePhysical();
    endLogicalCall();
    setPhaseSafe("idle");
  }, [activeSessionId, bump, endLogicalCall, releasePhysical, setPhaseSafe]);

  const browserSttAvailable = fixture ? true : isBrowserSttAvailable();
  const ttsAvailable = resolveTtsAvailable(settings, localTts, Boolean(fixture));
  const sttReady = resolveSttReady(settings, localStt, Boolean(fixture));

  const showPttButton =
    enabled && !fixture?.hidePttButton && settings.voice_mode === "push_to_talk" && sttReady;

  const showCallButton =
    enabled && !fixture?.hideCallButton && sttReady && ttsAvailable && !fixture?.callActive;

  const privacyNote = settings.stt_provider === "browser" ? BROWSER_STT_PRIVACY_NOTE : null;

  const speakText = useCallback(
    async (text: string, responseGen: number, callGen: number) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!isLive({ response: responseGen, call: callGen })) return;

      setPhaseSafe("speaking");
      const controller = new AbortController();
      resourcesRef.current.abortControllers.push(controller);

      const conf = settingsRef.current;
      try {
        if (localTts?.status === "ready") {
          resourcesRef.current.browserTtsCancel = () => localTts.cancel();
          await localTts.speak(trimmed, {
            signal: controller.signal,
            voice: conf.tts_voice,
          });
        } else if (isCloudTts(conf)) {
          const result = await createVoiceSpeech(trimmed, { signal: controller.signal });
          if (!isLive({ response: responseGen, call: callGen })) return;
          if (result.status !== "ok") {
            if (result.error.code !== "aborted") setErrorSafe(result.error);
            return;
          }
          const playback = playCloudAudioBlob(result.blob, { signal: controller.signal });
          resourcesRef.current.cloudPlaybackStop = () => playback.stop();
          await playback.done;
        } else if (conf.tts_provider === "browser" && conf.tts_enabled) {
          await whenBrowserVoicesReady();
          if (!isLive({ response: responseGen, call: callGen })) return;
          const playback = speakBrowserTts(trimmed, {
            voice: conf.tts_voice,
            signal: controller.signal,
          });
          resourcesRef.current.browserTtsCancel = () => playback.cancel();
          await playback.done;
        }
      } catch {
        // Best-effort TTS — return to listening without hard fail.
      }
      resourcesRef.current.cloudPlaybackStop = null;
      resourcesRef.current.browserTtsCancel = null;
      if (!isLive({ response: responseGen, call: callGen })) return;
      if (callActiveRef.current) {
        setPhaseSafe("listening");
        // Resume VAD after terminal playback.
        const vad = resourcesRef.current.vad;
        if (vad) void vad.resume();
      } else {
        setPhaseSafe("idle");
      }
    },
    [isLive, localTts, setErrorSafe, setPhaseSafe],
  );

  // Observe exactly one new terminal assistant message for the pending voice turn.
  useEffect(() => {
    const pending = awaitResponseRef.current;
    if (!pending) return;
    if (!isLive({ call: pending.callGen, response: pending.responseGen })) return;

    if (isStreaming) {
      if (phaseRef.current === "transcribing" || phaseRef.current === "listening") {
        setPhaseSafe("thinking");
      }
      return;
    }

    // Streaming finished — find new terminal assistant.
    const fresh = messagesRef.current.filter(
      (m) =>
        !pending.seenIds.has(m.id) &&
        m.role === "assistant" &&
        !m.isError &&
        (m.status === "completed" || m.status === "cancelled" || m.status === "failed") &&
        !m.streaming,
    );
    const target = fresh[fresh.length - 1];
    awaitResponseRef.current = null;

    if (!target || target.status !== "completed" || !target.text.trim()) {
      if (callActiveRef.current) {
        setPhaseSafe("listening");
        void resourcesRef.current.vad?.resume();
      } else {
        setPhaseSafe("idle");
      }
      return;
    }

    if (spokenMessageIdsRef.current.has(target.id)) {
      if (callActiveRef.current) setPhaseSafe("listening");
      else setPhaseSafe("idle");
      return;
    }
    spokenMessageIdsRef.current.add(target.id);

    if (!settingsRef.current.tts_enabled) {
      if (callActiveRef.current) {
        setPhaseSafe("listening");
        void resourcesRef.current.vad?.resume();
      } else {
        setPhaseSafe("idle");
      }
      return;
    }

    void speakText(target.text, pending.responseGen, pending.callGen);
  }, [isStreaming, messages, isLive, setPhaseSafe, speakText]);

  const submitTranscript = useCallback(
    async (transcript: string, utteranceGen: number, callGen: number) => {
      const cleaned = transcript.trim();
      if (!cleaned || cleaned === "[BLANK_AUDIO]") {
        if (callActiveRef.current && isLive({ call: callGen })) {
          setPhaseSafe("listening");
          void resourcesRef.current.vad?.resume();
        } else if (isLive({ utterance: utteranceGen })) {
          setPhaseSafe("idle");
        }
        return;
      }
      if (!isLive({ utterance: utteranceGen, call: callActiveRef.current ? callGen : undefined })) {
        return;
      }

      const shouldSend = callActiveRef.current || autoSend;
      if (!shouldSend) {
        setPhaseSafe("idle");
        return;
      }

      const responseGen = bump("response");
      awaitResponseRef.current = {
        responseGen,
        callGen: callActiveRef.current ? callGen : generationsRef.current.call,
        seenIds: new Set(messagesRef.current.map((m) => m.id)),
      };
      setPhaseSafe("thinking");
      try {
        await sendMessage(cleaned);
      } catch {
        awaitResponseRef.current = null;
        if (isLive({ response: responseGen })) {
          setErrorSafe(voiceError("unknown"));
          setPhaseSafe(callActiveRef.current ? "listening" : "error");
        }
      }
    },
    [autoSend, bump, isLive, sendMessage, setErrorSafe, setPhaseSafe],
  );

  const transcribeBlob = useCallback(
    async (blob: Blob, utteranceGen: number, callGen: number) => {
      if (!isLive({ utterance: utteranceGen, call: callActiveRef.current ? callGen : undefined })) {
        return;
      }
      setPhaseSafe("transcribing");
      const controller = new AbortController();
      resourcesRef.current.abortControllers.push(controller);

      const conf = settingsRef.current;
      try {
        let text = "";
        if (localStt?.status === "ready") {
          text = await localStt.transcribe(blob, { signal: controller.signal });
        } else if (isCloudStt(conf)) {
          const result = await createVoiceTranscription(blob, { signal: controller.signal });
          if (result.status !== "ok") {
            if (result.error.code !== "aborted" && isLive({ utterance: utteranceGen })) {
              setErrorSafe(result.error);
              setPhaseSafe(callActiveRef.current ? "listening" : "error");
              if (callActiveRef.current) void resourcesRef.current.vad?.resume();
            }
            return;
          }
          text = result.text;
        } else {
          // Browser STT cannot transcribe blobs — should not reach here.
          setErrorSafe(voiceError("unsupported"));
          setPhaseSafe(callActiveRef.current ? "listening" : "error");
          return;
        }
        await submitTranscript(text, utteranceGen, callGen);
      } catch {
        if (isLive({ utterance: utteranceGen })) {
          setErrorSafe(voiceError("unknown"));
          setPhaseSafe(callActiveRef.current ? "listening" : "error");
        }
      }
    },
    [isLive, localStt, setErrorSafe, setPhaseSafe, submitTranscript],
  );

  const startBrowserListening = useCallback(
    (utteranceGen: number, callGen: number, continuous = false) => {
      const controller = new AbortController();
      resourcesRef.current.abortControllers.push(controller);
      setPhaseSafe("listening");
      setErrorSafe(null);

      const handle: BrowserSttHandle = startBrowserStt({
        continuous,
        signal: controller.signal,
      });
      resourcesRef.current.recognition = handle;

      void handle.done.then((result) => {
        if (
          !isLive({ utterance: utteranceGen, call: callActiveRef.current ? callGen : undefined })
        ) {
          return;
        }
        resourcesRef.current.recognition = null;
        if (result.status === "final") {
          void submitTranscript(result.transcript, utteranceGen, callGen);
          return;
        }
        if (result.status === "error") {
          setErrorSafe(result.error);
          setPhaseSafe(callActiveRef.current ? "listening" : "error");
          return;
        }
        // empty — in call, restart listening; otherwise idle
        if (callActiveRef.current && continuous) {
          // loop handled by effect
          setPhaseSafe("listening");
        } else if (callActiveRef.current) {
          setPhaseSafe("listening");
        } else {
          setPhaseSafe("idle");
        }
      });
    },
    [isLive, setErrorSafe, setPhaseSafe, submitTranscript],
  );

  const startCloudPtt = useCallback(
    async (utteranceGen: number) => {
      setPhaseSafe("arming");
      setErrorSafe(null);
      const capture: PttCaptureHandle = createPttCapture({
        deviceId: microphoneId || undefined,
      });
      resourcesRef.current.recorder = capture;
      try {
        await capture.start();
        if (!isLive({ utterance: utteranceGen })) {
          capture.cancel();
          return;
        }
        setPhaseSafe("listening");
      } catch (err) {
        resourcesRef.current.recorder = null;
        const mapped =
          err && typeof err === "object" && "code" in err && "message" in err
            ? (err as VoiceError)
            : voiceError("audio_capture");
        setErrorSafe(mapped);
        setPhaseSafe("error");
      }
    },
    [isLive, microphoneId, setErrorSafe, setPhaseSafe],
  );

  const stopCloudPtt = useCallback(
    async (utteranceGen: number) => {
      const capture = resourcesRef.current.recorder;
      resourcesRef.current.recorder = null;
      if (!capture) {
        setPhaseSafe("idle");
        return;
      }
      setPhaseSafe("transcribing");
      const result = await capture.stop();
      if (!isLive({ utterance: utteranceGen })) return;
      if (result.status === "blob") {
        await transcribeBlob(result.blob, utteranceGen, generationsRef.current.call);
        return;
      }
      if (result.status === "error") {
        setErrorSafe(result.error);
        setPhaseSafe("error");
        return;
      }
      setPhaseSafe("idle");
    },
    [isLive, setErrorSafe, setPhaseSafe, transcribeBlob],
  );

  const togglePushToTalk = useCallback(() => {
    if (fixture) return;
    if (!enabled) return;
    if (callActiveRef.current) return;

    if (phaseRef.current === "listening" || phaseRef.current === "arming") {
      const utteranceGen = generationsRef.current.utterance;
      const conf = settingsRef.current;
      if (conf.stt_provider === "browser" && !isCloudStt(conf)) {
        // stop() flushes final; invalidate only after requesting stop
        const handle = resourcesRef.current.recognition;
        handle?.stop();
        return;
      }
      void stopCloudPtt(utteranceGen);
      return;
    }

    if (phaseRef.current === "transcribing" || phaseRef.current === "thinking") return;

    // Start
    bump("utterance");
    const utteranceGen = generationsRef.current.utterance;
    releasePhysical();
    const conf = settingsRef.current;
    if (conf.stt_provider === "browser" && !isCloudStt(conf)) {
      if (!browserSttAvailable) {
        setErrorSafe(voiceError("unsupported"));
        setPhaseSafe("error");
        return;
      }
      startBrowserListening(utteranceGen, generationsRef.current.call, false);
      return;
    }
    void startCloudPtt(utteranceGen);
  }, [
    browserSttAvailable,
    bump,
    enabled,
    fixture,
    releasePhysical,
    setErrorSafe,
    setPhaseSafe,
    startBrowserListening,
    startCloudPtt,
    stopCloudPtt,
  ]);

  const startCall = useCallback(() => {
    if (fixture) return;
    if (!enabled || callActiveRef.current) return;
    if (!sttReady || !ttsAvailable) return;

    bump("call");
    const callGen = generationsRef.current.call;
    bump("utterance");
    releasePhysical();
    spokenMessageIdsRef.current = new Set();
    callActiveRef.current = true;
    setCallActive(true);
    startCallTimer();
    setErrorSafe(null);
    setPhaseSafe("arming");

    const conf = settingsRef.current;
    const useVad =
      conf.voice_mode === "hands_free" ||
      isCloudStt(conf) ||
      localStt?.status === "ready" ||
      conf.stt_provider !== "browser";

    void (async () => {
      if (!isLive({ call: callGen })) return;

      // Optional short greeting via TTS when available.
      if (ttsAvailable) {
        const responseGen = bump("response");
        await speakText("Hey! What can I help you with today?", responseGen, callGen);
        if (!isLive({ call: callGen })) return;
      }

      if (useVad) {
        const session: VadSession = createVadSession({
          gracePeriodMs: conf.grace_period_ms,
          deviceId: microphoneId || undefined,
          callbacks: {
            onGraceChange: ({ active, progress }) => {
              if (!isLive({ call: callGen })) return;
              setInGracePeriod(active);
              setGraceProgress(progress);
            },
            onSpeechEnd: (wav) => {
              if (!isLive({ call: callGen })) return;
              const nextUtterance = bump("utterance");
              void (async () => {
                await resourcesRef.current.vad?.pause();
                await transcribeBlob(wav, nextUtterance, callGen);
              })();
            },
            onError: (err) => {
              if (!isLive({ call: callGen })) return;
              if (isPermissionVoiceError(err)) {
                setErrorSafe(err);
              } else {
                setErrorSafe(err);
              }
            },
          },
        });
        resourcesRef.current.vad = session;
        await session.start();
        if (!isLive({ call: callGen })) {
          await session.destroy();
          return;
        }
        setPhaseSafe("listening");
        return;
      }

      // Browser STT loop during call (driven by the listening effect).
      if (!browserSttAvailable) {
        setErrorSafe(voiceError("unsupported"));
        setPhaseSafe("error");
        return;
      }
      setPhaseSafe("listening");
    })();
  }, [
    browserSttAvailable,
    bump,
    enabled,
    fixture,
    isLive,
    localStt?.status,
    microphoneId,
    releasePhysical,
    setErrorSafe,
    setPhaseSafe,
    speakText,
    startCallTimer,
    sttReady,
    ttsAvailable,
    transcribeBlob,
  ]);

  // Browser STT recognition loop while in call + listening.
  useEffect(() => {
    if (fixture) return;
    if (!isCallActive) return;
    if (phase !== "listening") return;
    const conf = settings;
    const useBrowserLoop =
      conf.stt_provider === "browser" && !isCloudStt(conf) && localStt?.status !== "ready";
    if (!useBrowserLoop) return;
    if (!browserSttAvailable) return;

    const callGen = generationsRef.current.call;
    const utteranceGen = bump("utterance");
    const controller = new AbortController();
    resourcesRef.current.abortControllers.push(controller);

    const handle = startBrowserStt({ signal: controller.signal, continuous: false });
    resourcesRef.current.recognition = handle;

    let cancelled = false;
    void handle.done.then((result) => {
      if (cancelled) return;
      if (!isLive({ call: callGen })) return;
      resourcesRef.current.recognition = null;
      if (result.status === "final") {
        void submitTranscript(result.transcript, utteranceGen, callGen);
        return;
      }
      if (result.status === "error") {
        setErrorSafe(result.error);
        return;
      }
      // empty — effect restarts when phase stays listening
      if (phaseRef.current === "listening" && callActiveRef.current) {
        setRecognitionRetry((n) => n + 1);
      }
    });

    const bag = resourcesRef.current;
    return () => {
      cancelled = true;
      handle.abort();
      if (bag.recognition === handle) {
        bag.recognition = null;
      }
    };
    // recognitionRetry intentionally retriggers the loop after empty results
  }, [
    browserSttAvailable,
    bump,
    fixture,
    isCallActive,
    isLive,
    localStt?.status,
    phase,
    recognitionRetry,
    setErrorSafe,
    settings,
    submitTranscript,
  ]);

  const endCall = useCallback(() => {
    bump("call");
    bump("utterance");
    bump("response");
    releasePhysical();
    endLogicalCall();
    setErrorSafe(null);
    setPhaseSafe("idle");
  }, [bump, endLogicalCall, releasePhysical, setErrorSafe, setPhaseSafe]);

  const stop = useCallback(() => {
    // Invalidate generations first, then durable cancel, then physical.
    bump("utterance");
    bump("response");
    awaitResponseRef.current = null;
    void stopConversation();
    // Abort speech/recognition but keep call resources if active.
    const bag = resourcesRef.current;
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
    if (callActiveRef.current) {
      setPhaseSafe("listening");
      void bag.vad?.resume();
    } else {
      releasePhysical();
      setPhaseSafe("idle");
    }
  }, [bump, releasePhysical, setPhaseSafe, stopConversation]);

  const retryRecognition = useCallback(() => {
    setErrorSafe(null);
    setRecognitionRetry((n) => n + 1);
    if (callActiveRef.current) {
      setPhaseSafe("listening");
    } else if (settings.voice_mode === "push_to_talk") {
      togglePushToTalk();
    }
  }, [setErrorSafe, setPhaseSafe, settings.voice_mode, togglePushToTalk]);

  const dismissError = useCallback(() => {
    setErrorSafe(null);
    if (phaseRef.current === "error") setPhaseSafe("idle");
  }, [setErrorSafe, setPhaseSafe]);

  // Fixture presentation override
  const fixturePhase = fixture?.callActive
    ? fixture.callState === "processing"
      ? "thinking"
      : fixture.callState === "greeting"
        ? "arming"
        : (fixture.callState ?? "listening")
    : phase;

  const result = useMemo<UseVoiceControllerResult>(() => {
    const effectivePhase = fixture ? (fixturePhase as VoicePhase) : phase;
    const effectiveError =
      fixture?.buttonPermissionError || fixture?.recognitionError
        ? voiceError(
            "permission_denied",
            fixture.buttonPermissionError ??
              fixture.recognitionError ??
              MICROPHONE_PERMISSION_GUIDANCE,
          )
        : error;
    const buttonState = fixture?.buttonState
      ? fixture.buttonState
      : phaseToButtonState(effectivePhase, effectiveError);
    const callState = fixture?.callActive
      ? (fixture.callState ?? "listening")
      : phaseToCallState(effectivePhase);

    return {
      phase: effectivePhase,
      error: effectiveError,
      isCallActive: fixture?.callActive ?? isCallActive,
      callState: fixture?.callActive ? (fixture.callState ?? "listening") : callState,
      callDuration: fixture?.callDuration ?? callDuration,
      isInGracePeriod: fixture?.isInGracePeriod ?? isInGracePeriod,
      gracePeriodProgress: fixture?.gracePeriodProgress ?? gracePeriodProgress,
      buttonState,
      showPttButton: fixture
        ? !fixture.hidePttButton && settings.voice_mode === "push_to_talk"
        : showPttButton,
      showCallButton: fixture ? !fixture.hideCallButton && !fixture.callActive : showCallButton,
      ttsAvailable,
      browserSttAvailable,
      privacyNote,
      recognitionError:
        fixture?.recognitionError ??
        (isPermissionVoiceError(effectiveError) ? (effectiveError?.message ?? null) : null),
      togglePushToTalk,
      startCall,
      endCall,
      stop,
      retryRecognition,
      dismissError,
    };
  }, [
    browserSttAvailable,
    callDuration,
    dismissError,
    endCall,
    error,
    fixture,
    fixturePhase,
    gracePeriodProgress,
    isCallActive,
    isInGracePeriod,
    phase,
    privacyNote,
    retryRecognition,
    settings.voice_mode,
    showCallButton,
    showPttButton,
    startCall,
    stop,
    togglePushToTalk,
    ttsAvailable,
  ]);

  return result;
}
