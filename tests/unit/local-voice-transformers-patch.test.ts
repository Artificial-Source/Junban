import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

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

  it("imports without network and allows overwriting wasmPaths before inference", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("unexpected network during transformers import");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const transformers = await import("@huggingface/transformers");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(transformers.env.version).toBe("3.8.1");

    const backends = transformers.env.backends as {
      onnx?: { wasm?: { wasmPaths?: string | Record<string, string> } };
    };
    // Mirror loader: ensure structure exists, start from sentinel, then overwrite.
    if (!backends.onnx) {
      backends.onnx = { wasm: { wasmPaths: WASM_SENTINEL } };
    } else {
      backends.onnx.wasm = backends.onnx.wasm ?? {};
      backends.onnx.wasm.wasmPaths = WASM_SENTINEL;
    }
    expect(backends.onnx.wasm?.wasmPaths).toBe(WASM_SENTINEL);

    backends.onnx.wasm!.wasmPaths = "/assets/ort-same-origin/";
    expect(transformers.env.backends.onnx?.wasm?.wasmPaths).toBe("/assets/ort-same-origin/");

    vi.unstubAllGlobals();
  });
});
