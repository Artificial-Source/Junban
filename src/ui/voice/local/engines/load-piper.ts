/**
 * Dynamic-only Piper engine owner.
 *
 * Never calls the package download() path. Verified LJ Speech bytes are seeded
 * into the path keys the patched package reads. All wasm/ORT assets are
 * same-origin. TtsSession is constructed with the exact en_US-ljspeech-medium
 * voice — never HFC or package defaults.
 */

import { getLocalVoicePackage } from "../manifest.ts";
import { LocalVoiceClientError, validateSynthesisText, validateWavAudioOut } from "../protocol.ts";
import { loadPiperRuntimeAssets } from "../same-origin-assets.ts";
import { openVerifiedFile, reverifyCachedPackage } from "../verify-fetch.ts";

export const PIPER_PACKAGE_ID = "piper-en_US-ljspeech-medium";
export const PIPER_VOICE_ID = "en_US-ljspeech-medium";

/** Must match the patched package HF_BASE + PATH_MAP filename keys. */
const PIPER_OPFS_URL_ROOT =
  "https://huggingface.co/rhasspy/piper-voices/resolve/junban-blocked/en/en_US/ljspeech/medium";

export type PiperLoadOptions = {
  signal?: AbortSignal;
};

export type PiperWasmPaths = {
  readonly onnxWasm: string;
  readonly piperData: string;
  readonly piperWasm: string;
};

export type PiperAudioResult = {
  readonly wav: ArrayBuffer;
  readonly sampleRate: number;
  readonly channels: number;
  readonly format: "wav";
};

export type PiperEngineHandle = {
  readonly packageId: string;
  readonly voiceId: string;
  readonly revision: string;
  readonly wasmPaths: PiperWasmPaths;
  synthesize: (text: string) => Promise<PiperAudioResult>;
  dispose: () => Promise<void>;
};

type TtsSessionInstance = {
  predict: (text: string) => Promise<Blob>;
  voiceId: string;
};

type PiperModule = {
  TtsSession: {
    create: (options: {
      voiceId: string;
      wasmPaths: {
        onnxWasm: string;
        piperData: string;
        piperWasm: string;
      };
    }) => Promise<TtsSessionInstance>;
    _instance?: TtsSessionInstance | null;
  };
  download: (voiceId: string) => Promise<void>;
};

async function writePiperPackageOpfs(fileName: string, file: File): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("piper", { create: true });
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(file);
  } finally {
    await writable.close();
  }
}

/**
 * Seed the patched package's OPFS keys from Junban-verified files.
 * The package refuses network fallback when these entries are missing.
 * Requires a fully re-verified package — fails closed on cache miss.
 */
export async function seedPiperVerifiedOpfs(options: PiperLoadOptions = {}): Promise<void> {
  if (options.signal?.aborted) {
    throw new LocalVoiceClientError("aborted");
  }
  const verified = await reverifyCachedPackage(PIPER_PACKAGE_ID);
  if (!verified) {
    throw new LocalVoiceClientError("cache_miss");
  }
  const pkg = getLocalVoicePackage(PIPER_PACKAGE_ID);
  for (const entry of pkg.files) {
    const baseName = entry.path.split("/").at(-1);
    if (!baseName || baseName === "MODEL_CARD") continue;
    const file = await openVerifiedFile(PIPER_PACKAGE_ID, entry.path);
    if (!file) {
      throw new LocalVoiceClientError("cache_miss");
    }
    await writePiperPackageOpfs(baseName, file);
  }
}

export async function loadPiperEngine(options: PiperLoadOptions = {}): Promise<PiperEngineHandle> {
  if (options.signal?.aborted) {
    throw new LocalVoiceClientError("aborted");
  }

  const pkg = getLocalVoicePackage(PIPER_PACKAGE_ID);
  const assets = await loadPiperRuntimeAssets();
  await seedPiperVerifiedOpfs(options);

  if (options.signal?.aborted) {
    throw new LocalVoiceClientError("aborted");
  }

  const piper = (await import("@mintplex-labs/piper-tts-web")) as unknown as PiperModule;

  const wasmPaths = {
    // Object form required under Vite content-hashing (directory prefixes 404).
    onnxWasm: assets.ortWasmPaths as unknown as string,
    piperData: assets.piperDataUrl,
    piperWasm: assets.piperWasmUrl,
  };

  // Guard: never construct with package HFC default.
  if (PIPER_VOICE_ID.includes("hfc")) {
    throw new LocalVoiceClientError("unsupported");
  }

  let session: TtsSessionInstance;
  try {
    session = await piper.TtsSession.create({
      voiceId: PIPER_VOICE_ID,
      wasmPaths,
    });
  } catch {
    throw new LocalVoiceClientError("load_failed");
  }

  if (session.voiceId !== PIPER_VOICE_ID) {
    throw new LocalVoiceClientError("load_failed");
  }

  let disposed = false;

  return {
    packageId: pkg.id,
    voiceId: PIPER_VOICE_ID,
    revision: pkg.revision,
    wasmPaths,
    async synthesize(text: string): Promise<PiperAudioResult> {
      if (disposed) {
        throw new LocalVoiceClientError("disposed");
      }
      const validated = validateSynthesisText(text);
      if (!validated.ok) {
        throw new LocalVoiceClientError(validated.code);
      }
      let blob: Blob;
      try {
        blob = await session.predict(validated.text);
      } catch {
        throw new LocalVoiceClientError("infer_failed");
      }
      if (!(blob instanceof Blob) || blob.size === 0) {
        throw new LocalVoiceClientError("infer_failed");
      }
      let bytes: ArrayBuffer;
      try {
        bytes = await blob.arrayBuffer();
      } catch {
        throw new LocalVoiceClientError("infer_failed");
      }
      const wav = validateWavAudioOut(bytes);
      if (!wav.ok) {
        throw new LocalVoiceClientError(wav.code);
      }
      return {
        wav: wav.buffer,
        sampleRate: 22_050,
        channels: 1,
        format: "wav",
      };
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Destroy session singleton so a later load cannot reuse a stale instance.
      try {
        piper.TtsSession._instance = null;
      } catch {
        // ignore
      }
    },
  };
}

export async function importPiperPackage(): Promise<typeof import("@mintplex-labs/piper-tts-web")> {
  return import("@mintplex-labs/piper-tts-web");
}

/** Expose the OPFS URL root for tests that assert the blocked revision path. */
export function piperOpfsUrlRootForTests(): string {
  return PIPER_OPFS_URL_ROOT;
}
