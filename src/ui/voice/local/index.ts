/**
 * Browser-local voice boundary (loader/cache only — no inference).
 *
 * This module is intentionally free of engine package imports. Callers must
 * use the dynamic loader helpers (or worker host) so ordinary application
 * startup never fetches model code or support assets.
 */

export type {
  LocalVoiceEngine,
  LocalVoiceFileEntry,
  LocalVoiceLicense,
  LocalVoiceManifest,
  LocalVoicePackage,
  VerifiedBytes,
  VerifyProgress,
} from "./types.ts";

export {
  LOCAL_VOICE_MANIFEST,
  getLocalVoicePackage,
  getValidatedLocalVoiceManifest,
  listLocalVoicePackages,
  parseLocalVoiceManifest,
} from "./manifest.ts";

export {
  LocalVoiceVerifyError,
  clearVerifiedPackageCache,
  ensureVerifiedFile,
  ensureVerifiedPackage,
  fetchVerifiedFile,
  fetchVerifiedPackage,
  openVerifiedFile,
  reverifyCachedPackage,
  reverifyStoredFile,
  sha256Hex,
  streamVerifiedFile,
} from "./verify-fetch.ts";

export { createVerifiedTransformersCache } from "./verified-model-cache.ts";

export { createKokoroWorker, createPiperWorker, createWhisperWorker } from "./worker-host.ts";

/** Dynamic loader entry points — never statically import engine packages here. */
export async function loadWhisperEngine(
  ...args: Parameters<typeof import("./engines/load-whisper.ts").loadWhisperEngine>
): ReturnType<typeof import("./engines/load-whisper.ts").loadWhisperEngine> {
  const mod = await import("./engines/load-whisper.ts");
  return mod.loadWhisperEngine(...args);
}

export async function loadKokoroEngine(
  ...args: Parameters<typeof import("./engines/load-kokoro.ts").loadKokoroEngine>
): ReturnType<typeof import("./engines/load-kokoro.ts").loadKokoroEngine> {
  const mod = await import("./engines/load-kokoro.ts");
  return mod.loadKokoroEngine(...args);
}

export async function loadPiperEngine(
  ...args: Parameters<typeof import("./engines/load-piper.ts").loadPiperEngine>
): ReturnType<typeof import("./engines/load-piper.ts").loadPiperEngine> {
  const mod = await import("./engines/load-piper.ts");
  return mod.loadPiperEngine(...args);
}

export async function loadVadEngine(
  ...args: Parameters<typeof import("./engines/load-vad.ts").loadVadEngine>
): ReturnType<typeof import("./engines/load-vad.ts").loadVadEngine> {
  const mod = await import("./engines/load-vad.ts");
  return mod.loadVadEngine(...args);
}
