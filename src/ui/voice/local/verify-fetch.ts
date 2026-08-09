/**
 * Bounded-memory verified download of local voice model files.
 *
 * Bytes stream to a temporary OPFS object while an incremental SHA-256 runs.
 * Only after size and digest match is the object admitted as verified. The
 * Cache API is not used for model weights. Hash is the trust anchor; host
 * policy only constrains transport.
 *
 * This module is a loader/cache boundary only — it does not run inference.
 */

import { withModelDownloadLock } from "./download-gate.ts";
import { getLocalVoicePackage } from "./manifest.ts";
import { LOCAL_VOICE_MANIFEST } from "./manifest.ts";
import {
  abortPartialWrite,
  appendPartialChunk,
  beginPartialWrite,
  clearPackageStore,
  commitPartialWrite,
  deleteVerifiedFile,
  openVerifiedFile,
  readVerifiedMarker,
  streamVerifiedFile,
  type PartialWriteSession,
} from "./opfs-store.ts";
import { validateFinalDeliveryUrl, validateManifestUrl } from "./redirect-policy.ts";
import { Sha256 } from "./sha256.ts";
import type {
  LocalVoiceFileEntry,
  LocalVoiceManifest,
  LocalVoicePackage,
  VerifyProgress,
  VerifiedBytes,
} from "./types.ts";

export class LocalVoiceVerifyError extends Error {
  readonly code:
    | "url"
    | "http"
    | "size"
    | "hash"
    | "scheme"
    | "host"
    | "path"
    | "aborted"
    | "store"
    | "redirect";

  constructor(code: LocalVoiceVerifyError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalVoiceVerifyError";
    this.code = code;
  }
}

function assertEntryUrl(entry: LocalVoiceFileEntry, pkg: LocalVoicePackage): URL {
  const manifestCheck = validateManifestUrl(entry.url);
  if (!manifestCheck.ok) {
    throw new LocalVoiceVerifyError(
      manifestCheck.reason.includes("host")
        ? "host"
        : manifestCheck.reason.includes("scheme")
          ? "scheme"
          : "url",
      `Refusing model URL for ${entry.path}: ${manifestCheck.reason}`,
    );
  }
  const expectedPath = `/${pkg.repo}/resolve/${pkg.revision}/${entry.path}`;
  if (manifestCheck.url.pathname !== expectedPath) {
    throw new LocalVoiceVerifyError(
      "path",
      `Refusing model path ${manifestCheck.url.pathname}; expected ${expectedPath}`,
    );
  }
  if (pkg.revision === "main") {
    throw new LocalVoiceVerifyError("path", "Refusing mutable revision main");
  }
  return manifestCheck.url;
}

async function cleanupSession(session: PartialWriteSession | null): Promise<void> {
  if (!session) return;
  await abortPartialWrite(session);
}

export type FetchVerifiedOptions = {
  manifest?: LocalVoiceManifest;
  signal?: AbortSignal;
  onProgress?: (progress: VerifyProgress) => void;
  /** Optional fetch implementation for tests. */
  fetchImpl?: typeof fetch;
  /** Prefer an already-verified OPFS object when present. Default true. */
  preferStore?: boolean;
  /**
   * When true (default false), also return an in-memory copy of the bytes.
   * Prefer openVerifiedFile/stream APIs for large weights.
   */
  includeBytes?: boolean;
};

export type VerifiedFileRef = {
  packageId: string;
  filePath: string;
  url: string;
  sha256: string;
  bytes: number;
  /** Present only when includeBytes was requested. */
  buffer?: ArrayBuffer;
};

/**
 * Ensure one manifest file is present as a verified OPFS object.
 * Streams from the network with bounded memory when missing or stale.
 */
export async function ensureVerifiedFile(
  packageId: string,
  filePath: string,
  options: FetchVerifiedOptions = {},
): Promise<VerifiedFileRef> {
  return withModelDownloadLock(() => ensureVerifiedFileUnlocked(packageId, filePath, options));
}

