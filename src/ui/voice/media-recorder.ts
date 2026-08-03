/**
 * Push-to-talk MediaRecorder capture.
 *
 * Explicit gesture → getUserMedia(audio only) → supported MIME → bounded chunks →
 * stop/final dataavailable → immediately stop every track.
 */

import { selectMediaRecorderMime, stripMimeParameters } from "./audio-utils";
import { mapDomException, voiceError } from "./speech-errors";
import { stopMediaStream } from "./micPreferences";
import type { VoiceError } from "./types";
import { MAX_SPEECH_AUDIO_BYTES } from "./types";

export type PttCaptureResult =
  { status: "blob"; blob: Blob } | { status: "empty" } | { status: "error"; error: VoiceError };

export type PttCaptureHandle = {
  readonly active: boolean;
  start: () => Promise<void>;
  /** Stop recorder, wait for final dataavailable, stop every track. */
  stop: () => Promise<PttCaptureResult>;
  /** Abort without producing audio; always releases tracks. */
  cancel: () => void;
};

export type CreatePttCaptureOptions = {
  deviceId?: string;
  /** Injected for tests. */
  mediaDevices?: MediaDevices | null;
  MediaRecorderImpl?: typeof MediaRecorder;
  preferredMimeType?: string | null;
  timesliceMs?: number;
};

export function createPttCapture(options: CreatePttCaptureOptions = {}): PttCaptureHandle {
  const mediaDevices =
    options.mediaDevices === undefined
      ? typeof navigator !== "undefined"
        ? (navigator.mediaDevices ?? null)
        : null
      : options.mediaDevices;
  const MediaRecorderImpl =
    options.MediaRecorderImpl ?? (typeof MediaRecorder !== "undefined" ? MediaRecorder : undefined);

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let mimeType = "";
  let active = false;
  let started = false;
  let cancelled = false;
  let totalBytes = 0;

  const releaseTracks = () => {
    stopMediaStream(stream);
    stream = null;
  };

  const cancel = () => {
    cancelled = true;
    active = false;
    try {
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
        recorder.stop();
      }
    } catch {
      // ignore
    }
    recorder = null;
    chunks = [];
    totalBytes = 0;
    releaseTracks();
  };

  return {
    get active() {
      return active;
    },
    async start() {
      if (started) return;
      cancelled = false;
      if (!mediaDevices?.getUserMedia) {
        throw voiceError("unsupported");
      }
      if (!MediaRecorderImpl) {
        throw voiceError("unsupported");
      }

      const audioConstraints: MediaTrackConstraints = options.deviceId
        ? {
            deviceId: { exact: options.deviceId },
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          }
        : {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          };

      try {
        stream = await mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
      } catch (error) {
        releaseTracks();
        throw mapDomException(error);
      }

      if (cancelled) {
        releaseTracks();
        throw voiceError("aborted");
      }

      mimeType =
        options.preferredMimeType === undefined
          ? (selectMediaRecorderMime((m) => MediaRecorderImpl.isTypeSupported(m)) ?? "")
          : (options.preferredMimeType ?? "");

      chunks = [];
      totalBytes = 0;
      try {
        recorder = mimeType
          ? new MediaRecorderImpl(stream, { mimeType })
          : new MediaRecorderImpl(stream);
        mimeType = stripMimeParameters(recorder.mimeType || mimeType || "audio/webm");
      } catch {
        releaseTracks();
        throw voiceError("unsupported_mime");
      }

      recorder.ondataavailable = (event: BlobEvent) => {
        if (cancelled) return;
        if (event.data && event.data.size > 0) {
          totalBytes += event.data.size;
          if (totalBytes > MAX_SPEECH_AUDIO_BYTES) {
            cancel();
            return;
          }
          chunks.push(event.data);
        }
      };

      try {
        if (options.timesliceMs && options.timesliceMs > 0) {
          recorder.start(options.timesliceMs);
        } else {
          recorder.start();
        }
      } catch {
        releaseTracks();
        recorder = null;
        throw voiceError("audio_capture");
      }

      started = true;
      active = true;
    },
    stop() {
      return new Promise<PttCaptureResult>((resolve) => {
        if (cancelled) {
          resolve({ status: "empty" });
          return;
        }
        if (!recorder || !started) {
          releaseTracks();
          active = false;
          resolve({ status: "empty" });
          return;
        }

        const rec = recorder;
        const finish = (result: PttCaptureResult) => {
          active = false;
          recorder = null;
          chunks = [];
          releaseTracks();
          resolve(result);
        };

        rec.onerror = () => {
          finish({ status: "error", error: voiceError("audio_capture") });
        };

        rec.onstop = () => {
          if (cancelled) {
            finish({ status: "empty" });
            return;
          }
          if (totalBytes > MAX_SPEECH_AUDIO_BYTES) {
            finish({ status: "error", error: voiceError("audio_too_large") });
            return;
          }
          if (chunks.length === 0) {
            finish({ status: "empty" });
            return;
          }
          const type =
            stripMimeParameters(mimeType || rec.mimeType || "audio/webm") || "audio/webm";
          const blob = new Blob(chunks, { type });
          if (blob.size <= 0) {
            finish({ status: "empty" });
            return;
          }
          if (blob.size > MAX_SPEECH_AUDIO_BYTES) {
            finish({ status: "error", error: voiceError("audio_too_large") });
            return;
          }
          finish({ status: "blob", blob });
        };

        try {
          if (rec.state === "inactive") {
            finish({ status: "empty" });
            return;
          }
          // Request a final dataavailable before stop when supported.
          try {
            if (typeof rec.requestData === "function" && rec.state === "recording") {
              rec.requestData();
            }
          } catch {
            // ignore
          }
          rec.stop();
        } catch {
          finish({ status: "error", error: voiceError("audio_capture") });
        }
      });
    },
    cancel,
  };
}
