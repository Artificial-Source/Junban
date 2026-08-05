import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getLocalVoicePackage } from "../../src/ui/voice/local/manifest.ts";

const PIPER_PACKAGE_ID = "piper-en_US-ljspeech-medium";
const PIPER_VOICE_ID = "en_US-ljspeech-medium";
const PIPER_OPFS_URL_ROOT =
  "https://huggingface.co/rhasspy/piper-voices/resolve/junban-blocked/en/en_US/ljspeech/medium";

/**
 * The patched piper package stores/reads OPFS entries by the final path segment
 * of `${HF_BASE}/${PATH_MAP[voiceId]}` (and `.json`). Seed filenames must match.
 */
describe("piper OPFS key alignment", () => {
  it("seeds the same basename keys the patched package readBlob uses", async () => {
    const pkg = getLocalVoicePackage(PIPER_PACKAGE_ID);
    expect(pkg.id).toBe(PIPER_PACKAGE_ID);

    const piperPkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../node_modules/@mintplex-labs/piper-tts-web/dist/piper-tts-web.js",
    );
    const source = readFileSync(piperPkgPath, "utf8");
    expect(source).toContain('const path = url.split("/").at(-1)');
    expect(source).toContain("resolve/junban-blocked");
    expect(source).not.toContain("cdn.jsdelivr.net");

    const pathMapMatch = source.match(new RegExp(`"${PIPER_VOICE_ID}"\\s*:\\s*"([^"]+)"`));
    expect(pathMapMatch?.[1]).toBe("en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx");
    const mapped = pathMapMatch![1]!;
    const onnxKey = mapped.split("/").at(-1)!;
    const jsonKey = `${onnxKey}.json`;

    const onnxFile = pkg.files.find((f) => f.path.endsWith(".onnx"))!;
    const jsonFile = pkg.files.find((f) => f.path.endsWith(".onnx.json"))!;
    expect(onnxFile.path.split("/").at(-1)).toBe(onnxKey);
    expect(jsonFile.path.split("/").at(-1)).toBe(jsonKey);

    expect(`${PIPER_OPFS_URL_ROOT}/${onnxKey}`.split("/").at(-1)).toBe(onnxKey);
    expect(`${PIPER_OPFS_URL_ROOT}/${onnxKey}.json`.split("/").at(-1)).toBe(jsonKey);

    const piper = await import("@mintplex-labs/piper-tts-web");
    await expect(piper.download(PIPER_VOICE_ID)).rejects.toThrow(/Junban blocks/);
  });
});
