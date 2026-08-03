/**
 * Browser-local voice boundary.
 *
 * Ordinary import of this module does not static-import engine packages, create
 * workers, fetch/verify models, open OPFS/cache, instantiate ORT/WASM, or
 * allocate AudioContext. Callers use dynamic loaders, status/download helpers,
 * or worker clients after explicit consent.
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

export {
  LOCAL_VOICE_DISPOSE_TIMEOUT_MS,
  LOCAL_VOICE_ERROR_MESSAGES,
  LOCAL_VOICE_INFER_TIMEOUT_MS,
  LOCAL_VOICE_LOAD_TIMEOUT_MS,
  LOCAL_VOICE_MAX_AUDIO_OUT_BYTES,
  LOCAL_VOICE_MAX_PCM_BYTES,
  LOCAL_VOICE_MAX_SYNTHESIS_TEXT_BYTES,
  LOCAL_VOICE_MAX_TRANSCRIPT_BYTES,
  LOCAL_VOICE_WHISPER_SAMPLE_RATE_HZ,
  LocalVoiceClientError,
  boundTranscript,
  isLocalVoiceRequest,
  isLocalVoiceResponse,
  localVoiceError,
  validatePcmAudioOut,
  validateSynthesisText,
  validateWavAudioOut,
  validateWhisperPcm,
  type LocalVoiceAudioFormat,
  type LocalVoiceErrorCode,
  type LocalVoiceRequest,
  type LocalVoiceResponse,
} from "./protocol.ts";

export {
  LocalKokoroClient,
  LocalPiperClient,
  LocalVoiceWorkerClient,
  LocalWhisperClient,
  createLocalKokoroClient,
  createLocalPiperClient,
  createLocalWhisperClient,
  type LocalSynthesizeResult,
  type LocalTranscribeResult,
  type LocalVoiceClientOptions,
  type LocalVoiceLoadInfo,
} from "./worker-client.ts";

export {
  downloadLocalEngine,
  downloadLocalEnginePackage,
  engineForPackageId,
  getAllLocalEngineStatuses,
  getLocalEngineStatus,
  packageForEngine,
  packageIdForEngine,
  removeLocalEngine,
  removeLocalEnginePackage,
  type LocalEngineFileStatus,
  type LocalEngineStatus,
} from "./engine-status.ts";

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
