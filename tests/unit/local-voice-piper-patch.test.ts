import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("piper package patch", () => {
  it("removes CDN defaults and blocks download() in the installed package", async () => {
    const pkgPath = path.join(
      root,
      "node_modules/@mintplex-labs/piper-tts-web/dist/piper-tts-web.js",
    );
    const source = readFileSync(pkgPath, "utf8");
    expect(source).not.toContain("cdn.jsdelivr.net");
    expect(source).not.toContain("cdnjs.cloudflare.com");
    expect(source).not.toContain("resolve/main");
    expect(source).toContain("Junban blocks @mintplex-labs/piper-tts-web download()");

    const piper = await import("@mintplex-labs/piper-tts-web");
    await expect(piper.download("en_US-hfc_female-medium")).rejects.toThrow(/Junban blocks/);
  });
});
