/**
 * Origin-private filesystem store for verified local voice model files.
 *
 * Writes always go to a temporary name. Admission (final name + marker) happens
 * only after size and SHA-256 match. Readers only open files that have a valid
 * marker. Bounded chunk I/O avoids holding whole model weights in RAM.
 */

export const OPFS_ROOT_DIR = "junban-local-voice";
export const OPFS_CHUNK_BYTES = 256 * 1024;

export type VerifiedFileMeta = {
  packageId: string;
  filePath: string;
  bytes: number;
  sha256: string;
};

export type PartialWriteSession = {
  packageId: string;
  filePath: string;
  partialName: string;
  expectedBytes: number;
  expectedSha256: string;
  written: number;
  /** Single writable held open from begin through commit/abort. */
  writable: FileSystemWritableFileStream;
  writableOpen: boolean;
};

type DirHandle = FileSystemDirectoryHandle;

function encodePath(filePath: string): string {
  return filePath.replaceAll("/", "__");
}

function partialName(filePath: string, nonce: string): string {
  return `${encodePath(filePath)}.${nonce}.partial`;
}

function finalName(filePath: string): string {
  return encodePath(filePath);
}

function markerName(filePath: string): string {
  return `${encodePath(filePath)}.verified.json`;
}

async function rootDir(): Promise<DirHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error("OPFS is unavailable in this environment");
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });
}

async function packageDir(packageId: string, create: boolean): Promise<DirHandle> {
  const root = await rootDir();
  return root.getDirectoryHandle(packageId, { create });
}

