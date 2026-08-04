import { describe, expect, it, vi } from "vitest";
import indexSource from "./index.ts?raw";
import loadKokoroSource from "./engines/load-kokoro.ts?raw";
import loadPiperSource from "./engines/load-piper.ts?raw";
import loadVadSource from "./engines/load-vad.ts?raw";
import loadWhisperSource from "./engines/load-whisper.ts?raw";
import engineStatusSource from "./engine-status.ts?raw";
import manifestSource from "./manifest.ts?raw";
import protocolSource from "./protocol.ts?raw";
import verifySource from "./verify-fetch.ts?raw";
import workerClientSource from "./worker-client.ts?raw";
import workerHostSource from "./worker-host.ts?raw";
import kokoroWorkerSource from "./workers/kokoro.worker.ts?raw";
import piperWorkerSource from "./workers/piper.worker.ts?raw";
import whisperWorkerSource from "./workers/whisper.worker.ts?raw";
import workerRuntimeSource from "./workers/worker-runtime.ts?raw";

const ENGINE_PACKAGES = [
  "@huggingface/transformers",
  "@ricky0123/vad-web",
  "kokoro-js",
  "@mintplex-labs/piper-tts-web",
  "@diffusionstudio/piper-wasm",
  "onnxruntime-web",
  "onnxruntime-node",
  "sharp",
] as const;

describe("local voice ordinary module load", () => {
  it("does not statically import engine packages from the public boundary", () => {
    for (const source of [
      indexSource,
      manifestSource,
      verifySource,
      protocolSource,
      workerClientSource,
      workerHostSource,
      engineStatusSource,
      workerRuntimeSource,
    ]) {
      for (const pkg of ENGINE_PACKAGES) {
        expect(source).not.toMatch(
          new RegExp(`from\\s+["']${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`),
        );
        expect(source).not.toContain(`require("${pkg}")`);
      }
    }

    expect(indexSource).not.toContain('import("@huggingface/transformers")');
    expect(indexSource).not.toContain('import("kokoro-js")');
    expect(indexSource).not.toContain('import("@mintplex-labs/piper-tts-web")');
    expect(indexSource).not.toContain('import("@ricky0123/vad-web")');
    expect(indexSource).not.toContain("new Worker(");
    expect(workerClientSource).not.toContain('import("@huggingface/transformers")');
  });

  it("loads the public boundary without touching fetch, workers, or engine packages", async () => {
    const fetchSpy = vi.fn();
    const workerSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal(
      "Worker",
      class {
        constructor(...args: unknown[]) {
          workerSpy(...args);
        }
      },
    );

    const mod = await import("./index.ts");
    expect(mod.LOCAL_VOICE_MANIFEST.packages.length).toBe(3);
    expect(
      mod
        .listLocalVoicePackages()
        .map((pkg) => pkg.engine)
        .sort(),
    ).toEqual(["kokoro", "piper", "whisper"]);
    expect(typeof mod.createLocalWhisperClient).toBe("function");
    expect(typeof mod.getLocalEngineStatus).toBe("function");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(workerSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("keeps engine loader modules free of top-level package imports", () => {
    const files = [
      loadWhisperSource,
      loadKokoroSource,
      loadPiperSource,
      loadVadSource,
      whisperWorkerSource,
      kokoroWorkerSource,
      piperWorkerSource,
    ];
    for (const source of files) {
      for (const pkg of ENGINE_PACKAGES) {
        const staticImport = new RegExp(
          `^\\s*import\\s+[^;]*from\\s+["']${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
          "m",
        );
        expect(source).not.toMatch(staticImport);
      }
    }
  });
});
