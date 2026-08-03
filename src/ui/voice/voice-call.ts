/**
 * Hands-free / voice-call cycle owner (VAD + browser STT loop).
 *
 * Start Call arms generations, optional greeting TTS, then VAD or browser loop.
 * Pause listening before transcription; resume only after terminal playback.
 */

import { startBrowserStt } from "./browser-stt";
import { isPermissionVoiceError, voiceError } from "./speech-errors";
import { createVadSession, type VadSession } from "./vad-session";
import { isCloudStt, isLocalSttSelected } from "./voice-capabilities";
import { startCallTimer, type VoiceRuntime } from "./voice-runtime";
import { speakText, submitTranscript } from "./voice-speech";
import { transcribeBlob } from "./voice-ptt";

export type StartCallOptions = {
  fixture: boolean;
  sttReady: boolean;
  ttsAvailable: boolean;
  browserSttAvailable: boolean;
};

export function startCall(rt: VoiceRuntime, options: StartCallOptions): void {
  if (options.fixture) return;
  if (!rt.enabled || rt.callActive.current) return;
  if (!options.sttReady || !options.ttsAvailable) return;

  rt.bump("call");
  const callGen = rt.generations.current.call;
  rt.bump("utterance");
  rt.releasePhysical();
  rt.spokenMessageIds.current = new Set();
  rt.callActive.current = true;
  rt.setCallActive(true);
  startCallTimer(rt);
  rt.setError(null);
  rt.setPhase("arming");

  const conf = rt.settings.current;
  // Local STT selection uses VAD capture (WAV) — never the browser recognition loop.
  const useVad =
    conf.voice_mode === "hands_free" ||
    isCloudStt(conf) ||
    isLocalSttSelected(rt.localStt) ||
    conf.stt_provider !== "browser";

  void (async () => {
    if (!rt.isLive({ call: callGen })) return;

    if (options.ttsAvailable) {
      const responseGen = rt.bump("response");
      await speakText(rt, "Hey! What can I help you with today?", responseGen, callGen);
      if (!rt.isLive({ call: callGen })) return;
    }

    if (useVad) {
      const session: VadSession = createVadSession({
        gracePeriodMs: conf.grace_period_ms,
        deviceId: rt.microphoneId || undefined,
        callbacks: {
          onGraceChange: ({ active, progress }) => {
            if (!rt.isLive({ call: callGen })) return;
            rt.setInGracePeriod(active);
            rt.setGraceProgress(progress);
          },
          onSpeechEnd: (wav) => {
            if (!rt.isLive({ call: callGen })) return;
            const nextUtterance = rt.bump("utterance");
            void (async () => {
              await rt.resources.current.vad?.pause();
              await transcribeBlob(rt, wav, nextUtterance, callGen);
            })();
          },
          onError: (err) => {
            if (!rt.isLive({ call: callGen })) return;
            rt.setError(err);
            void isPermissionVoiceError(err);
          },
        },
      });
      rt.resources.current.vad = session;
      await session.start();
      if (!rt.isLive({ call: callGen })) {
        await session.destroy();
        return;
      }
      rt.setPhase("listening");
      return;
    }

    if (!options.browserSttAvailable) {
      rt.setError(voiceError("unsupported"));
      rt.setPhase("error");
      return;
    }
    rt.setPhase("listening");
  })();
}

export type BrowserCallLoopOptions = {
  fixture: boolean;
  isCallActive: boolean;
  phase: string;
  browserSttAvailable: boolean;
};

/**
 * One browser-STT recognition attempt while a call is listening.
 * Returns a cleanup that aborts the active handle.
 */
export function beginBrowserCallListenLoop(
  rt: VoiceRuntime,
  options: BrowserCallLoopOptions,
): (() => void) | null {
  if (options.fixture) return null;
  if (!options.isCallActive) return null;
  if (options.phase !== "listening") return null;
  const conf = rt.settings.current;
  // Browser recognition loop only when no local adapter is selected.
  const useBrowserLoop =
    conf.stt_provider === "browser" && !isCloudStt(conf) && !isLocalSttSelected(rt.localStt);
  if (!useBrowserLoop) return null;
  if (!options.browserSttAvailable) return null;

  const callGen = rt.generations.current.call;
  const utteranceGen = rt.bump("utterance");
  const controller = new AbortController();
  rt.resources.current.abortControllers.push(controller);

  const handle = startBrowserStt({ signal: controller.signal, continuous: false });
  rt.resources.current.recognition = handle;

  let cancelled = false;
  void handle.done.then((result) => {
    if (cancelled) return;
    if (!rt.isLive({ call: callGen })) return;
    rt.resources.current.recognition = null;
    if (result.status === "final") {
      void submitTranscript(rt, result.transcript, utteranceGen, callGen);
      return;
    }
    if (result.status === "error") {
      rt.setError(result.error);
      return;
    }
    if (rt.phase.current === "listening" && rt.callActive.current) {
      rt.setRecognitionRetry((n) => n + 1);
    }
  });

  const bag = rt.resources.current;
  return () => {
    cancelled = true;
    handle.abort();
    if (bag.recognition === handle) {
      bag.recognition = null;
    }
  };
}
