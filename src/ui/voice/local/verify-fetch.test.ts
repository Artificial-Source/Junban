import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModelDownloadLockForTests } from "./download-gate.ts";
import { LOCAL_VOICE_MANIFEST } from "./manifest.ts";
import { installMemoryOpfs, opfsMockStats } from "./opfs-mock.ts";
import { OPFS_ROOT_DIR, openVerifiedFile, readVerifiedMarker } from "./opfs-store.ts";
import { isDisallowedDeliveryHost } from "./redirect-policy.ts";
import type { LocalVoiceManifest } from "./types.ts";
import {
  LocalVoiceVerifyError,
  clearVerifiedPackageCache,
  ensureVerifiedFile,
  reverifyCachedPackage,
  reverifyStoredFile,
  sha256Hex,
} from "./verify-fetch.ts";

function mutableManifest(): LocalVoiceManifest {
  return JSON.parse(JSON.stringify(LOCAL_VOICE_MANIFEST)) as LocalVoiceManifest;
}

function bytesResponse(
  data: Uint8Array,
  init?: { url?: string; status?: number; headers?: Record<string, string> },
): Response {
  const body = Uint8Array.from(data);
  const response = new Response(body, {
    status: init?.status ?? 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(data.byteLength),
      ...(init?.headers ?? {}),
    },
  });
  if (init?.url) {
    Object.defineProperty(response, "url", { value: init.url });
  }
  return response;
}

/** Fragment a payload into many small stream chunks. */
function fragmentedResponse(data: Uint8Array, chunkSize: number, finalUrl: string): Response {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, data.byteLength);
      controller.enqueue(data.subarray(offset, end));
      offset = end;
    },
  });
  const response = new Response(stream, {
    status: 200,
    headers: { "Content-Length": String(data.byteLength) },
  });
  Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

