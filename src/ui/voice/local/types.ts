/**
 * Strict types for the browser-local voice model boundary.
 * No engine package types are imported here so ordinary module load stays inert.
 */

export type LocalVoiceEngine = "whisper" | "kokoro" | "piper";

export type LocalVoiceLicense =
  "Apache-2.0" | "MIT" | "ISC" | "public-domain" | "OpenAI-Whisper-MIT";

/** One immutable file within a checked local-model package. */
export type LocalVoiceFileEntry = {
  readonly path: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly license: LocalVoiceLicense;
};

/** One supported local engine package pinned by upstream revision. */
export type LocalVoicePackage = {
  readonly id: string;
  readonly engine: LocalVoiceEngine;
  readonly displayName: string;
  readonly repo: string;
  readonly revision: string;
  readonly engineVersion: string;
  readonly cacheKey: string;
  readonly license: LocalVoiceLicense;
  readonly files: readonly LocalVoiceFileEntry[];
};

export type LocalVoiceManifest = {
  readonly version: 1;
  readonly packages: readonly LocalVoicePackage[];
};

export type VerifyProgress = {
  readonly packageId: string;
  readonly filePath: string;
  readonly loaded: number;
  readonly total: number;
};

export type VerifiedBytes = {
  readonly packageId: string;
  readonly filePath: string;
  readonly url: string;
  readonly bytes: ArrayBuffer;
  readonly sha256: string;
};
