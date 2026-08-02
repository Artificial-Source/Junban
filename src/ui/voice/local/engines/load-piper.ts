/**
 * Dynamic-only Piper loader/cache boundary.
 *
 * Never calls the package download() path. Verified bytes are streamed from
 * Junban's verified OPFS store into the path keys the patched package reads.
 * All wasm/ORT assets are same-origin. No synthesis is performed here.
 */

import { getLocalVoicePackage } from "../manifest.ts";
import { loadPiperRuntimeAssets } from "../same-origin-assets.ts";
import { ensureVerifiedPackage, openVerifiedFile } from "../verify-fetch.ts";

export const PIPER_PACKAGE_ID = "piper-en_US-ljspeech-medium";
export const PIPER_VOICE_ID = "en_US-ljspeech-medium";

/** Must match the patched package HF_BASE + PATH_MAP filename keys. */
const PIPER_OPFS_URL_ROOT =
  "https://huggingface.co/rhasspy/piper-voices/resolve/junban-blocked/en/en_US/ljspeech/medium";

export type PiperLoadOptions = {
  signal?: AbortSignal;
};

export type PiperEngineHandle = {
  readonly packageId: string;
  readonly voiceId: string;
  readonly revision: string;
  readonly wasmPaths: {
    onnxWasm: string;
    piperData: string;
    piperWasm: string;
  };
  dispose: () => void;
};

async function writePiperPackageOpfs(fileName: string, file: File): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle("piper", { create: true });
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    // Stream File → package OPFS without an intermediate full ArrayBuffer copy
    // when the implementation supports writing a Blob/File directly.
    await writable.write(file);
  } finally {
    await writable.close();
  }
}

/**
 * Seed the patched package's OPFS keys from Junban-verified files.
 * The package refuses network fallback when these entries are missing.
 */
export async function seedPiperVerifiedOpfs(options: PiperLoadOptions = {}): Promise<void> {
  await ensureVerifiedPackage(PIPER_PACKAGE_ID, { signal: options.signal });
  const pkg = getLocalVoicePackage(PIPER_PACKAGE_ID);
  for (const entry of pkg.files) {
    const baseName = entry.path.split("/").at(-1);
    if (!baseName || baseName === "MODEL_CARD") continue;
    const file = await openVerifiedFile(PIPER_PACKAGE_ID, entry.path);
    if (!file) {
      throw new Error(`Missing verified Piper file ${entry.path}`);
    }
    await writePiperPackageOpfs(baseName, file);
  }
}

export async function loadPiperEngine(options: PiperLoadOptions = {}): Promise<PiperEngineHandle> {
  const pkg = getLocalVoicePackage(PIPER_PACKAGE_ID);
  const assets = await loadPiperRuntimeAssets();
  await seedPiperVerifiedOpfs(options);

  // Import only after package OPFS is seeded and wasm paths are known.
  await import("@mintplex-labs/piper-tts-web");

  return {
    packageId: pkg.id,
    voiceId: PIPER_VOICE_ID,
    revision: pkg.revision,
    wasmPaths: {
      onnxWasm: assets.onnxWasmBaseUrl,
      piperData: assets.piperDataUrl,
      piperWasm: assets.piperWasmUrl,
    },
    dispose: () => {
      // Session lifetime is owned by later waves.
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
