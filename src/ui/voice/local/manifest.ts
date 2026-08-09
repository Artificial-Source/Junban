/**
 * Immutable allowlist of local browser voice model files.
 *
 * Every downloadable weight is pinned by host, path, upstream revision,
 * exact byte length, and SHA-256. Mutable upstream roots are intentionally
 * absent.
 */

import type { LocalVoiceFileEntry, LocalVoiceManifest, LocalVoicePackage } from "./types.ts";

const HF_HOST = "https://huggingface.co";

function hfFile(
  repo: string,
  revision: string,
  path: string,
  bytes: number,
  sha256: string,
  license: LocalVoiceFileEntry["license"],
): LocalVoiceFileEntry {
  return {
    path,
    url: `${HF_HOST}/${repo}/resolve/${revision}/${path}`,
    bytes,
    sha256,
    license,
  };
}

const WHISPER_REPO = "onnx-community/whisper-tiny.en";
const WHISPER_REVISION = "2575352d61be1bf7225cf8f8b268a4678025fc58";
const WHISPER_ENGINE_VERSION = "@huggingface/transformers@3.8.1";

const KOKORO_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const KOKORO_ENGINE_VERSION = "kokoro-js@1.2.1";

const PIPER_REPO = "rhasspy/piper-voices";
const PIPER_REVISION = "9f967d15e9ccdf43078586d1476ee70f314401bd";
const PIPER_ENGINE_VERSION = "@mintplex-labs/piper-tts-web@1.0.4";

const WHISPER_TINY_EN_Q4: LocalVoicePackage = {
  id: "whisper-tiny.en-q4",
  engine: "whisper",
  displayName: "Whisper tiny.en (q4)",
  repo: WHISPER_REPO,
  revision: WHISPER_REVISION,
  engineVersion: WHISPER_ENGINE_VERSION,
  cacheKey: `junban-local-voice/whisper-tiny.en-q4/${WHISPER_REVISION}`,
  license: "OpenAI-Whisper-MIT",
  files: [
    hfFile(
      WHISPER_REPO,
      WHISPER_REVISION,
      "config.json",
      2197,
      "251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233",
      "OpenAI-Whisper-MIT",
    ),
    hfFile(
      WHISPER_REPO,
      WHISPER_REVISION,
      "generation_config.json",
      1646,
      "7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9",
      "OpenAI-Whisper-MIT",
    ),
    hfFile(
      WHISPER_REPO,
      WHISPER_REVISION,
      "preprocessor_config.json",
      339,
      "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d",
      "OpenAI-Whisper-MIT",
    ),
    hfFile(
      WHISPER_REPO,
      WHISPER_REVISION,
      "tokenizer.json",
      2405679,
      "5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0",
      "OpenAI-Whisper-MIT",
    ),
    hfFile(
      WHISPER_REPO,
      WHISPER_REVISION,
      "tokenizer_config.json",
      282662,
      "93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c",
      "OpenAI-Whisper-MIT",
    ),
    hfFile(
      WHISPER_REPO,
      WHISPER_REVISION,
      "added_tokens.json",
      34604,
      "560be47bea388757f8d4cc185c5d82067426cbb6361e38016dd90ddc01ab203a",
      "OpenAI-Whisper-MIT",
    ),
    hfFile(
      WHISPER_REPO,
      WHISPER_REVISION,
      "special_tokens_map.json",
      2173,
      "98bdf3ec5b32e31575b02f64b0a32bde7c0449075d34484a7df9bdd3cdeb9fb9",
      "OpenAI-Whisper-MIT",
    ),
    hfFile(
      WHISPER_REPO,
      WHISPER_REVISION,
      "merges.txt",
      456318,
      "1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5",
      "OpenAI-Whisper-MIT",
    ),
    hfFile(
      WHISPER_REPO,
      WHISPER_REVISION,
      "normalizer.json",
      52666,
      "bf1c507dc8724ca9cf9903640dacfb69dae2f00edee4f21ceba106a7392f26dd",
      "OpenAI-Whisper-MIT",
    ),
    hfFile(
      WHISPER_REPO,
      WHISPER_REVISION,
      "onnx/encoder_model_q4.onnx",
      9020667,
      "bb73f790e63906c9e9d02c4e3abf55817dd16fd7ef7c7f4754c1395202191b29",
      "OpenAI-Whisper-MIT",
    ),
    hfFile(
      WHISPER_REPO,
      WHISPER_REVISION,
      "onnx/decoder_model_merged_q4.onnx",
      86712166,
      "57d4303f3bbc8bb4016273b172285236f5719c75e8a7d23b7265cfa1d71494a4",
      "OpenAI-Whisper-MIT",
    ),
  ],
};

