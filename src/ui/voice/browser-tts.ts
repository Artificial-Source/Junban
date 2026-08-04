/**
 * Browser speechSynthesis adapter.
 *
 * cancel() before every new utterance and on Stop/End/unmount. Voices load
 * asynchronously via voiceschanged — exact selected voice is applied when found.
 */

import { voiceError } from "./speech-errors";

export type BrowserTtsVoice = {
  id: string;
  name: string;
  lang: string;
  default: boolean;
};

export type BrowserTtsSpeakOptions = {
  voice?: string | null;
  rate?: number;
  pitch?: number;
  lang?: string;
  signal?: AbortSignal;
  /** Injection for tests. */
  synthesis?: SpeechSynthesisLike | null;
};

type SpeechSynthesisLike = {
  speaking: boolean;
  pending: boolean;
  cancelled?: boolean;
  getVoices: () => SpeechSynthesisVoiceLike[];
  speak: (utterance: SpeechSynthesisUtteranceLike) => void;
  cancel: () => void;
  addEventListener?: (type: "voiceschanged", listener: () => void) => void;
  removeEventListener?: (type: "voiceschanged", listener: () => void) => void;
  onvoiceschanged: (() => void) | null;
};

type SpeechSynthesisVoiceLike = {
  voiceURI: string;
  name: string;
  lang: string;
  default: boolean;
};

type SpeechSynthesisUtteranceLike = {
  text: string;
  voice: SpeechSynthesisVoiceLike | null;
  rate: number;
  pitch: number;
  lang: string;
  onend: ((ev: unknown) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
};

type UtteranceCtor = new (text: string) => SpeechSynthesisUtteranceLike;

function getSynthesis(injected?: SpeechSynthesisLike | null): SpeechSynthesisLike | null {
  if (injected !== undefined) return injected;
  if (typeof window === "undefined") return null;
  return (window.speechSynthesis as unknown as SpeechSynthesisLike) ?? null;
}

function getUtteranceCtor(): UtteranceCtor | null {
  if (typeof SpeechSynthesisUtterance === "undefined") return null;
  return SpeechSynthesisUtterance as unknown as UtteranceCtor;
}

export function isBrowserTtsAvailable(synthesis?: SpeechSynthesisLike | null): boolean {
  return getSynthesis(synthesis) !== null && getUtteranceCtor() !== null;
}

/** Snapshot available voices (may be empty until voiceschanged). */
export function listBrowserTtsVoices(synthesis?: SpeechSynthesisLike | null): BrowserTtsVoice[] {
  const synth = getSynthesis(synthesis);
  if (!synth) return [];
  return synth.getVoices().map((v) => ({
    id: v.voiceURI,
    name: v.name,
    lang: v.lang,
    default: v.default,
  }));
}

/**
 * Wait for voiceschanged (or resolve immediately when voices are present).
 * Never rejects; best-effort empty list on timeout.
 */
export function whenBrowserVoicesReady(
  options: { synthesis?: SpeechSynthesisLike | null; timeoutMs?: number } = {},
): Promise<BrowserTtsVoice[]> {
  const synth = getSynthesis(options.synthesis);
  if (!synth) return Promise.resolve([]);
  const existing = listBrowserTtsVoices(synth);
  if (existing.length > 0) return Promise.resolve(existing);

  const timeoutMs = options.timeoutMs ?? 1500;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(listBrowserTtsVoices(synth));
    };
    const onChange = () => finish();
    const cleanup = () => {
      synth.removeEventListener?.("voiceschanged", onChange);
      if (synth.onvoiceschanged === onChange) synth.onvoiceschanged = null;
      clearTimeout(timer);
    };
    synth.addEventListener?.("voiceschanged", onChange);
    synth.onvoiceschanged = onChange;
    const timer = setTimeout(finish, timeoutMs);
  });
}

export type BrowserTtsPlayback = {
  readonly done: Promise<void>;
  cancel: () => void;
};

/**
 * Speak text. Always cancels any prior synthesis first. Abort/cancel resolves
 * the promise without throwing so callers can continue half-duplex cleanly.
 */
export function speakBrowserTts(
  text: string,
  options: BrowserTtsSpeakOptions = {},
): BrowserTtsPlayback {
  const synth = getSynthesis(options.synthesis);
  const Utterance = getUtteranceCtor();
  if (!synth || !Utterance) {
    return {
      done: Promise.reject(voiceError("unsupported")),
      cancel: () => undefined,
    };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { done: Promise.resolve(), cancel: () => undefined };
  }

  let cancelled = false;
  let utterance: SpeechSynthesisUtteranceLike | null = null;

  const cancel = () => {
    cancelled = true;
    try {
      synth.cancel();
    } catch {
      // ignore
    }
  };

  if (options.signal?.aborted) {
    return { done: Promise.resolve(), cancel };
  }

  const onAbort = () => cancel();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  // Always clear the queue before a new utterance (Stop/End/unmount path too).
  try {
    synth.cancel();
  } catch {
    // ignore
  }

  const done = new Promise<void>((resolve, reject) => {
    try {
      utterance = new Utterance(trimmed);
      utterance.rate = clamp(options.rate ?? 1, 0.5, 2);
      utterance.pitch = clamp(options.pitch ?? 1, 0, 2);
      if (options.lang) utterance.lang = options.lang;

      const wanted = options.voice?.trim();
      if (wanted) {
        const voices = synth.getVoices();
        const match =
          voices.find((v) => v.voiceURI === wanted) ??
          voices.find((v) => v.name === wanted) ??
          null;
        if (match) utterance.voice = match;
      }

      utterance.onend = () => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      utterance.onerror = (event) => {
        options.signal?.removeEventListener("abort", onAbort);
        if (cancelled || event.error === "canceled" || event.error === "interrupted") {
          resolve();
          return;
        }
        reject(voiceError("playback_failed"));
      };

      if (cancelled || options.signal?.aborted) {
        resolve();
        return;
      }
      synth.speak(utterance);
    } catch {
      options.signal?.removeEventListener("abort", onAbort);
      reject(voiceError("playback_failed"));
    }
  });

  return { done, cancel };
}

/** Cancel any queued/playing browser speech (idempotent). */
export function cancelBrowserTts(synthesis?: SpeechSynthesisLike | null): void {
  const synth = getSynthesis(synthesis);
  if (!synth) return;
  try {
    synth.cancel();
  } catch {
    // ignore
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
