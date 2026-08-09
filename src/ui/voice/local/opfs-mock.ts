/**
 * Minimal in-memory OPFS mock for deterministic unit tests.
 * Supports getDirectoryHandle, getFileHandle, createWritable, removeEntry.
 */

type FileRecord = { data: Uint8Array };

/** Test counters for asserting single-stream partial writes. */
export const opfsMockStats = {
  createWritableCalls: 0,
  closeCalls: 0,
  abortCalls: 0,
  reset() {
    this.createWritableCalls = 0;
    this.closeCalls = 0;
    this.abortCalls = 0;
  },
};

class MemoryWritable {
  private chunks: Uint8Array[] = [];
  private position = 0;
  private closed = false;
  private readonly onClose: (data: Uint8Array) => void;

  constructor(onClose: (data: Uint8Array) => void, existing: Uint8Array) {
    this.onClose = onClose;
    this.chunks = [existing];
    // Append-only sessions start at end of existing data.
    this.position = existing.byteLength;
  }

  async seek(position: number): Promise<void> {
    this.position = position;
  }

  async write(data: FileSystemWriteChunkType): Promise<void> {
    if (this.closed) throw new Error("writable closed");
    let bytes: Uint8Array;
    if (typeof data === "string") {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data && typeof data === "object" && "type" in data) {
      throw new Error("unsupported write options");
    } else {
      throw new Error("unsupported write payload");
    }
    const merged = this.flatten();
    const end = this.position + bytes.byteLength;
    const next = new Uint8Array(Math.max(merged.byteLength, end));
    next.set(merged, 0);
    next.set(bytes, this.position);
    this.chunks = [next];
    this.position = end;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    opfsMockStats.closeCalls += 1;
    this.onClose(this.flatten());
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    opfsMockStats.abortCalls += 1;
  }

  private flatten(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0]!;
    let total = 0;
    for (const c of this.chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }
}

class MemoryFileHandle {
  readonly kind = "file" as const;
  readonly name: string;
  private readonly store: Map<string, FileRecord>;

  constructor(name: string, store: Map<string, FileRecord>) {
    this.name = name;
    this.store = store;
  }

  async getFile(): Promise<File> {
    const rec = this.store.get(this.name) ?? { data: new Uint8Array() };
    const copy = Uint8Array.from(rec.data);
    return new File([copy], this.name);
  }

  async createWritable(
    options?: FileSystemCreateWritableOptions,
  ): Promise<FileSystemWritableFileStream> {
    opfsMockStats.createWritableCalls += 1;
    const existing =
      options?.keepExistingData && this.store.has(this.name)
        ? this.store.get(this.name)!.data.slice()
        : new Uint8Array();
    const writable = new MemoryWritable((data) => {
      this.store.set(this.name, { data: data.slice() });
    }, existing);
    return writable as unknown as FileSystemWritableFileStream;
  }
}

class MemoryDirHandle {
  readonly kind = "directory" as const;
  private readonly files = new Map<string, FileRecord>();
  private readonly dirs = new Map<string, MemoryDirHandle>();
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async getDirectoryHandle(
    name: string,
    options?: FileSystemGetDirectoryOptions,
  ): Promise<FileSystemDirectoryHandle> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw new DOMException("NotFoundError");
      dir = new MemoryDirHandle(name);
      this.dirs.set(name, dir);
    }
    return dir as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(
    name: string,
    options?: FileSystemGetFileOptions,
  ): Promise<FileSystemFileHandle> {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException("NotFoundError");
      this.files.set(name, { data: new Uint8Array() });
    }
    return new MemoryFileHandle(name, this.files) as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    if (this.files.has(name)) {
      this.files.delete(name);
      return;
    }
    if (this.dirs.has(name)) {
      if (!options?.recursive && this.dirs.get(name)!.files.size > 0) {
        throw new DOMException("InvalidModificationError");
      }
      this.dirs.delete(name);
      return;
    }
    throw new DOMException("NotFoundError");
  }

  async *values(): AsyncGenerator<FileSystemHandle> {
    for (const name of this.files.keys()) {
      yield new MemoryFileHandle(name, this.files) as unknown as FileSystemHandle;
    }
    for (const dir of this.dirs.values()) {
      yield dir as unknown as FileSystemHandle;
    }
  }
}

/** Install navigator.storage.getDirectory mock. Returns the root handle. */
export function installMemoryOpfs(): MemoryDirHandle {
  opfsMockStats.reset();
  const root = new MemoryDirHandle("");
  const storage = {
    getDirectory: async () => root as unknown as FileSystemDirectoryHandle,
  };
  Object.defineProperty(globalThis.navigator, "storage", {
    configurable: true,
    value: storage,
  });
  return root;
}