const KOKORO_Q8: LocalVoicePackage = {
  id: "kokoro-82m-v1-q8",
  engine: "kokoro",
  displayName: "Kokoro 82M v1.0 (q8)",
  repo: KOKORO_REPO,
  revision: KOKORO_REVISION,
  engineVersion: KOKORO_ENGINE_VERSION,
  cacheKey: `junban-local-voice/kokoro-82m-v1-q8/${KOKORO_REVISION}`,
  license: "Apache-2.0",
  files: [
    hfFile(
      KOKORO_REPO,
      KOKORO_REVISION,
      "config.json",
      44,
      "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
      "Apache-2.0",
    ),
    hfFile(
      KOKORO_REPO,
      KOKORO_REVISION,
      "tokenizer.json",
      3497,
      "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
      "Apache-2.0",
    ),
    hfFile(
      KOKORO_REPO,
      KOKORO_REVISION,
      "tokenizer_config.json",
      113,
      "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
      "Apache-2.0",
    ),
    hfFile(
      KOKORO_REPO,
      KOKORO_REVISION,
      "onnx/model_quantized.onnx",
      92361116,
      "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
      "Apache-2.0",
    ),
    hfFile(
      KOKORO_REPO,
      KOKORO_REVISION,
      "voices/af_heart.bin",
      522240,
      "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
      "Apache-2.0",
    ),
  ],
};

// English female default with permissive model + source-data terms (LJ Speech
// public domain per MODEL_CARD). HFC was rejected: its MODEL_CARD records a
// CC-BY-NC-SA-4.0 source-data condition unsuitable for silent MIT packaging.
const PIPER_LJSPEECH_MEDIUM: LocalVoicePackage = {
  id: "piper-en_US-ljspeech-medium",
  engine: "piper",
  displayName: "Piper en_US LJ Speech Female (medium)",
  repo: PIPER_REPO,
  revision: PIPER_REVISION,
  engineVersion: PIPER_ENGINE_VERSION,
  cacheKey: `junban-local-voice/piper-en_US-ljspeech-medium/${PIPER_REVISION}`,
  license: "MIT",
  files: [
    hfFile(
      PIPER_REPO,
      PIPER_REVISION,
      "en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx",
      63531379,
      "6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22",
      "MIT",
    ),
    hfFile(
      PIPER_REPO,
      PIPER_REVISION,
      "en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx.json",
      4972,
      "141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860",
      "MIT",
    ),
    hfFile(
      PIPER_REPO,
      PIPER_REVISION,
      "en/en_US/ljspeech/medium/MODEL_CARD",
      517,
      "fbee1529c89d36b3fe76d7e9f3f832dce17f44900a52d76a9bda735654766b4d",
      "public-domain",
    ),
  ],
};

/** Frozen production manifest. Do not mutate at runtime. */
export const LOCAL_VOICE_MANIFEST: LocalVoiceManifest = Object.freeze({
  version: 1 as const,
  packages: Object.freeze([
    Object.freeze(WHISPER_TINY_EN_Q4),
    Object.freeze(KOKORO_Q8),
    Object.freeze(PIPER_LJSPEECH_MEDIUM),
  ]),
});

const ALLOWED_LICENSES = new Set([
  "Apache-2.0",
  "MIT",
  "ISC",
  "public-domain",
  "OpenAI-Whisper-MIT",
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Local voice manifest invalid: ${label} must be a non-empty string`);
  }
  return value;
}

function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Local voice manifest invalid: ${label} must be a positive integer`);
  }
  return value;
}

function parseUrl(url: string, repo: string, revision: string, path: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Local voice manifest invalid: url is not absolute (${url})`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Local voice manifest invalid: url scheme must be https (${url})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Local voice manifest invalid: url must not include credentials (${url})`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      `Local voice manifest invalid: url must not include query or fragment (${url})`,
    );
  }
  if (parsed.hostname !== "huggingface.co") {
    throw new Error(`Local voice manifest invalid: unsupported host ${parsed.hostname}`);
  }
  const expectedPath = `/${repo}/resolve/${revision}/${path}`;
  if (parsed.pathname !== expectedPath) {
    throw new Error(
      `Local voice manifest invalid: url path mismatch for ${path}: ${parsed.pathname}`,
    );
  }
  const mutableRoot = `resolve/${"main"}`;
  if (parsed.pathname.includes(`/${mutableRoot}/`) || url.includes(mutableRoot)) {
    throw new Error(`Local voice manifest invalid: mutable ${mutableRoot} is forbidden`);
  }
  return parsed;
}

