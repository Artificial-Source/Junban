import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distDir = path.join(root, "dist");

const FORBIDDEN = ["cdn.jsdelivr.net", "cdnjs.cloudflare.com", "resolve/main", "onnxruntime-node"];

const ENGINE_MARKERS = [
  "@huggingface/transformers",
  "kokoro-js",
  "@mintplex-labs/piper-tts-web",
  "@ricky0123/vad-web",
  "whisper-tiny.en",
  "Kokoro-82M",
  "piper_phonemize",
  "silero_vad",
];

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

describe("local voice built assets", () => {
  it("keeps initial dist entry chunks free of local engine/model code when dist exists", () => {
    if (!existsSync(path.join(distDir, "index.html"))) {
      expect(true).toBe(true);
      return;
    }

    const indexHtml = readFileSync(path.join(distDir, "index.html"), "utf8");
    for (const marker of [...FORBIDDEN, ...ENGINE_MARKERS]) {
      expect(indexHtml, `index.html contains ${marker}`).not.toContain(marker);
    }

    const scriptSrcs = [...indexHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(
      (match) => match[1]!,
    );
    expect(scriptSrcs.length).toBeGreaterThan(0);

    for (const src of scriptSrcs) {
      const assetPath = path.join(distDir, src.replace(/^\//, ""));
      expect(existsSync(assetPath), assetPath).toBe(true);
      const text = readFileSync(assetPath, "utf8");
      for (const marker of [...FORBIDDEN, ...ENGINE_MARKERS]) {
        expect(text, `${src} contains ${marker}`).not.toContain(marker);
      }
    }
  });

  it("rejects forbidden CDN/mutable roots across all shipped JS when dist exists", () => {
    if (!existsSync(distDir)) {
      expect(true).toBe(true);
      return;
    }
    const jsFiles = listFiles(distDir).filter((file) => /\.m?js$/.test(file));
    for (const file of jsFiles) {
      const text = readFileSync(file, "utf8");
      for (const needle of FORBIDDEN) {
        expect(text, `${path.relative(root, file)} contains ${needle}`).not.toContain(needle);
      }
      expect(text).not.toMatch(/["']sharp["']/);
      expect(text).not.toMatch(/new\s+Worker\s*\(\s*[`'"]https?:\/\//);
    }
  });
});