describe("local voice verify-fetch (OPFS streaming)", () => {
  const baseFile = LOCAL_VOICE_MANIFEST.packages[0]!.files.find(
    (entry) => entry.path === "preprocessor_config.json",
  )!;

  beforeEach(() => {
    installMemoryOpfs();
    resetModelDownloadLockForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function fixtureEntry(payload: Uint8Array) {
    const sha = await sha256Hex(payload);
    const fixtureManifest = mutableManifest() as LocalVoiceManifest & {
      packages: Array<{ id: string; cacheKey: string; files: Array<Record<string, unknown>> }>;
    };
    const fixturePkg = fixtureManifest.packages[0]!;
    const fixtureFile = {
      ...baseFile,
      bytes: payload.byteLength,
      sha256: sha,
    };
    fixturePkg.files = [fixtureFile];
    return { fixtureManifest, fixturePkg, fixtureFile, sha };
  }

  it("streams fragmented responses into OPFS and re-verifies without full-buffer cache", async () => {
    const payload = Uint8Array.from({ length: 2000 }, (_, i) => i & 0xff);
    const { fixtureManifest, fixturePkg, fixtureFile, sha } = await fixtureEntry(payload);
    const finalUrl = `https://us.aws.cdn.hf.co/xet-bridge-us/example/${fixtureFile.path}`;

    const fetchImpl = vi.fn(async () => fragmentedResponse(payload, 17, finalUrl));
    opfsMockStats.reset();

    const first = await ensureVerifiedFile(fixturePkg.id, fixtureFile.path, {
      manifest: fixtureManifest,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      includeBytes: true,
    });
    expect(first.sha256).toBe(sha);
    expect(first.buffer?.byteLength).toBe(payload.byteLength);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls[0] as unknown as unknown[])[1] as RequestInit;
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("follow");

    // One partial writable + final copy + marker = 3 opens, despite ~118 fragments.
    // Reopening per chunk would be O(fragments).
    expect(opfsMockStats.createWritableCalls).toBe(3);
    expect(opfsMockStats.closeCalls).toBeGreaterThanOrEqual(3);

    // Second call is store hit.
    const second = await ensureVerifiedFile(fixturePkg.id, fixtureFile.path, {
      manifest: fixtureManifest,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(second.sha256).toBe(sha);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(reverifyCachedPackage(fixturePkg.id, fixtureManifest)).resolves.toBe(true);

    // Marker exists; partial should not remain.
    const marker = await readVerifiedMarker(fixturePkg.id, fixtureFile.path);
    expect(marker?.sha256).toBe(sha);
    const file = await openVerifiedFile(fixturePkg.id, fixtureFile.path);
    expect(file?.size).toBe(payload.byteLength);
  });

  it("rejects disallowed final hosts and wrong size/hash; cleans partials", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const { fixtureManifest, fixturePkg, fixtureFile } = await fixtureEntry(payload);

    await expect(
      ensureVerifiedFile(fixturePkg.id, fixtureFile.path, {
        manifest: fixtureManifest,
        preferStore: false,
        fetchImpl: (async () =>
          bytesResponse(payload, {
            url: "https://evil.example/model.bin",
          })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "redirect" });

    const wrongSize = await ensureVerifiedFile(fixturePkg.id, fixtureFile.path, {
      manifest: fixtureManifest,
      preferStore: false,
      fetchImpl: (async () =>
        bytesResponse(new Uint8Array([1, 2]), {
          url: fixtureFile.url,
        })) as typeof fetch,
    }).catch((e: unknown) => e);
    expect(wrongSize).toBeInstanceOf(LocalVoiceVerifyError);
    expect((wrongSize as LocalVoiceVerifyError).code).toBe("size");

    const wrongHash = await ensureVerifiedFile(fixturePkg.id, fixtureFile.path, {
      manifest: fixtureManifest,
      preferStore: false,
      fetchImpl: (async () =>
        bytesResponse(new Uint8Array([9, 9, 9, 9]), {
          url: `https://huggingface.co/api/resolve-cache/models/x`,
        })) as typeof fetch,
    }).catch((e: unknown) => e);
    expect(wrongHash).toBeInstanceOf(LocalVoiceVerifyError);
    expect((wrongHash as LocalVoiceVerifyError).code).toBe("hash");

    // No verified marker after failures.
    await expect(readVerifiedMarker(fixturePkg.id, fixtureFile.path)).resolves.toBeNull();
  });

  it("deletes tampered stored bytes on re-verify and refetches", async () => {
    const good = new Uint8Array([7, 7, 7, 7]);
    const { fixtureManifest, fixturePkg, fixtureFile, sha } = await fixtureEntry(good);
    const fetchImpl = vi.fn(async () =>
      bytesResponse(good, { url: `https://hf.co/cdn/${fixtureFile.path}` }),
    );
    await ensureVerifiedFile(fixturePkg.id, fixtureFile.path, {
      manifest: fixtureManifest,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Tamper: overwrite verified file bytes via OPFS mock internals.
    const root = await navigator.storage.getDirectory();
    const voiceRoot = await root.getDirectoryHandle(OPFS_ROOT_DIR);
    const pkgDir = await voiceRoot.getDirectoryHandle(fixturePkg.id);
    const name = fixtureFile.path.replaceAll("/", "__");
    const handle = await pkgDir.getFileHandle(name);
    const w = await handle.createWritable({ keepExistingData: false });
    await w.write(new Uint8Array([8, 8, 8, 8]));
    await w.close();

    await expect(reverifyStoredFile(fixturePkg.id, fixtureFile as never)).rejects.toMatchObject({
      code: "hash",
    });

    const recovered = await ensureVerifiedFile(fixturePkg.id, fixtureFile.path, {
      manifest: fixtureManifest,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(recovered.sha256).toBe(sha);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts mid-stream and removes the temporary artifact", async () => {
    const payload = Uint8Array.from({ length: 64 }, (_, i) => i);
    const { fixtureManifest, fixturePkg, fixtureFile } = await fixtureEntry(payload);
    const controller = new AbortController();
    opfsMockStats.reset();

    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      controller.abort();
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(payload.subarray(0, 8));
          init?.signal?.addEventListener("abort", () => {
            streamController.error(new DOMException("Aborted", "AbortError"));
          });
        },
      });
      const response = new Response(stream, {
        status: 200,
        headers: { "Content-Length": String(payload.byteLength) },
      });
      Object.defineProperty(response, "url", { value: fixtureFile.url });
      return response;
    });

    await expect(
      ensureVerifiedFile(fixturePkg.id, fixtureFile.path, {
        manifest: fixtureManifest,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        signal: controller.signal,
        preferStore: false,
      }),
    ).rejects.toMatchObject({ code: "aborted" });

    await expect(readVerifiedMarker(fixturePkg.id, fixtureFile.path)).resolves.toBeNull();
    // Only the partial stream was opened; it must be closed/aborted on cleanup.
    expect(opfsMockStats.createWritableCalls).toBe(1);
    expect(opfsMockStats.closeCalls + opfsMockStats.abortCalls).toBeGreaterThanOrEqual(1);
    await clearVerifiedPackageCache(fixturePkg.id, fixtureManifest);
  });

  it("serializes concurrent downloads through the global lock", async () => {
    const payloadA = new Uint8Array([1, 1, 1]);
    const payloadB = new Uint8Array([2, 2, 2, 2]);
    const a = await fixtureEntry(payloadA);
    const bManifest = mutableManifest() as LocalVoiceManifest & {
      packages: Array<{ id: string; files: Array<Record<string, unknown>> }>;
    };
    // Use second package with a tiny single file fixture for concurrency.
    const bPkg = bManifest.packages[1]!;
    const bFile = {
      ...bPkg.files[0]!,
      path: "config.json",
      bytes: payloadB.byteLength,
      sha256: await sha256Hex(payloadB),
      url: `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/config.json`,
    };
    bPkg.files = [bFile];

    let concurrent = 0;
    let maxConcurrent = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent -= 1;
      const url = String(input);
      if (url === a.fixtureFile.url) {
        return bytesResponse(payloadA, { url: a.fixtureFile.url });
      }
      return bytesResponse(payloadB, { url: bFile.url });
    });

    await Promise.all([
      ensureVerifiedFile(a.fixturePkg.id, a.fixtureFile.path, {
        manifest: a.fixtureManifest,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        preferStore: false,
      }),
      ensureVerifiedFile(bPkg.id, bFile.path, {
        manifest: bManifest,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        preferStore: false,
      }),
    ]);
    expect(maxConcurrent).toBe(1);
  });

  it("never attaches credentials or query secrets on model requests", async () => {
    const payload = new Uint8Array([1]);
    const { fixtureManifest, fixturePkg, fixtureFile } = await fixtureEntry(payload);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe(fixtureFile.url);
      expect(url.includes("?")).toBe(false);
      expect(init?.credentials).toBe("omit");
      expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization/i);
      return bytesResponse(payload, { url: fixtureFile.url });
    });
    await ensureVerifiedFile(fixturePkg.id, fixtureFile.path, {
      manifest: fixtureManifest,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      preferStore: false,
    });
  });

  it("classifies delivery hosts for the redirect policy", () => {
    expect(isDisallowedDeliveryHost("huggingface.co")).toBe(false);
    expect(isDisallowedDeliveryHost("us.aws.cdn.hf.co")).toBe(false);
    expect(isDisallowedDeliveryHost("hf.co")).toBe(false);
    expect(isDisallowedDeliveryHost("evil.example")).toBe(true);
    expect(isDisallowedDeliveryHost("cdn.jsdelivr.net")).toBe(true);
  });
});
