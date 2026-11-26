/**
 * Dynamic-only Kokoro engine owner.
 *
 * kokoro-js is imported only inside functions. Verified weights and the exact
 * af_heart voice seed must already be present; missing cache fails closed with
 * no network model fallback. Synthesis uses q8/wasm and only af_heart.
 */

import type { RawAudio } from "@huggingface/transformers";
import type { KokoroTTS as KokoroModel } from "kokoro-js";
import { getLocalVoicePackage } from "../manifest.ts";
import { LocalVoiceClientError, validatePcmAudioOut, validateSynthesisText } from "../protocol.ts";
import { loadKokoroRuntimeAssets } from "../same-origin-assets.ts";
import { reverifyCachedPackage, streamVerifiedFile } from "../verify-fetch.ts";
import { configureVerifiedTransformers } from "./configure-transformers.ts";

export const KOKORO_PACKAGE_ID = "kokoro-82m-v1-q8";
export const KOKORO_VOICE_ID = "af_heart" as const;
export const KOKORO_DTYPE = "q8" as const;
export const KOKORO_DEVICE = "wasm" as const;
export const KOKORO_SAMPLE_RATE_HZ = 24_000;

export type KokoroLoadOptions = {
  signal?: AbortSignal;
};

export type KokoroAudioResult = {
  readonly pcm: Float32Array;
  readonly sampleRate: number;
  readonly channels: number;
  /** Transferable copy of PCM bytes. */
  readonly transferable: ArrayBuffer;
};

export type KokoroEngineHandle = {
  readonly packageId: string;
  readonly modelId: string;
  readonly revision: string;
  readonly voiceId: typeof KOKORO_VOICE_ID;
  synthesize: (text: string) => Promise<KokoroAudioResult>;
  dispose: () => Promise<void>;
};

/**
 * Seed the voice style cache entry expected by kokoro-js after the Junban patch.
 * Requires the verified af_heart.bin store object — never fetches voice bytes.
 */
export async function seedKokoroVoiceCache(options: KokoroLoadOptions = {}): Promise<void> {
  if (options.signal?.aborted) {
    throw new LocalVoiceClientError("aborted");
  }
  const pkg = getLocalVoicePackage(KOKORO_PACKAGE_ID);

  if (typeof caches === "undefined") {
    throw new LocalVoiceClientError("cache_miss");
  }

  // Stream only from the verified store — never network-fetch voice bytes here.
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of streamVerifiedFile(KOKORO_PACKAGE_ID, "voices/af_heart.bin")) {
      if (options.signal?.aborted) {
        throw new LocalVoiceClientError("aborted");
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof LocalVoiceClientError) throw error;
    throw new LocalVoiceClientError("cache_miss");
  }
  if (total === 0) {
    throw new LocalVoiceClientError("cache_miss");
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const cache = await caches.open("kokoro-voices");
  const patchedVoiceUrl = `https://huggingface.co/${pkg.repo}/resolve/junban-blocked/voices/af_heart.bin`;
  await cache.put(
    new Request(patchedVoiceUrl, { credentials: "omit" }),
    new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.byteLength),
      },
    }),
  );

  // Confirm the seed is readable — never allow a later network fallback path.
  const hit = await cache.match(new Request(patchedVoiceUrl, { credentials: "omit" }));
  if (!hit) {
    throw new LocalVoiceClientError("cache_miss");
  }
}

/**
 * Verify/cache Kokoro weights, seed af_heart, and instantiate the q8/wasm model.
 * Does not synthesize until generate is called on the handle.
 */
export async function loadKokoroEngine(
  options: KokoroLoadOptions = {},
): Promise<KokoroEngineHandle> {
  if (options.signal?.aborted) {
    throw new LocalVoiceClientError("aborted");
  }

  const pkg = getLocalVoicePackage(KOKORO_PACKAGE_ID);
  const assets = await loadKokoroRuntimeAssets();

  const verified = await reverifyCachedPackage(KOKORO_PACKAGE_ID);
  if (!verified) {
    throw new LocalVoiceClientError("cache_miss");
  }
  if (options.signal?.aborted) {
    throw new LocalVoiceClientError("aborted");
  }

  await seedKokoroVoiceCache(options);

  const transformers = await import("@huggingface/transformers");
  configureVerifiedTransformers(transformers.env, KOKORO_PACKAGE_ID, assets.ortWasmPaths);
  const { KokoroTTS } = await import("kokoro-js");

  if (options.signal?.aborted) {
    throw new LocalVoiceClientError("aborted");
  }

  let tts: KokoroModel;
  try {
    // kokoro-js does not forward revision; verified cache maps resolve/main → pin.
    tts = await KokoroTTS.from_pretrained(pkg.repo, {
      dtype: KOKORO_DTYPE,
      device: KOKORO_DEVICE,
    });
  } catch {
    throw new LocalVoiceClientError("load_failed");
  }

  let disposed = false;

  return {
    packageId: pkg.id,
    modelId: pkg.repo,
    revision: pkg.revision,
    voiceId: KOKORO_VOICE_ID,
    async synthesize(text: string): Promise<KokoroAudioResult> {
      if (disposed) {
        throw new LocalVoiceClientError("disposed");
      }
      const validated = validateSynthesisText(text);
      if (!validated.ok) {
        throw new LocalVoiceClientError(validated.code);
      }
      let raw: RawAudio;
      try {
        raw = await tts.generate(validated.text, { voice: KOKORO_VOICE_ID });
      } catch {
        throw new LocalVoiceClientError("infer_failed");
      }
      const sampleRate =
        typeof raw.sampling_rate === "number" && Number.isFinite(raw.sampling_rate)
          ? raw.sampling_rate
          : KOKORO_SAMPLE_RATE_HZ;
      const pcm = raw.audio;
      if (!(pcm instanceof Float32Array)) {
        throw new LocalVoiceClientError("infer_failed");
      }
      const out = validatePcmAudioOut(pcm, sampleRate, 1);
      if (!out.ok) {
        throw new LocalVoiceClientError(out.code);
      }
      return {
        pcm: new Float32Array(out.buffer),
        sampleRate,
        channels: 1,
        transferable: out.buffer,
      };
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        if (typeof tts.model?.dispose === "function") {
          await tts.model.dispose();
        }
      } catch {
        // Best-effort; worker termination is final.
      }
    },
  };
}

export async function importKokoroPackage(): Promise<typeof import("kokoro-js")> {
  return import("kokoro-js");
}
