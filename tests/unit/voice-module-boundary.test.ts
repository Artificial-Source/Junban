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
    expect(index).not.toContain("local-adapters");
    expect(index).not.toContain("worker-client");
  });

  it("useLocalVoiceAdapters keeps local engines behind dynamic import", () => {
    const source = readFileSync(path.join(voiceRoot, "useLocalVoiceAdapters.ts"), "utf8");
    expect(source).toMatch(/import\("\.\/local-adapters"\)/);
    expect(source).not.toMatch(/from\s+["']\.\/local-adapters["']/);
    expect(source).not.toMatch(/from\s+["']\.\/local["']/);
    expect(source).not.toContain("worker-host");
    expect(source).not.toContain("loadWhisperEngine");
    expect(source).not.toMatch(/@huggingface\/transformers|kokoro-js|piper-tts-web/);
  });

  it("AI chat route does not statically import local adapters or engines", () => {
    const route = readFileSync(
      path.resolve(import.meta.dirname, "../../src/ui/ai/AIChatRoute.tsx"),
      "utf8",
    );
    expect(route).toMatch(/useLocalVoiceAdapters/);
    expect(route).not.toMatch(/from\s+["'].*local-adapters["']/);
    expect(route).not.toMatch(/voice\/local\/engines|worker-host|worker-client/);
    expect(route).not.toMatch(/@huggingface\/transformers|kokoro-js|piper-tts-web/);
  });

  it("Wave 5 acceptance seam stays dynamic and engine-free at module top level", () => {
    const acceptanceDir = path.join(voiceRoot, "acceptance");
    const files = readdirSync(acceptanceDir)
      .filter((name) => /\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts"))
      .map((name) => path.join(acceptanceDir, name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/from\s+["']@huggingface\/transformers["']/);
      expect(source).not.toMatch(/from\s+["']kokoro-js["']/);
      expect(source).not.toMatch(/from\s+["']@mintplex-labs\/piper-tts-web["']/);
      expect(source).not.toMatch(/from\s+["']@ricky0123\/vad-web["']/);
    }
    const root = readFileSync(path.join(acceptanceDir, "LocalVoiceAcceptanceRoot.tsx"), "utf8");
    expect(root).toMatch(/import\("\.\/runLocalVoiceAcceptance\.ts"\)/);
    expect(root).not.toMatch(/from\s+["']\.\/runLocalVoiceAcceptance/);
    const runner = readFileSync(path.join(acceptanceDir, "runLocalVoiceAcceptance.ts"), "utf8");
    expect(runner).toMatch(/import\("\.\.\/local\/index"\)/);
    expect(runner).not.toMatch(/from\s+["']\.\.\/local\/index["']/);
    expect(runner).not.toMatch(/from\s+["']\.\.\/local\/engines\//);
  });
});
