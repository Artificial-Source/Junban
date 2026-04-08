/**
 * Voice integration hook for AIChatPanel.
 * Encapsulates VAD, browser STT fallback, TTS auto-speak, and voice call setup.
 */

import { useRef, useEffect, useCallback } from "react";
import { useVoiceContext } from "../../context/VoiceContext.js";
import { useVAD } from "../../hooks/useVAD.js";
import { useVoiceCall } from "../../hooks/useVoiceCall.js";
import type { ChatMessage } from "../../../ai/types.js";

export interface UseAIChatVoiceOptions {
  isStreaming: boolean;
  messages: ChatMessage[];
  sendMessage: (text: string) => void;
  setVoiceCallMode: (active: boolean) => void;
}

export function useAIChatVoice({
  isStreaming,
  messages,
  sendMessage,
  setVoiceCallMode,
}: UseAIChatVoiceOptions) {
  const voice = useVoiceContext();
  const wasStreamingRef = useRef(false);

  useEffect(() => {
    void voice.ensureRegistryLoaded();
  }, [voice.ensureRegistryLoaded]);

  const ttsAvailable = !!(voice.ttsProvider && voice.settings.ttsEnabled);

  const voiceCall = useVoiceCall({
    speak: voice.speak,
    cancelSpeech: voice.cancelSpeech,
    isSpeaking: voice.isSpeaking,
    isStreaming,
    messages,
    ttsAvailable,
    setVoiceCallMode,
  });

  const handleVoiceResult = useCallback(
    (transcript: string) => {
      const cleaned = transcript.trim();
      if (!cleaned || cleaned === "[BLANK_AUDIO]") return;
      if (voiceCall.isCallActive || voice.settings.autoSend) {
        sendMessage(cleaned);
      } else {
        // Append to input — handled via ChatInput's own state
      }
    },
    [voice.settings.autoSend, sendMessage, voiceCall.isCallActive],
  );

  // VAD integration
  const handleVADSpeechEnd = useCallback(
    async (audio: Blob) => {
      try {
        const transcript = await voice.transcribeAudio(audio);
        handleVoiceResult(transcript);
      } catch {
        // VAD transcription failed
      }
    },
    [voice, handleVoiceResult],
  );

  const isNonBrowserSTT = voiceCall.isCallActive && voice.sttProvider?.id !== "browser-stt";
  const browserSTTAvailable =
    typeof window !== "undefined" &&
    ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

  const vadEnabled =
    (voice.settings.voiceMode === "vad" &&
      !isStreaming &&
      !voice.isSpeaking &&
      !voiceCall.isCallActive) ||
    (voiceCall.vadEnabled && isNonBrowserSTT);

  const vad = useVAD({
    onSpeechEnd: handleVADSpeechEnd,
    enabled: vadEnabled,
    deviceId: voice.settings.microphoneId || undefined,
    smartEndpoint: voice.settings.smartEndpoint,
    gracePeriodMs: voice.settings.gracePeriodMs,
  });

  const needBrowserSTTFallback =
    voiceCall.isCallActive &&
    (voice.sttProvider?.id === "browser-stt" || (isNonBrowserSTT && !vad.isSupported));
  const useBrowserSTTLoop = needBrowserSTTFallback && browserSTTAvailable;

  // Browser STT recognition loop
  const browserSTTRef = useRef<{ startLiveRecognition: () => Promise<string> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!browserSTTRef.current && browserSTTAvailable) {
      void import("../../../ai/voice/adapters/browser-stt.js").then(({ BrowserSTTProvider }) => {
        if (!cancelled && !browserSTTRef.current) {
          browserSTTRef.current = new BrowserSTTProvider();
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [browserSTTAvailable]);

  useEffect(() => {
    if (!useBrowserSTTLoop || voiceCall.callState !== "listening") return;
    const stt = browserSTTRef.current;
    if (!stt) return;
    let cancelled = false;

    const listen = async () => {
      while (!cancelled) {
        try {
          const transcript = await stt.startLiveRecognition();
          if (cancelled) break;
          const cleaned = transcript.trim();
          if (cleaned && cleaned !== "[BLANK_AUDIO]") {
            handleVoiceResult(cleaned);
            break;
          }
          await new Promise((r) => setTimeout(r, 200));
        } catch {
          if (cancelled) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    listen();
    return () => {
      cancelled = true;
    };
  }, [
    useBrowserSTTLoop,
    voiceCall.callState,
    handleVoiceResult,
    voiceCall.isCallActive,
    isNonBrowserSTT,
  ]);

  // TTS when AI finishes responding
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming) return;
    if (voiceCall.isCallActive) return;
    if (!voice.settings.ttsEnabled || voice.settings.voiceMode === "off") return;

    const lastMsg = messages[messages.length - 1];
    if (
      lastMsg?.role === "assistant" &&
      lastMsg.content &&
      !(lastMsg as unknown as Record<string, unknown>).isError
    ) {
      voice.speak(lastMsg.content).catch((err) => console.warn("[voice] TTS failed:", err));
    }
  }, [isStreaming, messages, voice, voiceCall.isCallActive]);

  const showCallButton = !!(voice.sttProvider && ttsAvailable);

  return {
    voice,
    voiceCall,
    vad,
    handleVoiceResult,
    ttsAvailable,
    showCallButton,
    isNonBrowserSTT,
  };
}