async function removeIfExists(dir: DirHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch {
    // absent is fine
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function closeSessionWritable(session: PartialWriteSession): Promise<void> {
  if (!session.writableOpen) return;
  session.writableOpen = false;
  try {
    await session.writable.close();
  } catch {
    try {
      await session.writable.abort();
    } catch {
      // ignore double-close races
    }
  }
}

export async function beginPartialWrite(
  packageId: string,
  filePath: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<PartialWriteSession> {
  const dir = await packageDir(packageId, true);
  const nonce = randomNonce();
  const name = partialName(filePath, nonce);
  // Ensure a clean empty partial, then keep one writable open for all chunks.
  await removeIfExists(dir, name);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  return {
    packageId,
    filePath,
    partialName: name,
    expectedBytes,
    expectedSha256,
    written: 0,
    writable,
    writableOpen: true,
  };
}

export async function appendPartialChunk(
  session: PartialWriteSession,
  chunk: Uint8Array,
): Promise<void> {
  if (chunk.byteLength === 0) return;
  if (!session.writableOpen) {
    throw new Error(`Partial writable already closed for ${session.filePath}`);
  }
  const next = session.written + chunk.byteLength;
  if (next > session.expectedBytes) {
    throw new Error(
      `Partial write exceeded expected size for ${session.filePath}: ${next} > ${session.expectedBytes}`,
    );
  }
  // Sequential writes on the single open stream — no per-chunk reopen/copy.
  await session.writable.write(Uint8Array.from(chunk));
  session.written = next;
}

export async function abortPartialWrite(session: PartialWriteSession): Promise<void> {
  await closeSessionWritable(session);
  try {
    const dir = await packageDir(session.packageId, false);
    await removeIfExists(dir, session.partialName);
  } catch {
    // package dir may already be gone
  }
}

/**
 * Finalize a partial write after the caller has verified running size/hash.
 * Streams partial → final in bounded chunks, writes the marker, deletes partial.
 */
export async function commitPartialWrite(session: PartialWriteSession): Promise<VerifiedFileMeta> {
  if (session.written !== session.expectedBytes) {
    await abortPartialWrite(session);
    throw new Error(
      `Partial size mismatch for ${session.filePath}: ${session.written} !== ${session.expectedBytes}`,
    );
  }
  // Close the single partial writable exactly once before reading it back.
  await closeSessionWritable(session);
  const dir = await packageDir(session.packageId, false);
  const partialHandle = await dir.getFileHandle(session.partialName, { create: false });
  const partialFile = await partialHandle.getFile();
  if (partialFile.size !== session.expectedBytes) {
    await abortPartialWrite(session);
    throw new Error(`OPFS partial size mismatch for ${session.filePath}`);
  }

  const final = finalName(session.filePath);
  const marker = markerName(session.filePath);
  await removeIfExists(dir, final);
  await removeIfExists(dir, marker);

  const finalHandle = await dir.getFileHandle(final, { create: true });
  const writable = await finalHandle.createWritable({ keepExistingData: false });
  try {
    let offset = 0;
    while (offset < partialFile.size) {
      const slice = partialFile.slice(offset, offset + OPFS_CHUNK_BYTES);
      const buf = new Uint8Array(await slice.arrayBuffer());
      await writable.write(Uint8Array.from(buf));
      offset += buf.byteLength;
    }
  } catch (error) {
    await writable.close().catch(() => undefined);
    await removeIfExists(dir, final);
    await abortPartialWrite(session);
    throw error;
  }
  await writable.close();

  const meta: VerifiedFileMeta = {
    packageId: session.packageId,
    filePath: session.filePath,
    bytes: session.expectedBytes,
    sha256: session.expectedSha256,
  };
  const markerHandle = await dir.getFileHandle(marker, { create: true });
  const markerWritable = await markerHandle.createWritable({ keepExistingData: false });
  try {
    await markerWritable.write(JSON.stringify(meta));
  } catch (error) {
    await markerWritable.close().catch(() => undefined);
    await removeIfExists(dir, final);
    await removeIfExists(dir, marker);
    await abortPartialWrite(session);
    throw error;
  }
  await markerWritable.close();
  await removeIfExists(dir, session.partialName);
  return meta;
}

export async function readVerifiedMarker(
  packageId: string,
  filePath: string,
): Promise<VerifiedFileMeta | null> {
  try {
    const dir = await packageDir(packageId, false);
    const handle = await dir.getFileHandle(markerName(filePath), { create: false });
    const file = await handle.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text) as VerifiedFileMeta;
    if (
      parsed.packageId !== packageId ||
      parsed.filePath !== filePath ||
      typeof parsed.bytes !== "number" ||
      typeof parsed.sha256 !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function openVerifiedFile(packageId: string, filePath: string): Promise<File | null> {
  const marker = await readVerifiedMarker(packageId, filePath);
  if (!marker) return null;
  try {
    const dir = await packageDir(packageId, false);
    const handle = await dir.getFileHandle(finalName(filePath), { create: false });
    const file = await handle.getFile();
    if (file.size !== marker.bytes) return null;
    return file;
  } catch {
    return null;
  }
}

/** Stream a verified file in bounded chunks (no full-buffer read). */
export async function* streamVerifiedFile(
  packageId: string,
  filePath: string,
  chunkBytes: number = OPFS_CHUNK_BYTES,
): AsyncGenerator<Uint8Array, void, unknown> {
  const file = await openVerifiedFile(packageId, filePath);
  if (!file) {
    throw new Error(`Verified OPFS file missing: ${packageId} ${filePath}`);
  }
  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, offset + chunkBytes);
    const buf = new Uint8Array(await slice.arrayBuffer());
    offset += buf.byteLength;
    yield buf;
  }
}

export async function deleteVerifiedFile(packageId: string, filePath: string): Promise<void> {
  try {
    const dir = await packageDir(packageId, false);
    await removeIfExists(dir, finalName(filePath));
    await removeIfExists(dir, markerName(filePath));
    // Best-effort cleanup of any leftover partials for this path.
    // Directory iteration is optional; ignore if unsupported in tests.
    const iterable = dir as DirHandle & {
      values?: () => AsyncIterableIterator<FileSystemHandle>;
    };
    if (typeof iterable.values === "function") {
      const prefix = `${encodePath(filePath)}.`;
      for await (const entry of iterable.values()) {
        if (
          entry.kind === "file" &&
          entry.name.startsWith(prefix) &&
          entry.name.endsWith(".partial")
        ) {
          await removeIfExists(dir, entry.name);
        }
      }
    }
  } catch {
    // absent package dir
  }
}

export async function clearPackageStore(packageId: string): Promise<void> {
  try {
    const root = await rootDir();
    await root.removeEntry(packageId, { recursive: true });
  } catch {
    // absent
  }
}

/** Test helper: expose path encoding. */
export function opfsFinalNameForTests(filePath: string): string {
  return finalName(filePath);
}
