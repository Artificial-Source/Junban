/**
 * Host-side local engine status, consent download, and selective remove.
 *
 * Does not create workers, import engine packages, open AudioContext, or run
 * inference. Cache admission still goes through exact size+SHA verification.
 */

import { getLocalVoicePackage, listLocalVoicePackages } from "./manifest.ts";
import { readVerifiedMarker } from "./opfs-store.ts";
import type { LocalVoiceEngine, LocalVoiceLicense, LocalVoicePackage } from "./types.ts";
import {
  clearVerifiedPackageCache,
  ensureVerifiedPackage,
  reverifyCachedPackage,
  type FetchVerifiedOptions,
} from "./verify-fetch.ts";

/** Exact Piper voice basename keys seeded into the patched package OPFS. */
const PIPER_VOICE_ID = "en_US-ljspeech-medium";

export type LocalEngineFileStatus = {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly license: LocalVoiceLicense;
  readonly present: boolean;
};

export type LocalEngineStatus = {
  readonly engine: LocalVoiceEngine;
  readonly packageId: string;
  readonly displayName: string;
  readonly repo: string;
  readonly revision: string;
  readonly engineVersion: string;
  readonly license: LocalVoiceLicense;
  readonly cacheKey: string;
  readonly totalBytes: number;
  readonly files: readonly LocalEngineFileStatus[];
  /** True when every manifest file has a matching verified marker. */
  readonly installed: boolean;
  /** True when installed files re-verify (size+SHA) successfully. */
  readonly verified: boolean;
};

export function packageForEngine(engine: LocalVoiceEngine): LocalVoicePackage {
  const pkg = listLocalVoicePackages().find((entry) => entry.engine === engine);
  if (!pkg) {
    throw new Error(`No local voice package for engine ${engine}`);
  }
  return pkg;
}

export function packageIdForEngine(engine: LocalVoiceEngine): string {
  return packageForEngine(engine).id;
}

export function engineForPackageId(packageId: string): LocalVoiceEngine | null {
  const pkg = listLocalVoicePackages().find((entry) => entry.id === packageId);
  return pkg?.engine ?? null;
}

function statusFromPackage(
  pkg: LocalVoicePackage,
  files: LocalEngineFileStatus[],
  verified: boolean,
): LocalEngineStatus {
  const installed = files.every((file) => file.present);
  return {
    engine: pkg.engine,
    packageId: pkg.id,
    displayName: pkg.displayName,
    repo: pkg.repo,
    revision: pkg.revision,
    engineVersion: pkg.engineVersion,
    license: pkg.license,
    cacheKey: pkg.cacheKey,
    totalBytes: pkg.files.reduce((sum, file) => sum + file.bytes, 0),
    files,
    installed,
    verified: installed && verified,
  };
}

async function fileStatuses(pkg: LocalVoicePackage): Promise<LocalEngineFileStatus[]> {
  const out: LocalEngineFileStatus[] = [];
  for (const file of pkg.files) {
    const marker = await readVerifiedMarker(pkg.id, file.path);
    const present = marker !== null && marker.bytes === file.bytes && marker.sha256 === file.sha256;
    out.push({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      license: file.license,
      present,
    });
  }
  return out;
}

/** Inspect verified-store presence for one engine without network or workers. */
export async function getLocalEngineStatus(engine: LocalVoiceEngine): Promise<LocalEngineStatus> {
  const pkg = packageForEngine(engine);
  const files = await fileStatuses(pkg);
  let verified = false;
  if (files.every((file) => file.present)) {
    try {
      verified = await reverifyCachedPackage(pkg.id);
    } catch {
      verified = false;
    }
  }
  return statusFromPackage(pkg, files, verified);
}

export async function getAllLocalEngineStatuses(): Promise<LocalEngineStatus[]> {
  const statuses: LocalEngineStatus[] = [];
  for (const pkg of listLocalVoicePackages()) {
    statuses.push(await getLocalEngineStatus(pkg.engine));
  }
  return statuses;
}

/**
 * Consent download path: admit every package file through size+SHA verification.
 * Does not construct workers or run inference.
 */
export async function downloadLocalEnginePackage(
  packageId: string,
  options: FetchVerifiedOptions = {},
): Promise<LocalEngineStatus> {
  const engine = engineForPackageId(packageId);
  if (!engine) {
    throw new Error(`Unknown local voice package ${packageId}`);
  }
  await ensureVerifiedPackage(packageId, options);
  return getLocalEngineStatus(engine);
}

/** Consent download by engine id. */
export async function downloadLocalEngine(
  engine: LocalVoiceEngine,
  options: FetchVerifiedOptions = {},
): Promise<LocalEngineStatus> {
  return downloadLocalEnginePackage(packageIdForEngine(engine), options);
}

async function clearKokoroVoiceSeed(pkg: LocalVoicePackage): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open("kokoro-voices");
    const patchedVoiceUrl = `https://huggingface.co/${pkg.repo}/resolve/junban-blocked/voices/af_heart.bin`;
    await cache.delete(new Request(patchedVoiceUrl, { credentials: "omit" }));
  } catch {
    // Best-effort; verified store clear is authoritative.
  }
}

async function clearPiperSeededVoice(): Promise<void> {
  if (!navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("piper", { create: false });
    // Only remove LJ Speech basenames — never flush unrelated OPFS entries.
    const basenames = [`${PIPER_VOICE_ID}.onnx`, `${PIPER_VOICE_ID}.onnx.json`, "MODEL_CARD"];
    for (const name of basenames) {
      try {
        await dir.removeEntry(name);
      } catch {
        // absent
      }
    }
  } catch {
    // piper dir absent
  }
}

/**
 * Remove one selected verified package and its derived seed only.
 * Never clears other engines.
 */
export async function removeLocalEnginePackage(packageId: string): Promise<LocalEngineStatus> {
  const engine = engineForPackageId(packageId);
  if (!engine) {
    throw new Error(`Unknown local voice package ${packageId}`);
  }
  const pkg = getLocalVoicePackage(packageId);
  await clearVerifiedPackageCache(packageId);
  if (engine === "kokoro") {
    await clearKokoroVoiceSeed(pkg);
  } else if (engine === "piper") {
    await clearPiperSeededVoice();
  }
  return getLocalEngineStatus(engine);
}

/** Convenience: remove by engine id. */
export async function removeLocalEngine(engine: LocalVoiceEngine): Promise<LocalEngineStatus> {
  return removeLocalEnginePackage(packageIdForEngine(engine));
}
