import { describe, expect, it } from "vitest";
import {
  LOCAL_VOICE_MANIFEST,
  getLocalVoicePackage,
  getValidatedLocalVoiceManifest,
  parseLocalVoiceManifest,
} from "./manifest.ts";
import type { LocalVoiceManifest } from "./types.ts";

function mutableManifest(): LocalVoiceManifest {
  return JSON.parse(JSON.stringify(LOCAL_VOICE_MANIFEST)) as LocalVoiceManifest;
}

describe("local voice manifest", () => {
  it("validates the frozen committed manifest", () => {
    const validated = getValidatedLocalVoiceManifest();
    expect(validated.version).toBe(1);
    expect(validated.packages.map((pkg) => pkg.id)).toEqual([
      "whisper-tiny.en-q4",
      "kokoro-82m-v1-q8",
      "piper-en_US-ljspeech-medium",
    ]);
    for (const pkg of validated.packages) {
      expect(pkg.revision).not.toBe("main");
      expect(pkg.cacheKey.startsWith("junban-local-voice/")).toBe(true);
      for (const file of pkg.files) {
        expect(file.url).toContain(`/resolve/${pkg.revision}/`);
        expect(file.url).not.toContain("resolve/main");
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.bytes).toBeGreaterThan(0);
      }
    }
  });

  it("rejects unknown root fields", () => {
    expect(() =>
      parseLocalVoiceManifest({
        ...mutableManifest(),
        extra: true,
      }),
    ).toThrow(/unknown root field "extra"/);
  });

  it("rejects unknown package fields", () => {
    const draft = mutableManifest() as LocalVoiceManifest & {
      packages: Array<Record<string, unknown>>;
    };
    draft.packages[0]!.unexpected = true;
    expect(() => parseLocalVoiceManifest(draft)).toThrow(/unknown package field "unexpected"/);
  });

  it("rejects unknown file fields", () => {
    const draft = mutableManifest() as LocalVoiceManifest & {
      packages: Array<{ files: Array<Record<string, unknown>> }>;
    };
    draft.packages[0]!.files[0]!.token = "secret";
    expect(() => parseLocalVoiceManifest(draft)).toThrow(/unknown file field "token"/);
  });

  it("rejects duplicate package ids", () => {
    const draft = mutableManifest() as LocalVoiceManifest & {
      packages: Array<Record<string, unknown>>;
    };
    draft.packages.push({ ...draft.packages[0]! });
    expect(() => parseLocalVoiceManifest(draft)).toThrow(/duplicate package id/);
  });

  it("rejects duplicate file paths within a package", () => {
    const draft = mutableManifest() as LocalVoiceManifest & {
      packages: Array<{ files: Array<Record<string, unknown>> }>;
    };
    const pkg = draft.packages[0]!;
    pkg.files.push({ ...pkg.files[0]! });
    expect(() => parseLocalVoiceManifest(draft)).toThrow(/duplicate file path/);
  });

  it("rejects mutable revisions", () => {
    const draft = mutableManifest() as LocalVoiceManifest & {
      packages: Array<{ revision: string; files: Array<{ url: string }> }>;
    };
    draft.packages[0]!.revision = "main";
    draft.packages[0]!.files = draft.packages[0]!.files.map((file) => ({
      ...file,
      url: file.url.replace(/\/resolve\/[^/]+\//, "/resolve/main/"),
    }));
    expect(() => parseLocalVoiceManifest(draft)).toThrow(/mutable revision/);
  });

  it("rejects non-HTTPS hosts and credentialed or query URLs", () => {
    const draft = mutableManifest() as LocalVoiceManifest & {
      packages: Array<{ files: Array<{ url: string }> }>;
    };
    draft.packages[0]!.files[0]!.url = draft.packages[0]!.files[0]!.url.replace(
      "https://",
      "http://",
    );
    expect(() => parseLocalVoiceManifest(draft)).toThrow(/https/);

    const draftHost = mutableManifest() as LocalVoiceManifest & {
      packages: Array<{ files: Array<{ url: string }> }>;
    };
    draftHost.packages[0]!.files[0]!.url = draftHost.packages[0]!.files[0]!.url.replace(
      "huggingface.co",
      "evil.example",
    );
    expect(() => parseLocalVoiceManifest(draftHost)).toThrow(/unsupported host/);

    const draftCred = mutableManifest() as LocalVoiceManifest & {
      packages: Array<{ files: Array<{ url: string }> }>;
    };
    draftCred.packages[0]!.files[0]!.url = draftCred.packages[0]!.files[0]!.url.replace(
      "https://",
      "https://user:pass@",
    );
    expect(() => parseLocalVoiceManifest(draftCred)).toThrow(/credentials/);

    const draftQuery = mutableManifest() as LocalVoiceManifest & {
      packages: Array<{ files: Array<{ url: string }> }>;
    };
    draftQuery.packages[0]!.files[0]!.url = `${draftQuery.packages[0]!.files[0]!.url}?token=secret`;
    expect(() => parseLocalVoiceManifest(draftQuery)).toThrow(/query or fragment/);
  });

  it("looks up packages by id", () => {
    expect(getLocalVoicePackage("kokoro-82m-v1-q8").engine).toBe("kokoro");
    expect(() => getLocalVoicePackage("nope")).toThrow(/Unknown local voice package/);
  });
});
