/**
 * Feature-local authenticated cloud speech transport.
 *
 * STT: multipart field `audio` with exact MIME (no parameters), ≤25 MiB.
 * TTS: strict JSON `{ text }`; validate no-store binary audio/mpeg|audio/wav.
 * No auto-retry, chunking, truncation, or provider fallback — server owns
 * credentials/provider/model/voice.
 */

import {
  ApiError,
  NetworkError,
  getStoredToken,
  parseAuthenticatedResponse,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../api/client";
import { filenameForAudioMime, validateAudioBlob } from "./audio-utils";
import { isAbortLike, scrubDiagnostic, voiceError } from "./speech-errors";
import {
  ACCEPTED_TTS_RESPONSE_MIME,
  CLOUD_STT_FIELD_NAME,
  MAX_SPEECH_AUDIO_BYTES,
  MAX_SPEECH_TEXT_BYTES,
  VOICE_SPEECH_PATH,
  VOICE_TRANSCRIPTIONS_PATH,
  type VoiceError,
} from "./types";

export type CloudSpeechTransportOptions = {
  signal?: AbortSignal;
  timeoutMs?: number | null;
  /** Injected fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injected token resolver for tests. */
  getToken?: () => string | null;
};

export type CloudTranscriptionResult =
  { status: "ok"; text: string } | { status: "error"; error: VoiceError };

export type CloudSpeechAudioResult =
  { status: "ok"; blob: Blob; mime: string } | { status: "error"; error: VoiceError };

function authHeader(getToken: () => string | null): Record<string, string> {
  const token = getToken();
  if (!token) {
    throw new NetworkError("No access token available", false);
  }
  return { Authorization: `Bearer ${token}` };
}

function redactError(error: unknown): VoiceError {
  if (error instanceof ApiError) {
    return voiceError("invalid_response", scrubDiagnostic(error.message));
  }
  if (error instanceof NetworkError) {
    if (error.aborted) return voiceError("aborted");
    return voiceError("network", scrubDiagnostic(error.message));
  }
  if (isAbortLike(error)) return voiceError("aborted");
  return voiceError("unknown");
}

async function withTimeout(
  run: (signal: AbortSignal) => Promise<Response>,
  options: CloudSpeechTransportOptions,
): Promise<Response> {
  const timeoutMs =
    options.timeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : options.timeoutMs;
  const external = options.signal;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onExternal = () => controller.abort();
  if (external) {
    if (external.aborted) throw voiceError("aborted");
    external.addEventListener("abort", onExternal);
  }
  if (timeoutMs !== null && timeoutMs !== undefined) {
    timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      Math.max(1, timeoutMs),
    );
  }

  try {
    return await run(controller.signal);
  } catch (error) {
    if (timedOut) throw voiceError("network");
    if (isAbortLike(error) || external?.aborted) throw voiceError("aborted");
    throw redactError(error);
  } finally {
    if (timer) clearTimeout(timer);
    external?.removeEventListener("abort", onExternal);
  }
}

/**
 * Authenticated multipart transcription. Rejects unsupported/empty/>25MiB
 * before fetch. Never retries.
 */
export async function createVoiceTranscription(
  audio: Blob,
  options: CloudSpeechTransportOptions = {},
): Promise<CloudTranscriptionResult> {
  const validated = validateAudioBlob(audio);
  if ("code" in validated) {
    return { status: "error", error: validated };
  }

  const getToken = options.getToken ?? getStoredToken;
  const fetchImpl = options.fetchImpl ?? fetch;
  const form = new FormData();
  form.append(CLOUD_STT_FIELD_NAME, validated.blob, filenameForAudioMime(validated.mime));

  try {
    const response = await withTimeout(
      (signal) =>
        fetchImpl(VOICE_TRANSCRIPTIONS_PATH, {
          method: "POST",
          headers: authHeader(getToken),
          body: form,
          signal,
          credentials: "same-origin",
        }),
      options,
    );

    if (!response.ok) {
      try {
        await parseAuthenticatedResponse(response);
      } catch (error) {
        return { status: "error", error: redactError(error) };
      }
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: "error", error: voiceError("invalid_response") };
    }
    if (
      !body ||
      typeof body !== "object" ||
      typeof (body as { text?: unknown }).text !== "string"
    ) {
      return { status: "error", error: voiceError("invalid_response") };
    }
    const text = (body as { text: string }).text;
    if (new TextEncoder().encode(text).length > MAX_SPEECH_TEXT_BYTES) {
      return { status: "error", error: voiceError("invalid_response") };
    }
    return { status: "ok", text };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && "message" in error) {
      return { status: "error", error: error as VoiceError };
    }
    return { status: "error", error: redactError(error) };
  }
}

