import type { env as transformersEnv } from "@huggingface/transformers";
import { LocalVoiceClientError } from "../protocol.ts";
import type { OrtWasmPaths } from "../same-origin-assets.ts";
import { createVerifiedTransformersCache } from "../verified-model-cache.ts";

export function configureVerifiedTransformers(
  env: typeof transformersEnv,
  packageId: string,
  wasmPaths: OrtWasmPaths,
): void {
  const wasm = env.backends.onnx?.wasm;
  if (!wasm) throw new LocalVoiceClientError("load_failed");

  // Transformers requires a local or remote source to be enabled. Leave local
  // lookup enabled for cache keys, but reject every library model fetch after
  // a miss so even same-origin files cannot bypass the verified OPFS cache.
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.useFS = false;
  env.useFSCache = false;
  env.useCustomCache = true;
  env.customCache = createVerifiedTransformersCache(packageId);
  env.fetch = async () => {
    throw new LocalVoiceClientError("cache_miss");
  };

  // V4 otherwise turns the cached glue into a blob URL; use only the shipped
  // asset URLs so the production CSP does not need a blob script source.
  env.useWasmCache = false;
  wasm.wasmPaths = wasmPaths;
  if (typeof SharedArrayBuffer === "undefined") wasm.numThreads = 1;
}
