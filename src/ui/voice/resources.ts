/**
 * Physical voice resource ownership — abort, stop tracks, destroy VAD,
 * cancel synthesis, pause audio, revoke URLs. Idempotent and race-safe.
 */

import type { BrowserSttHandle } from "./browser-stt";
import { cancelBrowserTts } from "./browser-tts";
import type { PttCaptureHandle } from "./media-recorder";
import type { VadSession } from "./vad-session";
import { stopMediaStream } from "./micPreferences";

export type VoiceResourceBag = {
  abortControllers: AbortController[];
  recognition: BrowserSttHandle | null;
  recorder: PttCaptureHandle | null;
  vad: VadSession | null;
  mediaStreams: MediaStream[];
  audioElements: HTMLAudioElement[];
  objectUrls: string[];
  pcmChunks: Float32Array[];
  blobChunks: Blob[];
  audioContexts: AudioContext[];
  removeListeners: Array<() => void>;
  cloudPlaybackStop: (() => void) | null;
  browserTtsCancel: (() => void) | null;
};

export function createResourceBag(): VoiceResourceBag {
  return {
    abortControllers: [],
    recognition: null,
    recorder: null,
    vad: null,
    mediaStreams: [],
    audioElements: [],
    objectUrls: [],
    pcmChunks: [],
    blobChunks: [],
    audioContexts: [],
    removeListeners: [],
    cloudPlaybackStop: null,
    browserTtsCancel: null,
  };
}

/**
 * Tear down every owned physical resource. Safe to call repeatedly.
 * Does not touch logical/controller state — invalidate generations first.
 */
export function releaseVoiceResources(bag: VoiceResourceBag): void {
  // Abort in-flight fetches/recognition signals first.
  for (const controller of bag.abortControllers.splice(0)) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }

  const recognition = bag.recognition;
  bag.recognition = null;
  try {
    recognition?.abort();
  } catch {
    // ignore
  }

  const recorder = bag.recorder;
  bag.recorder = null;
  try {
    recorder?.cancel();
  } catch {
    // ignore
  }

  const vad = bag.vad;
  bag.vad = null;
  if (vad) {
    void vad.destroy().catch(() => undefined);
  }

  for (const stream of bag.mediaStreams.splice(0)) {
    stopMediaStream(stream);
  }

  const stopPlayback = bag.cloudPlaybackStop;
  bag.cloudPlaybackStop = null;
  try {
    stopPlayback?.();
  } catch {
    // ignore
  }

  const cancelTts = bag.browserTtsCancel;
  bag.browserTtsCancel = null;
  try {
    cancelTts?.();
  } catch {
    // ignore
  }
  cancelBrowserTts();

  for (const audio of bag.audioElements.splice(0)) {
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch {
      // ignore
    }
  }

  for (const url of bag.objectUrls.splice(0)) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }

  bag.pcmChunks.splice(0);
  bag.blobChunks.splice(0);

  for (const ctx of bag.audioContexts.splice(0)) {
    try {
      void ctx.close();
    } catch {
      // ignore
    }
  }

  for (const remove of bag.removeListeners.splice(0)) {
    try {
      remove();
    } catch {
      // ignore
    }
  }
}
