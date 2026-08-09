/**
 * Push-to-talk capture + transcription owner.
 *
 * Browser STT uses live recognition; cloud/local STT uses MediaRecorder blobs.
 * No automatic provider fallback after failure.
 */

import { startBrowserStt, type BrowserSttHandle } from "./browser-stt";
import { createVoiceTranscription } from "./cloud-speech";
import { createPttCapture, type PttCaptureHandle } from "./media-recorder";
import { voiceError } from "./speech-errors";
import type { VoiceError } from "./types";
import { isCloudStt, isLocalSttSelected } from "./voice-capabilities";
import { submitTranscript } from "./voice-speech";
import type { VoiceRuntime } from "./voice-runtime";

export async function transcribeBlob(
  rt: VoiceRuntime,
  blob: Blob,
  utteranceGen: number,
  callGen: number,
): Promise<void> {
  if (!rt.isLive({ utterance: utteranceGen, call: rt.callActive.current ? callGen : undefined })) {
    return;
  }
  rt.setPhase("transcribing");
  const controller = new AbortController();
  rt.resources.current.abortControllers.push(controller);

  const conf = rt.settings.current;
  const localStt = rt.localStt;
  try {
    let text = "";
    // Cloud confirmed never yields to local — even if a local adapter is ready.
    if (isCloudStt(conf)) {
      const result = await createVoiceTranscription(blob, { signal: controller.signal });
      if (result.status !== "ok") {
        if (result.error.code !== "aborted" && rt.isLive({ utterance: utteranceGen })) {
          rt.setError(result.error);
          rt.setPhase(rt.callActive.current ? "listening" : "error");
          if (rt.callActive.current) void rt.resources.current.vad?.resume();
        }
        return;
      }
      text = result.text;
    } else if (localStt?.status === "ready") {
      text = await localStt.transcribe(blob, { signal: controller.signal });
    } else if (isLocalSttSelected(localStt)) {
      // Explicit local selection that is not ready — never Browser fallback.
      rt.setError(voiceError("unsupported", "Local speech model is not ready."));
      rt.setPhase(rt.callActive.current ? "listening" : "error");
      if (rt.callActive.current) void rt.resources.current.vad?.resume();
      return;
    } else {
      // Browser STT cannot transcribe blobs — should not reach here.
      rt.setError(voiceError("unsupported"));
      rt.setPhase(rt.callActive.current ? "listening" : "error");
      return;
    }
    await submitTranscript(rt, text, utteranceGen, callGen);
  } catch (error) {
    if (rt.isLive({ utterance: utteranceGen })) {
      if (error && typeof error === "object" && "code" in error && "message" in error) {
        rt.setError(error as VoiceError);
      } else {
        rt.setError(voiceError("unknown"));
      }
      rt.setPhase(rt.callActive.current ? "listening" : "error");
    }
  }
}

export function startBrowserListening(
  rt: VoiceRuntime,
  utteranceGen: number,
  callGen: number,
  continuous = false,
): void {
  const controller = new AbortController();
  rt.resources.current.abortControllers.push(controller);
  rt.setPhase("listening");
  rt.setError(null);

  const handle: BrowserSttHandle = startBrowserStt({
    continuous,
    signal: controller.signal,
  });
  rt.resources.current.recognition = handle;

  void handle.done.then((result) => {
    if (
      !rt.isLive({ utterance: utteranceGen, call: rt.callActive.current ? callGen : undefined })
    ) {
      return;
    }
    rt.resources.current.recognition = null;
    if (result.status === "final") {
      void submitTranscript(rt, result.transcript, utteranceGen, callGen);
      return;
    }
    if (result.status === "error") {
      rt.setError(result.error);
      rt.setPhase(rt.callActive.current ? "listening" : "error");
      return;
    }
    if (rt.callActive.current) {
      rt.setPhase("listening");
    } else {
      rt.setPhase("idle");
    }
  });
}

export async function startCloudPtt(rt: VoiceRuntime, utteranceGen: number): Promise<void> {
  rt.setPhase("arming");
  rt.setError(null);
  const capture: PttCaptureHandle = createPttCapture({
    deviceId: rt.microphoneId || undefined,
  });
  rt.resources.current.recorder = capture;
  try {
    await capture.start();
    if (!rt.isLive({ utterance: utteranceGen })) {
      capture.cancel();
      return;
    }
    rt.setPhase("listening");
  } catch (err) {
    rt.resources.current.recorder = null;
    const mapped =
      err && typeof err === "object" && "code" in err && "message" in err
        ? (err as VoiceError)
        : voiceError("audio_capture");
    rt.setError(mapped);
    rt.setPhase("error");
  }
}

export async function stopCloudPtt(rt: VoiceRuntime, utteranceGen: number): Promise<void> {
  const capture = rt.resources.current.recorder;
  rt.resources.current.recorder = null;
  if (!capture) {
    rt.setPhase("idle");
    return;
  }
  rt.setPhase("transcribing");
  const result = await capture.stop();
  if (!rt.isLive({ utterance: utteranceGen })) return;
  if (result.status === "blob") {
    await transcribeBlob(rt, result.blob, utteranceGen, rt.generations.current.call);
    return;
  }
  if (result.status === "error") {
    rt.setError(result.error);
    rt.setPhase("error");
    return;
  }
  rt.setPhase("idle");
}

export type TogglePttOptions = {
  fixture: boolean;
  browserSttAvailable: boolean;
};

/** Start or stop push-to-talk for the current utterance generation. */
export function togglePushToTalk(rt: VoiceRuntime, options: TogglePttOptions): void {
  if (options.fixture) return;
  if (!rt.enabled) return;
  if (rt.callActive.current) return;

  const conf = rt.settings.current;
  const useBrowserRecognition =
    conf.stt_provider === "browser" && !isCloudStt(conf) && !isLocalSttSelected(rt.localStt);
  const useBlobCapture = isCloudStt(conf) || isLocalSttSelected(rt.localStt);

  if (rt.phase.current === "listening" || rt.phase.current === "arming") {
    const utteranceGen = rt.generations.current.utterance;
    if (useBrowserRecognition) {
      // stop() flushes final; do not invalidate before requesting stop.
      rt.resources.current.recognition?.stop();
      return;
    }
    void stopCloudPtt(rt, utteranceGen);
    return;
  }

  if (rt.phase.current === "transcribing" || rt.phase.current === "thinking") return;

  rt.bump("utterance");
  const utteranceGen = rt.generations.current.utterance;
  rt.releasePhysical();

  // Explicit local selection: MediaRecorder capture only when ready — never Browser STT.
  if (isLocalSttSelected(rt.localStt)) {
    if (rt.localStt?.status !== "ready") {
      rt.setError(voiceError("unsupported", "Local speech model is not ready."));
      rt.setPhase("error");
      return;
    }
    void startCloudPtt(rt, utteranceGen);
    return;
  }

  if (useBrowserRecognition) {
    if (!options.browserSttAvailable) {
      rt.setError(voiceError("unsupported"));
      rt.setPhase("error");
      return;
    }
    startBrowserListening(rt, utteranceGen, rt.generations.current.call, false);
    return;
  }

  if (useBlobCapture) {
    void startCloudPtt(rt, utteranceGen);
  }
}
