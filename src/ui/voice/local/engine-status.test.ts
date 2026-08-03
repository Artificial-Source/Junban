import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAllLocalEngineStatuses,
  getLocalEngineStatus,
  removeLocalEngine,
  removeLocalEnginePackage,
} from "./engine-status.ts";
import { getLocalVoicePackage, listLocalVoicePackages } from "./manifest.ts";
import { installMemoryOpfs } from "./opfs-mock.ts";

describe("local engine status/remove", () => {
  beforeEach(() => {
    installMemoryOpfs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports not installed when OPFS is empty", async () => {
    const status = await getLocalEngineStatus("whisper");
    expect(status.engine).toBe("whisper");
    expect(status.installed).toBe(false);
    expect(status.verified).toBe(false);
    expect(status.files.every((f) => !f.present)).toBe(true);
    expect(status.repo).toContain("whisper");
    expect(status.totalBytes).toBeGreaterThan(0);
    expect(status.license.length).toBeGreaterThan(0);
    expect(status.revision.length).toBeGreaterThan(0);

    const all = await getAllLocalEngineStatuses();
    expect(all.map((s) => s.engine).sort()).toEqual(["kokoro", "piper", "whisper"]);
  });

  it("remove clears only the selected package and piper/kokoro seeds", async () => {
    const deleted: string[] = [];
    vi.stubGlobal("caches", {
      open: async () => ({
        delete: async (req: RequestInfo) => {
          const url = req instanceof Request ? req.url : String(req);
          deleted.push(url);
          return true;
        },
      }),
    });

    const root = await navigator.storage.getDirectory();
    const piperDir = await root.getDirectoryHandle("piper", { create: true });
    for (const name of [
      "en_US-ljspeech-medium.onnx",
      "en_US-ljspeech-medium.onnx.json",
      "other-voice.onnx",
    ]) {
      const handle = await piperDir.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      await w.write(new Uint8Array([1]));
      await w.close();
    }

    expect(listLocalVoicePackages()).toHaveLength(3);

    await removeLocalEngine("piper");
    await expect(piperDir.getFileHandle("other-voice.onnx")).resolves.toBeTruthy();
    await expect(piperDir.getFileHandle("en_US-ljspeech-medium.onnx")).rejects.toBeTruthy();

    await removeLocalEnginePackage(getLocalVoicePackage("kokoro-82m-v1-q8").id);
    expect(deleted.some((url) => url.includes("af_heart.bin"))).toBe(true);

    const whisper = await getLocalEngineStatus("whisper");
    expect(whisper.packageId).toBe("whisper-tiny.en-q4");
  });
});
