import { describe, expect, it } from "vitest";
import { getLocalVoicePackage } from "./manifest.ts";
import { matchPackageFileUrl } from "./verified-model-cache.ts";

describe("matchPackageFileUrl", () => {
  const pkg = getLocalVoicePackage("kokoro-82m-v1-q8");

  it("matches exact pinned HF URLs", () => {
    const file = pkg.files[0]!;
    expect(matchPackageFileUrl(pkg, file.url)).toBe(file.path);
  });

  it("maps kokoro resolve/main keys to pinned verified paths", () => {
    expect(
      matchPackageFileUrl(pkg, `https://huggingface.co/${pkg.repo}/resolve/main/config.json`),
    ).toBe("config.json");
    expect(
      matchPackageFileUrl(
        pkg,
        `https://huggingface.co/${pkg.repo}/resolve/main/onnx/model_quantized.onnx`,
      ),
    ).toBe("onnx/model_quantized.onnx");
  });

  it("maps transformers localModelPath keys", () => {
    expect(matchPackageFileUrl(pkg, `/models/${pkg.repo}/tokenizer.json`)).toBe("tokenizer.json");
    expect(matchPackageFileUrl(pkg, `models/${pkg.repo}/tokenizer_config.json`)).toBe(
      "tokenizer_config.json",
    );
  });

  it("maps junban-blocked voice seeds", () => {
    expect(
      matchPackageFileUrl(
        pkg,
        `https://huggingface.co/${pkg.repo}/resolve/junban-blocked/voices/af_heart.bin`,
      ),
    ).toBe("voices/af_heart.bin");
  });

  it("rejects foreign repos and path traversal", () => {
    expect(
      matchPackageFileUrl(pkg, "https://huggingface.co/evil/resolve/main/config.json"),
    ).toBeNull();
    expect(matchPackageFileUrl(pkg, `/models/${pkg.repo}/../etc/passwd`)).toBeNull();
  });
});