function parseFileEntry(
  value: unknown,
  repo: string,
  revision: string,
  seenPaths: Set<string>,
  seenUrls: Set<string>,
): LocalVoiceFileEntry {
  if (!isPlainObject(value)) {
    throw new Error("Local voice manifest invalid: file entry must be an object");
  }
  const allowed = new Set(["path", "url", "bytes", "sha256", "license"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Local voice manifest invalid: unknown file field "${key}"`);
    }
  }
  const path = assertString(value.path, "file.path");
  if (path.includes("\\") || path.startsWith("/") || path.includes("..")) {
    throw new Error(`Local voice manifest invalid: unsafe file path ${path}`);
  }
  if (seenPaths.has(path)) {
    throw new Error(`Local voice manifest invalid: duplicate file path ${path}`);
  }
  seenPaths.add(path);

  const url = assertString(value.url, "file.url");
  parseUrl(url, repo, revision, path);
  if (seenUrls.has(url)) {
    throw new Error(`Local voice manifest invalid: duplicate file url ${url}`);
  }
  seenUrls.add(url);

  const bytes = assertPositiveInt(value.bytes, "file.bytes");
  const sha256 = assertString(value.sha256, "file.sha256").toLowerCase();
  if (!SHA256_RE.test(sha256)) {
    throw new Error(`Local voice manifest invalid: sha256 must be 64 lowercase hex chars`);
  }
  const license = assertString(value.license, "file.license");
  if (!ALLOWED_LICENSES.has(license)) {
    throw new Error(`Local voice manifest invalid: unsupported file license ${license}`);
  }

  return {
    path,
    url,
    bytes,
    sha256,
    license: license as LocalVoiceFileEntry["license"],
  };
}

function parsePackage(value: unknown, seenIds: Set<string>): LocalVoicePackage {
  if (!isPlainObject(value)) {
    throw new Error("Local voice manifest invalid: package must be an object");
  }
  const allowed = new Set([
    "id",
    "engine",
    "displayName",
    "repo",
    "revision",
    "engineVersion",
    "cacheKey",
    "license",
    "files",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Local voice manifest invalid: unknown package field "${key}"`);
    }
  }

  const id = assertString(value.id, "package.id");
  if (!PACKAGE_ID_RE.test(id)) {
    throw new Error(`Local voice manifest invalid: package id format ${id}`);
  }
  if (seenIds.has(id)) {
    throw new Error(`Local voice manifest invalid: duplicate package id ${id}`);
  }
  seenIds.add(id);

  const engine = assertString(value.engine, "package.engine");
  if (engine !== "whisper" && engine !== "kokoro" && engine !== "piper") {
    throw new Error(`Local voice manifest invalid: unknown engine ${engine}`);
  }
  const displayName = assertString(value.displayName, "package.displayName");
  const repo = assertString(value.repo, "package.repo");
  if (repo.includes("..") || repo.startsWith("/")) {
    throw new Error(`Local voice manifest invalid: unsafe repo ${repo}`);
  }
  const revision = assertString(value.revision, "package.revision");
  if (revision === "main" || revision === "master" || revision === "latest") {
    throw new Error(`Local voice manifest invalid: mutable revision ${revision}`);
  }
  const engineVersion = assertString(value.engineVersion, "package.engineVersion");
  const cacheKey = assertString(value.cacheKey, "package.cacheKey");
  if (!cacheKey.startsWith("junban-local-voice/")) {
    throw new Error(`Local voice manifest invalid: cacheKey prefix`);
  }
  const license = assertString(value.license, "package.license");
  if (!ALLOWED_LICENSES.has(license)) {
    throw new Error(`Local voice manifest invalid: unsupported package license ${license}`);
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error(`Local voice manifest invalid: package ${id} must list files`);
  }

  const seenPaths = new Set<string>();
  const seenUrls = new Set<string>();
  const files = value.files.map((file) =>
    parseFileEntry(file, repo, revision, seenPaths, seenUrls),
  );

  return {
    id,
    engine,
    displayName,
    repo,
    revision,
    engineVersion,
    cacheKey,
    license: license as LocalVoicePackage["license"],
    files,
  };
}

/**
 * Parse and validate a local-voice manifest. Rejects unknown fields, duplicates,
 * mutable revisions, credentialed/query URLs, and non-HTTPS hosts.
 */
export function parseLocalVoiceManifest(input: unknown): LocalVoiceManifest {
  if (!isPlainObject(input)) {
    throw new Error("Local voice manifest invalid: root must be an object");
  }
  const allowed = new Set(["version", "packages"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`Local voice manifest invalid: unknown root field "${key}"`);
    }
  }
  if (input.version !== 1) {
    throw new Error("Local voice manifest invalid: version must be 1");
  }
  if (!Array.isArray(input.packages) || input.packages.length === 0) {
    throw new Error("Local voice manifest invalid: packages must be a non-empty array");
  }
  const seenIds = new Set<string>();
  const packages = input.packages.map((pkg) => parsePackage(pkg, seenIds));
  return { version: 1, packages };
}

/** Validate the frozen committed manifest at module evaluation of callers that opt in. */
export function getValidatedLocalVoiceManifest(
  manifest: LocalVoiceManifest = LOCAL_VOICE_MANIFEST,
): LocalVoiceManifest {
  return parseLocalVoiceManifest(structuredClone(manifest));
}

export function getLocalVoicePackage(
  packageId: string,
  manifest: LocalVoiceManifest = LOCAL_VOICE_MANIFEST,
): LocalVoicePackage {
  const validated = getValidatedLocalVoiceManifest(manifest);
  const match = validated.packages.find((pkg) => pkg.id === packageId);
  if (!match) {
    throw new Error(`Unknown local voice package: ${packageId}`);
  }
  return match;
}

export function listLocalVoicePackages(
  manifest: LocalVoiceManifest = LOCAL_VOICE_MANIFEST,
): readonly LocalVoicePackage[] {
  return getValidatedLocalVoiceManifest(manifest).packages;
}
