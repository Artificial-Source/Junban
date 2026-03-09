/**
 * Voice call mode orchestration hook.
 * Manages a state machine: idle → greeting → listening → processing → speaking → listening → ...
 * Wires VAD → STT → AI → TTS in a continuous loop until the user ends the call.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("voice");

export type CallState = "idle" | "greeting" | "listening" | "processing" | "speaking";

export interface UseVoiceCallOptions {
  /** speak() function from VoiceContext */
  speak: (text: string) => Promise<void>;
  /** cancelSpeech() from VoiceContext */
  cancelSpeech: () => void;
  /** Whether TTS is currently speaking */
  isSpeaking: boolean;
  /** Whether the AI is currently streaming a response */
  isStreaming: boolean;
  /** The most recent messages array */
  messages: { role: string; content: string; isError?: boolean }[];
  /** Whether TTS is enabled and a provider is available */
  ttsAvailable: boolean;
  /** Callback to set voice call mode on AIContext */
  setVoiceCallMode: (active: boolean) => void;
}

export interface UseVoiceCallReturn {
  callState: CallState;
  isCallActive: boolean;
  callDuration: number;
  startCall: () => void;
  endCall: () => void;
  /** Whether VAD should be enabled for this call */
  vadEnabled: boolean;
}

const GREETING = "Hey! What can I help you with today?";

export function useVoiceCall({
  speak,
  cancelSpeech,
  isSpeaking,
  isStreaming,
  messages,
  ttsAvailable,
  setVoiceCallMode,
}: UseVoiceCallOptions): UseVoiceCallReturn {
  const [callState, setCallState] = useState<CallState>("idle");
  const [callDuration, setCallDuration] = useState(0);
  const callStartTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wasStreamingRef = useRef(false);
  const wasSpeakingRef = useRef(false);

  const isCallActive = callState !== "idle";

  // Debug helper — log state transitions
  const setCallStateDebug = useCallback((next: CallState, reason: string) => {
    setCallState((prev) => {
      log.debug(`${prev} → ${next} (${reason})`);
      return next;
    });
  }, []);

  // ── Call duration timer ──
  useEffect(() => {
    if (isCallActive) {
      if (!callStartTimeRef.current) {
        callStartTimeRef.current = Date.now();
      }
      timerRef.current = setInterval(() => {
        setCallDuration(Math.floor((Date.now() - callStartTimeRef.current) / 1000));
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      callStartTimeRef.current = 0;
      setCallDuration(0);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isCallActive]);

  // ── TTS finished: greeting → listening OR speaking → listening ──
  useEffect(() => {
    const wasSpeaking = wasSpeakingRef.current;
    wasSpeakingRef.current = isSpeaking;

    if (isCallActive) {
      log.debug("isSpeaking transition", { from: wasSpeaking, to: isSpeaking, callState });
    }

    if (wasSpeaking && !isSpeaking) {
      if (callState === "greeting" || callState === "speaking") {
        setCallStateDebug("listening", `TTS finished (was ${callState})`);
      }
    }
  }, [isSpeaking, callState, isCallActive, setCallStateDebug]);

  // ── Processing → speaking transition ──
  // When AI finishes streaming, speak the last assistant message
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;

    if (isCallActive) {
      log.debug("isStreaming transition", { from: wasStreaming, to: isStreaming, callState });
    }

    if (callState === "processing" && wasStreaming && !isStreaming) {
      const lastMsg = messages[messages.length - 1];
      log.debug("AI done streaming", {
        role: lastMsg?.role,
        hasContent: !!lastMsg?.content,
        contentLength: lastMsg?.content?.length,
        isError: lastMsg?.isError,
        ttsAvailable,
      });
      if (lastMsg?.role === "assistant" && lastMsg.content && !lastMsg.isError && ttsAvailable) {
        setCallStateDebug("speaking", "AI response ready, speaking via TTS");
        speak(lastMsg.content).catch((err) => {
          log.warn("TTS failed during speaking", { error: String(err) });
          setCallStateDebug("listening", "TTS failed, back to listening");
        });
      } else {
        setCallStateDebug("listening", "no content to speak or TTS unavailable");
      }
    }
  }, [isStreaming, callState, messages, speak, ttsAvailable, isCallActive, setCallStateDebug]);

  // ── Start call ──
  const startCall = useCallback(() => {
    if (isCallActive) return;
    log.debug("startCall()", { ttsAvailable });
    setVoiceCallMode(true);
    setCallStateDebug("greeting", "call started");

    if (ttsAvailable) {
      speak(GREETING)
        .then(() => {
          log.debug("greeting speak() resolved");
        })
        .catch((err) => {
          log.warn("greeting TTS failed", { error: String(err) });
          setCallStateDebug("listening", "greeting TTS failed");
        });
    } else {
      log.debug("no TTS, skipping greeting");
      setCallStateDebug("listening", "no TTS available");
    }
  }, [isCallActive, speak, ttsAvailable, setVoiceCallMode, setCallStateDebug]);

  // ── End call ──
  const endCall = useCallback(() => {
    log.debug("endCall()");
    cancelSpeech();
    setCallStateDebug("idle", "call ended");
    setVoiceCallMode(false);
  }, [cancelSpeech, setVoiceCallMode, setCallStateDebug]);

  // ── Handle speech input during call ──
  // This is controlled externally: when VAD detects speech and STT transcribes,
  // AIChatPanel's handleVADSpeechEnd calls sendMessage, which sets isStreaming.
  // We detect isStreaming going true while in "listening" to move to "processing".
  useEffect(() => {
    if (callState === "listening" && isStreaming) {
      setCallStateDebug("processing", "isStreaming went true while listening");
    }
  }, [isStreaming, callState, setCallStateDebug]);

  // ── Interruption: user speaks while AI is speaking ──
  // This is handled by the VAD enabled state — if we allow VAD during speaking,
  // the transcription callback can cancel speech and process new input.
  // For now, VAD is only enabled during "listening" to keep things simple.

  const vadEnabled = callState === "listening";

  return {
    callState,
    isCallActive,
    callDuration,
    startCall,
    endCall,
    vadEnabled,
  };
}
