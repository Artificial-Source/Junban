import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadPersistence({
  isTauri = false,
  isRemoteDesktopRuntime = false,
}: {
  isTauri?: boolean;
  isRemoteDesktopRuntime?: boolean;
} = {}) {
  vi.resetModules();
  vi.doMock("../../../src/utils/tauri.js", () => ({
    isTauri: () => isTauri,
  }));
  vi.doMock("../../../src/utils/runtime.js", () => ({
    isRemoteDesktopRuntime: () => isRemoteDesktopRuntime,
  }));

  return import("../../../src/db/persistence.js");
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("db persistence remote-desktop safeguards", () => {
  it("rejects raw remote database reads", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { loadDbFile } = await loadPersistence({ isRemoteDesktopRuntime: true });

    await expect(loadDbFile()).rejects.toThrow(
      "Remote-desktop clients must use the backend API; direct database file access is disabled.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects raw remote database writes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { saveDbFile } = await loadPersistence({ isRemoteDesktopRuntime: true });

    await expect(saveDbFile(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "Remote-desktop clients must use the backend API; direct database file access is disabled.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still no-ops outside Tauri when not in remote-desktop mode", async () => {
    const { loadDbFile, saveDbFile } = await loadPersistence();

    await expect(loadDbFile()).resolves.toBeNull();
    await expect(saveDbFile(new Uint8Array([1]))).resolves.toBeUndefined();
  });
});
