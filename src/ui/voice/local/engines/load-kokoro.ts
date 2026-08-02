/**
 * Dynamic-only Kokoro loader/cache boundary.
 * kokoro-js is imported only inside functions. No inference is performed here.
 */

import { getLocalVoicePackage } from "../manifest.ts";
import { loadKokoroRuntimeAssets } from "../same-origin-assets.ts";
import { createVerifiedTransformersCache } from "../verified-model-cache.ts";
import { ensureVerifiedFile, ensureVerifiedPackage, streamVerifiedFile } from "../verify-fetch.ts";

export const KOKORO_PACKAGE_ID = "kokoro-82m-v1-q8";

export type KokoroLoadOptions = {
  signal?: AbortSignal;
};

export type KokoroEngineHandle = {
  readonly packageId: string;
  readonly modelId: string;
  readonly revision: string;
  dispose: () => void;
};

/**
 * Verify/cache Kokoro weights and prepare the engine module with same-origin ORT.
 * Voice style bytes are seeded into the Cache API key the patched package reads.
 * Does not synthesize audio.
 */
export async function loadKokoroEngine(
  options: KokoroLoadOptions = {},
): Promise<KokoroEngineHandle> {
  const pkg = getLocalVoicePackage(KOKORO_PACKAGE_ID);
  const assets = await loadKokoroRuntimeAssets();
  await ensureVerifiedPackage(KOKORO_PACKAGE_ID, { signal: options.signal });
  await ensureVerifiedFile(KOKORO_PACKAGE_ID, "voices/af_heart.bin", {
    signal: options.signal,
  });

  // Seed the voice style cache entry expected by kokoro-js after the Junban patch.
  // Stream from the verified store so we never keep a second full copy longer than needed.
  if (typeof caches !== "undefined") {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of streamVerifiedFile(KOKORO_PACKAGE_ID, "voices/af_heart.bin")) {
      chunks.push(chunk);
      total += chunk.byteLength;
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
  }

  const kokoro = await import("kokoro-js");
  // Kokoro routes model loads through transformers; bind the verified cache on env if present.
  if (kokoro.env && typeof kokoro.env === "object") {
    const env = kokoro.env as { wasmPaths?: string };
    env.wasmPaths = assets.ortWasmBaseUrl;
  }

  // Also configure the transformers package instance Kokoro will share when possible.
  try {
    const transformers = await import("@huggingface/transformers");
    transformers.env.allowRemoteModels = false;
    transformers.env.useBrowserCache = false;
    transformers.env.useCustomCache = true;
    transformers.env.customCache = createVerifiedTransformersCache(KOKORO_PACKAGE_ID);
    const backends = transformers.env.backends as {
      onnx?: { wasm?: { wasmPaths?: string | Record<string, string> } };
    };
    if (!backends.onnx) {
      backends.onnx = { wasm: { wasmPaths: assets.ortWasmBaseUrl } };
    } else {
      backends.onnx.wasm = backends.onnx.wasm ?? {};
      backends.onnx.wasm.wasmPaths = assets.ortWasmBaseUrl;
    }
  } catch {
    // If transformers is only reachable inside kokoro's bundle, the verified
    // voice seed + wasmPaths above still apply; model loads must use the
    // verified store mediation when the host package exposes env.
  }

  return {
    packageId: pkg.id,
    modelId: pkg.repo,
    revision: pkg.revision,
    dispose: () => {
      // Model instances are owned by later waves.
    },
  };
}

export async function importKokoroPackage(): Promise<typeof import("kokoro-js")> {
  return import("kokoro-js");
}
