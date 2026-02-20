/**
 * React hook wrapping @ricky0123/vad-web for voice activity detection.
 * Supports smart endpoint detection with a configurable grace period.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { float32ToWav } from "../../ai/voice/audio-utils.js";

interface UseVADProps {
  onSpeechStart?: () => void;
  onSpeechEnd?: (audio: Blob) => void;
  enabled: boolean;
  deviceId?: string;
  /** Enable smart endpoint detection (buffer audio during pauses). */
  smartEndpoint?: boolean;
  /** Grace period in ms to wait after speech ends before finalizing. Default: 1500. */
  gracePeriodMs?: number;
}

interface UseVADReturn {
  isListening: boolean;
  isSpeaking: boolean;
  start: () => Promise<void>;
  stop: () => void;
  isSupported: boolean;
  /** True when in grace period (user paused but may continue). */
  isInGracePeriod: boolean;
  /** Progress of grace period from 0 to 1. */
  gracePeriodProgress: number;
}

export function useVAD({
  onSpeechStart,
  onSpeechEnd,
  enabled,
  deviceId,
  smartEndpoint = false,
  gracePeriodMs = 1500,
}: UseVADProps): UseVADReturn {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const [isInGracePeriod, setIsInGracePeriod] = useState(false);
  const [gracePeriodProgress, setGracePeriodProgress] = useState(0);
  const vadRef = useRef<any>(null);
  const onSpeechStartRef = useRef(onSpeechStart);
  const onSpeechEndRef = useRef(onSpeechEnd);

  // Smart endpoint state
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceAnimRef = useRef<number | null>(null);
  const graceStartRef = useRef<number>(0);
  const audioBufferRef = useRef<Float32Array[]>([]);

  // Keep callback refs up to date
  onSpeechStartRef.current = onSpeechStart;
  onSpeechEndRef.current = onSpeechEnd;

  const deviceIdRef = useRef(deviceId);
  deviceIdRef.current = deviceId;

  const smartEndpointRef = useRef(smartEndpoint);
  smartEndpointRef.current = smartEndpoint;

  const gracePeriodMsRef = useRef(gracePeriodMs);
  gracePeriodMsRef.current = gracePeriodMs;

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
    if (graceAnimRef.current) {
      cancelAnimationFrame(graceAnimRef.current);
      graceAnimRef.current = null;
    }
    setIsInGracePeriod(false);
    setGracePeriodProgress(0);
  }, []);

  const flushAudioBuffer = useCallback(() => {
    clearGraceTimer();
    const chunks = audioBufferRef.current;
    audioBufferRef.current = [];
    if (chunks.length === 0) return;

    // Concatenate all buffered audio
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    const wavBlob = float32ToWav(combined, 16000);
    onSpeechEndRef.current?.(wavBlob);
  }, [clearGraceTimer]);

  const start = useCallback(async () => {
    if (vadRef.current) return;

    try {
      console.log("[VAD] Loading @ricky0123/vad-web...");
      const { MicVAD } = await import("@ricky0123/vad-web");
      const vadOptions: any = {
        onSpeechStart: () => {
          console.log("[VAD] Speech started");
          setIsSpeaking(true);

          // If in grace period, cancel the timer — user is speaking again
          if (smartEndpointRef.current && graceTimerRef.current) {
            console.log("[VAD] Speech resumed during grace period");
            clearGraceTimer();
          }

          onSpeechStartRef.current?.();
        },
        onSpeechEnd: (audio: Float32Array) => {
          console.log("[VAD] Speech ended, audio samples:", audio.length);
          setIsSpeaking(false);

          if (smartEndpointRef.current) {
            // Buffer the audio and start grace timer
            audioBufferRef.current.push(audio);
            setIsInGracePeriod(true);
            graceStartRef.current = Date.now();

            // Animate progress
            const animate = () => {
              const elapsed = Date.now() - graceStartRef.current;
              const progress = Math.min(elapsed / gracePeriodMsRef.current, 1);
              setGracePeriodProgress(progress);
              if (progress < 1) {
                graceAnimRef.current = requestAnimationFrame(animate);
              }
            };
            graceAnimRef.current = requestAnimationFrame(animate);

            graceTimerRef.current = setTimeout(() => {
              console.log("[VAD] Grace period expired, flushing audio");
              flushAudioBuffer();
            }, gracePeriodMsRef.current);
          } else {
            const wavBlob = float32ToWav(audio, 16000);
            onSpeechEndRef.current?.(wavBlob);
          }
        },
      };
      if (deviceIdRef.current) {
        vadOptions.additionalAudioConstraints = {
          deviceId: { exact: deviceIdRef.current },
        };
      }
      const vad = await MicVAD.new(vadOptions);

      vadRef.current = vad;
      vad.start();
      setIsListening(true);
      console.log("[VAD] Started successfully");
    } catch (err) {
      console.warn("[VAD] Failed to initialize:", err);
      setIsSupported(false);
    }
  }, [clearGraceTimer, flushAudioBuffer]);

  const stop = useCallback(() => {
    // Flush any buffered audio before stopping
    if (audioBufferRef.current.length > 0) {
      flushAudioBuffer();
    }
    clearGraceTimer();
    if (vadRef.current) {
      vadRef.current.pause();
      vadRef.current.destroy();
      vadRef.current = null;
    }
    setIsListening(false);
    setIsSpeaking(false);
  }, [flushAudioBuffer, clearGraceTimer]);

  // Auto-start/stop when enabled changes
  useEffect(() => {
    if (enabled) {
      start();
    } else {
      stop();
    }
    return () => {
      stop();
    };
  }, [enabled, start, stop]);

  return {
    isListening,
    isSpeaking,
    start,
    stop,
    isSupported,
    isInGracePeriod,
    gracePeriodProgress,
  };
}
