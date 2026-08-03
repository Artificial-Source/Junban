/**
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const voiceRoot = path.resolve(import.meta.dirname, "../../src/ui/voice");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "local") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("voice module boundary", () => {
  it("does not statically import local engine packages outside local/", () => {
    const banned = [
      "@huggingface/transformers",
      "@ricky0123/vad-web",
      "kokoro-js",
      "@mintplex-labs/piper-tts-web",
      "onnxruntime-web",
      "onnxruntime-node",
      "sharp",
    ];
    for (const file of listTsFiles(voiceRoot)) {
      const source = readFileSync(file, "utf8");
      for (const pkg of banned) {
        expect(source).not.toContain(`from "${pkg}"`);
        expect(source).not.toContain(`from '${pkg}'`);
        expect(source).not.toContain(`require("${pkg}")`);
      }
      // Dynamic vad load only after gesture via vad-loader bridge.
      if (file.endsWith("vad-session.ts")) {
        expect(source).toContain('import("./vad-loader.ts")');
        expect(source).not.toContain("loadWhisperEngine");
        expect(source).not.toContain("worker-host");
      }
      if (!file.endsWith("vad-loader.ts")) {
        expect(source).not.toContain('import("@ricky0123/vad-web")');
      }
    }
  });

  it("public index does not import Whisper/Kokoro/Piper workers", () => {
    const index = readFileSync(path.join(voiceRoot, "index.ts"), "utf8");
    expect(index).not.toContain("loadWhisperEngine");
    expect(index).not.toContain("loadKokoroEngine");
    expect(index).not.toContain("loadPiperEngine");
    expect(index).not.toContain("/workers/");
  });
});
