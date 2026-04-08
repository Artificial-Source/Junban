import { useState, useRef, useCallback } from "react";
import { Mic, Loader2, Volume2 } from "lucide-react";
import type { useVoiceContext } from "../../context/VoiceContext.js";

type AudioRecorder = {
  start: () => Promise<void>;
  stop: () => Promise<Blob>;
};

type BrowserLikeSTTProvider = {
  startLiveRecognition: () => Promise<string>;
};

interface VoiceButtonProps {
  onResult: (text: string) => void;
  disabled: boolean;
  voice: ReturnType<typeof useVoiceContext>;
}

export function VoiceButton({ onResult, disabled, voice }: VoiceButtonProps) {
  const [listening, setListening] = useState(false);
  const recorderRef = useRef<AudioRecorder | null>(null);

  const { settings, sttProvider, isTranscribing, isSpeaking } = voice;

  const handlePushToTalk = useCallback(async () => {
    if (listening) {
      setListening(false);
      if (sttProvider?.id === "browser-stt") {
        return;
      }
      if (recorderRef.current) {
        try {
          const blob = await recorderRef.current.stop();
          const transcript = await voice.transcribeAudio(blob);
          onResult(transcript);
        } catch {
          // Transcription failed
        }
        recorderRef.current = null;
      }
      return;
    }

    setListening(true);
    if (sttProvider?.id === "browser-stt" && "startLiveRecognition" in sttProvider) {
      try {
        const transcript = await (sttProvider as BrowserLikeSTTProvider).startLiveRecognition();
        if (transcript) onResult(transcript);
      } catch {
        // Recognition failed
      }
      setListening(false);
    } else {
      const { createAudioRecorder } = await import("../../../ai/voice/audio-utils.js");
      const recorder = createAudioRecorder(voice.settings.microphoneId || undefined);
      recorderRef.current = recorder;
      try {
        await recorder.start();
      } catch {
        setListening(false);
        recorderRef.current = null;
      }
    }
  }, [listening, sttProvider, voice, onResult]);

  if (settings.voiceMode === "off" || settings.voiceMode === "vad") return null;

  const buttonState = isTranscribing
    ? "transcribing"
    : isSpeaking
      ? "speaking"
      : listening
        ? "listening"
        : "idle";

  const title = {
    idle: "Voice input (push to talk)",
    listening: "Stop listening",
    transcribing: "Transcribing...",
    speaking: "AI speaking...",
  }[buttonState];

  const icon = {
    idle: <Mic size={16} />,
    listening: <Mic size={16} />,
    transcribing: <Loader2 size={16} className="animate-spin" />,
    speaking: <Volume2 size={16} className="animate-pulse" />,
  }[buttonState];

  const colorClass = {
    idle: "border-border text-on-surface-muted hover:bg-surface-secondary",
    listening:
      "bg-error/20 border-error text-error animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.4)]",
    transcribing: "bg-accent/10 border-accent/30 text-accent",
    speaking: "bg-success/10 border-success/30 text-success",
  }[buttonState];

  return (
    <button
      type="button"
      onClick={handlePushToTalk}
      disabled={disabled || isTranscribing}
      title={title}
      className={`shrink-0 px-2 py-2 text-sm rounded-lg border disabled:opacity-50 transition-colors ${colorClass}`}
    >
      {icon}
    </button>
  );
}