/**
 * Authenticated cloud TTS. Body is exactly `{ text }`. Validates content-type,
 * cache-control no-store, and size before returning bytes.
 */
export async function createVoiceSpeech(
  text: string,
  options: CloudSpeechTransportOptions = {},
): Promise<CloudSpeechAudioResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { status: "error", error: voiceError("invalid_response") };
  }
  if (new TextEncoder().encode(trimmed).length > MAX_SPEECH_TEXT_BYTES) {
    return { status: "error", error: voiceError("invalid_response") };
  }

  const getToken = options.getToken ?? getStoredToken;
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await withTimeout(
      (signal) =>
        fetchImpl(VOICE_SPEECH_PATH, {
          method: "POST",
          headers: {
            ...authHeader(getToken),
            "Content-Type": "application/json",
            Accept: "audio/mpeg, audio/wav",
          },
          body: JSON.stringify({ text: trimmed }),
          signal,
          credentials: "same-origin",
        }),
      options,
    );

    if (!response.ok) {
      try {
        await parseAuthenticatedResponse(response);
      } catch (error) {
        return { status: "error", error: redactError(error) };
      }
    }

    const rawType = response.headers.get("content-type") ?? "";
    const mime = rawType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!ACCEPTED_TTS_RESPONSE_MIME.includes(mime as (typeof ACCEPTED_TTS_RESPONSE_MIME)[number])) {
      return { status: "error", error: voiceError("invalid_response") };
    }

    const cacheControl = (response.headers.get("cache-control") ?? "").toLowerCase();
    if (!cacheControl.includes("no-store")) {
      return { status: "error", error: voiceError("invalid_response") };
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const n = Number(contentLength);
      if (Number.isFinite(n) && n > MAX_SPEECH_AUDIO_BYTES) {
        return { status: "error", error: voiceError("audio_too_large") };
      }
    }

    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error) {
      if (isAbortLike(error)) return { status: "error", error: voiceError("aborted") };
      return { status: "error", error: voiceError("network") };
    }
    if (buffer.byteLength <= 0) {
      return { status: "error", error: voiceError("empty_audio") };
    }
    if (buffer.byteLength > MAX_SPEECH_AUDIO_BYTES) {
      return { status: "error", error: voiceError("audio_too_large") };
    }

    return { status: "ok", blob: new Blob([buffer], { type: mime }), mime };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && "message" in error) {
      return { status: "error", error: error as VoiceError };
    }
    return { status: "error", error: redactError(error) };
  }
}

export type CloudAudioPlayback = {
  readonly done: Promise<void>;
  stop: () => void;
};

/**
 * Play a cloud TTS blob via HTMLAudioElement + object URL.
 * Always pause/reset/revoke on settle, stop, or unmount.
 */
export function playCloudAudioBlob(
  blob: Blob,
  options: {
    signal?: AbortSignal;
    audioElement?: HTMLAudioElement;
    createObjectUrl?: (blob: Blob) => string;
    revokeObjectUrl?: (url: string) => void;
  } = {},
): CloudAudioPlayback {
  const createUrl = options.createObjectUrl ?? URL.createObjectURL.bind(URL);
  const revokeUrl = options.revokeObjectUrl ?? URL.revokeObjectURL.bind(URL);
  const audio = options.audioElement ?? new Audio();
  let url: string | null = null;
  let stopped = false;

  const cleanup = () => {
    try {
      audio.pause();
    } catch {
      // ignore
    }
    try {
      audio.removeAttribute("src");
      audio.load();
    } catch {
      // ignore
    }
    if (url) {
      try {
        revokeUrl(url);
      } catch {
        // ignore
      }
      url = null;
    }
  };

  const stop = () => {
    stopped = true;
    cleanup();
  };

  if (options.signal?.aborted) {
    return { done: Promise.resolve(), stop };
  }

  const onAbort = () => stop();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const done = new Promise<void>((resolve, reject) => {
    try {
      url = createUrl(blob);
      audio.preload = "auto";
      audio.src = url;
      const settleOk = () => {
        options.signal?.removeEventListener("abort", onAbort);
        cleanup();
        resolve();
      };
      const settleErr = () => {
        options.signal?.removeEventListener("abort", onAbort);
        cleanup();
        if (stopped) resolve();
        else reject(voiceError("playback_failed"));
      };
      audio.onended = () => settleOk();
      audio.onerror = () => settleErr();
      const playResult = audio.play();
      if (playResult && typeof playResult.then === "function") {
        playResult.then(() => {
          if (stopped) settleOk();
        }, settleErr);
      }
    } catch {
      options.signal?.removeEventListener("abort", onAbort);
      cleanup();
      reject(voiceError("playback_failed"));
    }
  });

  return { done, stop };
}
