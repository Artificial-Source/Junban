/**
 * Browser SpeechRecognition adapter.
 *
 * Best-effort: recognition may use a vendor cloud service. Callers must disclose
 * that privacy note in Settings / UI. Abort uses recognition.abort(); intentional
 * stop uses recognition.stop() to flush a final result when available.
 */

import { mapSpeechRecognitionError, voiceError, isAbortLike } from "./speech-errors";
import type { VoiceError } from "./types";

export type BrowserSttResult =
  | { status: "final"; transcript: string }
  | { status: "empty" }
  | { status: "error"; error: VoiceError };

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
};

type SpeechRecognitionResultEventLike = {
  results: ArrayLike<{
    isFinal?: boolean;
    0?: { transcript?: string };
  }>;
  resultIndex?: number;
};

type SpeechRecognitionErrorEventLike = {
  error: string;
};

export type BrowserSttHandle = {
  /** True while the recognition session is live. */
  readonly active: boolean;
  /** Resolve when recognition settles (final, empty, error, or abort). */
  readonly done: Promise<BrowserSttResult>;
  /** Flush: request a final result then end. */
  stop: () => void;
  /** Cancel without treating the result as speech. */
  abort: () => void;
};

export function detectSpeechRecognitionCtor(
  scope: unknown = typeof window !== "undefined" ? window : undefined,
): SpeechRecognitionCtor | null {
  if (!scope || typeof scope !== "object") return null;
  const record = scope as Record<string, unknown>;
  const ctor = record.SpeechRecognition ?? record.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as SpeechRecognitionCtor) : null;
}

export function isBrowserSttAvailable(
  scope: unknown = typeof window !== "undefined" ? window : undefined,
): boolean {
  return detectSpeechRecognitionCtor(scope) !== null;
}

export type StartBrowserSttOptions = {
  lang?: string;
  continuous?: boolean;
  interimResults?: boolean;
  signal?: AbortSignal;
  /** Optional ctor injection for tests. */
  Recognition?: SpeechRecognitionCtor | null;
  onInterim?: (transcript: string) => void;
};

/**
 * Start one recognition session. AbortSignal and handle.abort() cancel via abort();
 * handle.stop() requests a flushed final via stop().
 */
export function startBrowserStt(options: StartBrowserSttOptions = {}): BrowserSttHandle {
  const Recognition =
    options.Recognition === undefined ? detectSpeechRecognitionCtor() : options.Recognition;
  if (!Recognition) {
    const error = voiceError("unsupported");
    return settledHandle({ status: "error", error });
  }
  if (options.signal?.aborted) {
    return settledHandle({ status: "empty" });
  }

  let active = true;
  let settled = false;
  let recognition: SpeechRecognitionLike | null = null;
  let finalizeMode: "stop" | "abort" | null = null;
  let finals = "";

  let resolveDone!: (result: BrowserSttResult) => void;
  const done = new Promise<BrowserSttResult>((resolve) => {
    resolveDone = resolve;
  });

  const detach = () => {
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.onstart = null;
  };

  const settle = (result: BrowserSttResult) => {
    if (settled) return;
    settled = true;
    active = false;
    detach();
    options.signal?.removeEventListener("abort", onAbort);
    resolveDone(result);
  };

  const onAbort = () => {
    if (settled) return;
    finalizeMode = "abort";
    try {
      recognition?.abort();
    } catch {
      // already ended
    }
    settle({ status: "empty" });
  };

  try {
    recognition = new Recognition();
    recognition.continuous = Boolean(options.continuous);
    recognition.interimResults = options.interimResults ?? true;
    recognition.lang = options.lang ?? "en-US";
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      if (settled) return;
      let interim = "";
      let sawFinal = false;
      for (let i = event.resultIndex ?? 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result?.[0]?.transcript ?? "";
        // Explicit interim results never finalize the session.
        if (result && result.isFinal === false) {
          interim += text;
          continue;
        }
        // Final (or engines that omit isFinal) contribute to the committed transcript.
        finals += text;
        sawFinal = true;
      }
      if (interim && options.onInterim) {
        options.onInterim(interim);
      }
      if (!options.continuous && sawFinal && finals.trim()) {
        settle({ status: "final", transcript: finals.trim() });
        try {
          recognition?.stop();
        } catch {
          // ignore
        }
      }
    };

    recognition.onerror = (event) => {
      if (settled) return;
      if (finalizeMode === "abort" || event.error === "aborted") {
        settle({ status: "empty" });
        return;
      }
      if (event.error === "no-speech") {
        settle({ status: "empty" });
        return;
      }
      settle({ status: "error", error: mapSpeechRecognitionError(event.error) });
    };

    recognition.onend = () => {
      if (settled) return;
      if (finalizeMode === "abort") {
        settle({ status: "empty" });
        return;
      }
      const transcript = finals.trim();
      if (transcript) {
        settle({ status: "final", transcript });
        return;
      }
      settle({ status: "empty" });
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return {
        get active() {
          return active;
        },
        done,
        stop: () => undefined,
        abort: () => undefined,
      };
    }

    recognition.start();
  } catch (error) {
    if (isAbortLike(error)) {
      settle({ status: "empty" });
    } else {
      settle({ status: "error", error: voiceError("unknown") });
    }
  }

  return {
    get active() {
      return active;
    },
    done,
    stop: () => {
      if (settled) return;
      finalizeMode = "stop";
      try {
        recognition?.stop();
      } catch {
        settle(
          finals.trim() ? { status: "final", transcript: finals.trim() } : { status: "empty" },
        );
      }
    },
    abort: () => {
      onAbort();
    },
  };
}

function settledHandle(result: BrowserSttResult): BrowserSttHandle {
  return {
    active: false,
    done: Promise.resolve(result),
    stop: () => undefined,
    abort: () => undefined,
  };
}
