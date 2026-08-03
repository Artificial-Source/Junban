/**
 * Terminal assistant matching + TTS playback owner.
 *
 * Speaks only the one new completed assistant message bound to the current
 * response generation. Late/stale messages never speak.
 */

import type { ChatMessageView } from "../ai/message-view";
import { speakBrowserTts, whenBrowserVoicesReady } from "./browser-tts";
import { createVoiceSpeech, playCloudAudioBlob } from "./cloud-speech";
import { voiceError } from "./speech-errors";
import { isCloudTts, isLocalTtsSelected } from "./voice-capabilities";
import { resumeListeningOrIdle, type VoiceRuntime } from "./voice-runtime";

/** Speak text under an exact response+call generation fence. */
export async function speakText(
  rt: VoiceRuntime,
  text: string,
  responseGen: number,
  callGen: number,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (!rt.isLive({ response: responseGen, call: callGen })) return;

  rt.setPhase("speaking");
  const controller = new AbortController();
  rt.resources.current.abortControllers.push(controller);

  const conf = rt.settings.current;
  const localTts = rt.localTts;
  try {
    // Cloud confirmed never yields to local.
    if (isCloudTts(conf)) {
      const result = await createVoiceSpeech(trimmed, { signal: controller.signal });
      if (!rt.isLive({ response: responseGen, call: callGen })) return;
      if (result.status !== "ok") {
        if (result.error.code !== "aborted") rt.setError(result.error);
        return;
      }
      const playback = playCloudAudioBlob(result.blob, { signal: controller.signal });
      rt.resources.current.cloudPlaybackStop = () => playback.stop();
      await playback.done;
    } else if (localTts?.status === "ready") {
      rt.resources.current.browserTtsCancel = () => localTts.cancel();
      await localTts.speak(trimmed, {
        signal: controller.signal,
        voice: conf.tts_voice,
      });
    } else if (isLocalTtsSelected(localTts)) {
      // Explicit local TTS selected but not ready — suppress Browser TTS.
      return;
    } else if (conf.tts_provider === "browser" && conf.tts_enabled) {
      await whenBrowserVoicesReady();
      if (!rt.isLive({ response: responseGen, call: callGen })) return;
      const playback = speakBrowserTts(trimmed, {
        voice: conf.tts_voice,
        signal: controller.signal,
      });
      rt.resources.current.browserTtsCancel = () => playback.cancel();
      await playback.done;
    }
  } catch {
    // Best-effort TTS — return to listening without hard fail.
  }
  rt.resources.current.cloudPlaybackStop = null;
  rt.resources.current.browserTtsCancel = null;
  if (!rt.isLive({ response: responseGen, call: callGen })) return;
  resumeListeningOrIdle(rt);
}

/**
 * Observe streaming/messages and speak exactly one new terminal assistant
 * for the pending voice turn. Safe to call from a React effect body.
 */
export function observeTerminalAssistant(
  rt: VoiceRuntime,
  isStreaming: boolean,
  messages: ChatMessageView[],
): void {
  const pending = rt.awaitResponse.current;
  if (!pending) return;
  if (!rt.isLive({ call: pending.callGen, response: pending.responseGen })) return;

  if (isStreaming) {
    if (rt.phase.current === "transcribing" || rt.phase.current === "listening") {
      rt.setPhase("thinking");
    }
    return;
  }

  const fresh = messages.filter(
    (m) =>
      !pending.seenIds.has(m.id) &&
      m.role === "assistant" &&
      !m.isError &&
      (m.status === "completed" || m.status === "cancelled" || m.status === "failed") &&
      !m.streaming,
  );
  const target = fresh[fresh.length - 1];
  rt.awaitResponse.current = null;

  if (!target || target.status !== "completed" || !target.text.trim()) {
    resumeListeningOrIdle(rt);
    return;
  }

  if (rt.spokenMessageIds.current.has(target.id)) {
    if (rt.callActive.current) rt.setPhase("listening");
    else rt.setPhase("idle");
    return;
  }
  rt.spokenMessageIds.current.add(target.id);

  if (!rt.settings.current.tts_enabled) {
    resumeListeningOrIdle(rt);
    return;
  }

  void speakText(rt, target.text, pending.responseGen, pending.callGen);
}

/** Queue a transcript as a chat turn and arm terminal-assistant observation. */
export async function submitTranscript(
  rt: VoiceRuntime,
  transcript: string,
  utteranceGen: number,
  callGen: number,
): Promise<void> {
  const cleaned = transcript.trim();
  if (!cleaned || cleaned === "[BLANK_AUDIO]") {
    if (rt.callActive.current && rt.isLive({ call: callGen })) {
      rt.setPhase("listening");
      void rt.resources.current.vad?.resume();
    } else if (rt.isLive({ utterance: utteranceGen })) {
      rt.setPhase("idle");
    }
    return;
  }
  if (!rt.isLive({ utterance: utteranceGen, call: rt.callActive.current ? callGen : undefined })) {
    return;
  }

  const shouldSend = rt.callActive.current || rt.autoSend;
  if (!shouldSend) {
    rt.setPhase("idle");
    return;
  }

  const responseGen = rt.bump("response");
  rt.awaitResponse.current = {
    responseGen,
    callGen: rt.callActive.current ? callGen : rt.generations.current.call,
    seenIds: new Set(rt.messages.current.map((m) => m.id)),
  };
  rt.setPhase("thinking");
  try {
    await rt.sendMessage(cleaned);
  } catch {
    rt.awaitResponse.current = null;
    if (rt.isLive({ response: responseGen })) {
      rt.setError(voiceError("unknown"));
      rt.setPhase(rt.callActive.current ? "listening" : "error");
    }
  }
}
