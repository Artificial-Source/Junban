/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceSpeech, createVoiceTranscription, playCloudAudioBlob } from "./cloud-speech";
import { MAX_SPEECH_AUDIO_BYTES } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("cloud-speech transport", () => {
  it("posts multipart audio with exact field name and MIME, no retry", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/v1/voice/transcriptions");
      expect(init && init.method).toBe("POST");
      const headers = (init && init.headers) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-token");
      expect(headers["Content-Type"]).toBeUndefined();
      const body = (init && init.body) as FormData;
      expect(body).toBeInstanceOf(FormData);
      const file = body.get("audio");
      expect(file).toBeInstanceOf(Blob);
      expect((file as Blob).type).toBe("audio/webm");
      return new Response(JSON.stringify({ text: "hello" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await createVoiceTranscription(
      new Blob([new Uint8Array([1, 2])], { type: "audio/webm;codecs=opus" }),
      { fetchImpl: fetchImpl as unknown as typeof fetch, getToken: () => "test-token" },
    );
    expect(result).toEqual({ status: "ok", text: "hello" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects empty/unsupported/>25MiB before fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      createVoiceTranscription(new Blob([]), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getToken: () => "t",
      }),
    ).resolves.toMatchObject({ status: "error", error: { code: "empty_audio" } });
    await expect(
      createVoiceTranscription(new Blob([new Uint8Array([1])]), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getToken: () => "t",
      }),
    ).resolves.toMatchObject({ status: "error", error: { code: "unsupported_mime" } });
    const big = new Blob([new Uint8Array(MAX_SPEECH_AUDIO_BYTES + 1)], { type: "audio/wav" });
    await expect(
      createVoiceTranscription(big, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getToken: () => "t",
      }),
    ).resolves.toMatchObject({ status: "error", error: { code: "audio_too_large" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts strict {text} for TTS and validates no-store binary type/size", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ text: "Hi there" }));
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "content-type": "audio/mpeg",
          "cache-control": "no-store",
        },
      });
    });
    const ok = await createVoiceSpeech("Hi there", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getToken: () => "tok",
    });
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") {
      expect(ok.mime).toBe("audio/mpeg");
      expect(ok.blob.size).toBe(4);
    }

    const badType = vi.fn(
      async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );
    await expect(
      createVoiceSpeech("x", {
        fetchImpl: badType as unknown as typeof fetch,
        getToken: () => "tok",
      }),
    ).resolves.toMatchObject({ status: "error", error: { code: "invalid_response" } });

    const missingNoStore = vi.fn(
      async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "audio/wav", "cache-control": "max-age=0" },
        }),
    );
    await expect(
      createVoiceSpeech("x", {
        fetchImpl: missingNoStore as unknown as typeof fetch,
        getToken: () => "tok",
      }),
    ).resolves.toMatchObject({ status: "error", error: { code: "invalid_response" } });
  });

  it("aborts in-flight requests and never logs tokens", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const pending = createVoiceTranscription(
      new Blob([new Uint8Array([1])], { type: "audio/wav" }),
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        getToken: () => "super-secret-token-value",
        signal: controller.signal,
        timeoutMs: null,
      },
    );
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: "error", error: { code: "aborted" } });
    expect(JSON.stringify(result)).not.toContain("super-secret-token-value");
  });

  it("plays blob audio then pause/reset/revokes URL", async () => {
    const revoke = vi.fn();
    const create = vi.fn(() => "blob:test-url");
    const audio = {
      preload: "",
      src: "",
      onended: null as null | (() => void),
      onerror: null as null | (() => void),
      pause: vi.fn(),
      load: vi.fn(),
      removeAttribute: vi.fn(),
      play: vi.fn(async () => {
        queueMicrotask(() => audio.onended?.());
      }),
    };
    const playback = playCloudAudioBlob(new Blob([new Uint8Array([1])], { type: "audio/mpeg" }), {
      audioElement: audio as unknown as HTMLAudioElement,
      createObjectUrl: create,
      revokeObjectUrl: revoke,
    });
    await playback.done;
    expect(create).toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:test-url");
  });
});
