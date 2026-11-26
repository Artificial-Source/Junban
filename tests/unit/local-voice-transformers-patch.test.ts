import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { configureVerifiedTransformers } from "../../src/ui/voice/local/engines/configure-transformers.ts";

const WASM_SENTINEL = "/__junban_local_voice_wasm_unconfigured__/";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("transformers CDN patch", () => {
  it("browser web bundles use the inert sentinel instead of package CDN defaults", () => {
    for (const rel of [
      "node_modules/@huggingface/transformers/dist/transformers.web.js",
      "node_modules/@huggingface/transformers/dist/transformers.web.min.js",
      "node_modules/@huggingface/transformers/src/backends/onnx.js",
    ]) {
      const source = readFileSync(path.join(root, rel), "utf8");
      expect(source, rel).toContain(WASM_SENTINEL);
      expect(source, rel).not.toContain("cdn.jsdelivr.net");
      expect(source, rel).not.toContain("cdnjs.cloudflare.com");
      expect(source, rel).not.toMatch(/throw new Error\(["']ONNX wasmPaths is unset/);
    }
  });

  it("imports without network and only uses verified models and shipped WASM URLs", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected network during transformers import");
    });
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const transformers = await import("@huggingface/transformers");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(transformers.env.version).toBe("4.3.2");
      expect(transformers.env.backends.onnx.wasm?.wasmPaths).toMatchObject({
        mjs: expect.stringContaining(WASM_SENTINEL),
        wasm: expect.stringContaining(WASM_SENTINEL),
      });

      const paths = { mjs: "/assets/test-ort.mjs", wasm: "/assets/test-ort.wasm" };
      configureVerifiedTransformers(transformers.env, "whisper-tiny.en-q4", paths);
      expect(transformers.env.backends.onnx.wasm?.wasmPaths).toEqual(paths);
      expect(transformers.env.useWasmCache).toBe(false);
      await expect(transformers.env.fetch("/models/unverified.onnx")).rejects.toMatchObject({
        code: "cache_miss",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