async function ensureVerifiedFileUnlocked(
  packageId: string,
  filePath: string,
  options: FetchVerifiedOptions,
): Promise<VerifiedFileRef> {
  const manifest = options.manifest ?? LOCAL_VOICE_MANIFEST;
  const pkg = getLocalVoicePackage(packageId, manifest);
  const entry = pkg.files.find((file) => file.path === filePath);
  if (!entry) {
    throw new LocalVoiceVerifyError("path", `Unknown file ${filePath} in package ${packageId}`);
  }
  assertEntryUrl(entry, pkg);

  const preferStore = options.preferStore !== false;
  if (preferStore) {
    try {
      const ok = await reverifyStoredFile(packageId, entry);
      if (ok) {
        return finalizeRef(packageId, entry, options.includeBytes === true);
      }
    } catch (error) {
      await deleteVerifiedFile(packageId, entry.path);
      if (error instanceof LocalVoiceVerifyError && error.code === "aborted") {
        throw error;
      }
      // fall through to network
    }
  }

  if (options.signal?.aborted) {
    throw new LocalVoiceVerifyError("aborted", `Download aborted for ${entry.path}`);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    // Follow redirects so immutable resolve/<rev> URLs can reach HF content hosts.
    // Final URL is checked against the HF-owned host allowlist below.
    response = await fetchImpl(entry.url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      signal: options.signal,
      headers: {
        Accept: "application/octet-stream, application/json, text/plain, */*",
      },
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new LocalVoiceVerifyError("aborted", `Download aborted for ${entry.path}`, {
        cause: error,
      });
    }
    throw error;
  }

  if (!response.ok) {
    throw new LocalVoiceVerifyError("http", `HTTP ${response.status} fetching ${entry.path}`);
  }

  const finalCheck = validateFinalDeliveryUrl(response.url || entry.url);
  if (!finalCheck.ok) {
    throw new LocalVoiceVerifyError(
      "redirect",
      `Refusing final delivery URL for ${entry.path}: ${finalCheck.reason}`,
    );
  }

  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isInteger(declared) || declared !== entry.bytes) {
      throw new LocalVoiceVerifyError(
        "size",
        `Content-Length mismatch for ${entry.path}: ${contentLength} !== ${entry.bytes}`,
      );
    }
  }

  if (!response.body) {
    throw new LocalVoiceVerifyError("http", `Empty body for ${entry.path}`);
  }

  let session: PartialWriteSession | null = null;
  const hasher = new Sha256();
  const reader = response.body.getReader();

  try {
    session = await beginPartialWrite(packageId, entry.path, entry.bytes, entry.sha256);
    while (true) {
      if (options.signal?.aborted) {
        throw new LocalVoiceVerifyError("aborted", `Download aborted for ${entry.path}`);
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      hasher.update(chunk);
      await appendPartialChunk(session, chunk);
      options.onProgress?.({
        packageId,
        filePath: entry.path,
        loaded: session.written,
        total: entry.bytes,
      });
    }

    if (session.written !== entry.bytes) {
      throw new LocalVoiceVerifyError(
        "size",
        `Response size mismatch for ${entry.path}: ${session.written} !== ${entry.bytes}`,
      );
    }
    const digest = hasher.digest();
    if (digest !== entry.sha256) {
      throw new LocalVoiceVerifyError(
        "hash",
        `SHA-256 mismatch for ${entry.path}: got ${digest}, expected ${entry.sha256}`,
      );
    }
    await commitPartialWrite(session);
    session = null;
  } catch (error) {
    await cleanupSession(session);
    session = null;
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
    if (error instanceof LocalVoiceVerifyError) throw error;
    if (options.signal?.aborted) {
      throw new LocalVoiceVerifyError("aborted", `Download aborted for ${entry.path}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  // Post-commit re-verify streams from OPFS with bounded memory.
  const ok = await reverifyStoredFile(packageId, entry);
  if (!ok) {
    await deleteVerifiedFile(packageId, entry.path);
    throw new LocalVoiceVerifyError("store", `Post-commit re-verify failed for ${entry.path}`);
  }

  return finalizeRef(packageId, entry, options.includeBytes === true);
}

async function finalizeRef(
  packageId: string,
  entry: LocalVoiceFileEntry,
  includeBytes: boolean,
): Promise<VerifiedFileRef> {
  const ref: VerifiedFileRef = {
    packageId,
    filePath: entry.path,
    url: entry.url,
    sha256: entry.sha256,
    bytes: entry.bytes,
  };
  if (includeBytes) {
    // Only for small fixtures/tests — production loaders should stream.
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of streamVerifiedFile(packageId, entry.path)) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    ref.buffer = out.buffer;
  }
  return ref;
}

/**
 * Re-verify one stored file by streaming OPFS bytes through SHA-256.
 * Returns false when absent; throws and deletes on tamper/mismatch.
 */
export async function reverifyStoredFile(
  packageId: string,
  entry: LocalVoiceFileEntry,
): Promise<boolean> {
  const marker = await readVerifiedMarker(packageId, entry.path);
  if (!marker) return false;
  if (marker.bytes !== entry.bytes || marker.sha256 !== entry.sha256) {
    await deleteVerifiedFile(packageId, entry.path);
    throw new LocalVoiceVerifyError("hash", `Stored marker mismatch for ${entry.path}`);
  }
  const file = await openVerifiedFile(packageId, entry.path);
  if (!file) {
    await deleteVerifiedFile(packageId, entry.path);
    return false;
  }
  if (file.size !== entry.bytes) {
    await deleteVerifiedFile(packageId, entry.path);
    throw new LocalVoiceVerifyError("size", `Stored size mismatch for ${entry.path}`);
  }
  const hasher = new Sha256();
  let loaded = 0;
  for await (const chunk of streamVerifiedFile(packageId, entry.path)) {
    hasher.update(chunk);
    loaded += chunk.byteLength;
  }
  if (loaded !== entry.bytes) {
    await deleteVerifiedFile(packageId, entry.path);
    throw new LocalVoiceVerifyError("size", `Stored stream size mismatch for ${entry.path}`);
  }
  const digest = hasher.digest();
  if (digest !== entry.sha256) {
    await deleteVerifiedFile(packageId, entry.path);
    throw new LocalVoiceVerifyError(
      "hash",
      `Stored SHA-256 mismatch for ${entry.path}: got ${digest}, expected ${entry.sha256}`,
    );
  }
  return true;
}

/** Download/verify every file in a package (serialized by the global lock). */
export async function ensureVerifiedPackage(
  packageId: string,
  options: FetchVerifiedOptions = {},
): Promise<VerifiedFileRef[]> {
  const pkg = getLocalVoicePackage(packageId, options.manifest ?? LOCAL_VOICE_MANIFEST);
  const out: VerifiedFileRef[] = [];
  for (const file of pkg.files) {
    out.push(await ensureVerifiedFile(packageId, file.path, options));
  }
  return out;
}

/** @deprecated Use ensureVerifiedFile; kept as a thin alias for tests/callers. */
export async function fetchVerifiedFile(
  packageId: string,
  filePath: string,
  options: FetchVerifiedOptions = {},
): Promise<VerifiedBytes> {
  const ref = await ensureVerifiedFile(packageId, filePath, {
    ...options,
    includeBytes: true,
  });
  return {
    packageId: ref.packageId,
    filePath: ref.filePath,
    url: ref.url,
    bytes: ref.buffer ?? new ArrayBuffer(0),
    sha256: ref.sha256,
  };
}

/** @deprecated Use ensureVerifiedPackage. */
export async function fetchVerifiedPackage(
  packageId: string,
  options: FetchVerifiedOptions = {},
): Promise<VerifiedBytes[]> {
  const refs = await ensureVerifiedPackage(packageId, { ...options, includeBytes: true });
  return refs.map((ref) => ({
    packageId: ref.packageId,
    filePath: ref.filePath,
    url: ref.url,
    bytes: ref.buffer ?? new ArrayBuffer(0),
    sha256: ref.sha256,
  }));
}

export async function clearVerifiedPackageCache(
  packageId: string,
  _manifest: LocalVoiceManifest = LOCAL_VOICE_MANIFEST,
): Promise<void> {
  await clearPackageStore(packageId);
}

export async function reverifyCachedPackage(
  packageId: string,
  manifest: LocalVoiceManifest = LOCAL_VOICE_MANIFEST,
): Promise<boolean> {
  const pkg = getLocalVoicePackage(packageId, manifest);
  for (const entry of pkg.files) {
    const ok = await reverifyStoredFile(packageId, entry);
    if (!ok) return false;
  }
  return true;
}

export { openVerifiedFile, streamVerifiedFile } from "./opfs-store.ts";
export { sha256HexOfBuffer as sha256Hex } from "./sha256.ts";
