/**
 * Machine-readable Phase 6 Wave 5 local-voice acceptance report.
 * No secrets, tokens, raw model bytes, or provider credentials.
 */

export type AcceptanceEngineId = "whisper" | "kokoro" | "piper";

export type AcceptancePackageEvidence = {
  packageId: string;
  engine: AcceptanceEngineId;
  repo: string;
  revision: string;
  engineVersion: string;
  license: string;
  totalBytes: number;
  fileCount: number;
  primarySha256: string;
};

export type AcceptanceTiming = {
  /** Wall ms for first verified download (network + hash admit). */
  firstDownloadMs: number | null;
  /** Wall ms for warm reverify + worker load (no network expected). */
  warmLoadMs: number | null;
  /** Wall ms for one inference call. */
  inferMs: number | null;
};

export type AcceptanceWhisperResult = {
  engine: "whisper";
  ok: boolean;
  package: AcceptancePackageEvidence;
  timing: AcceptanceTiming;
  transcript: string | null;
  /** Expected phrase tokens observed in the transcript (lowercased). */
  matchedTokens: string[];
  sampleCount: number;
  sampleRateHz: number;
  error: string | null;
};

export type AcceptanceSynthesisResult = {
  engine: "kokoro" | "piper";
  ok: boolean;
  package: AcceptancePackageEvidence;
  timing: AcceptanceTiming;
  format: "pcm-f32" | "wav" | null;
  sampleRateHz: number | null;
  channels: number | null;
  /** Output payload bytes (PCM buffer or WAV container). */
  byteLength: number | null;
  /** Derived duration seconds when sample rate is known. */
  durationSeconds: number | null;
  /** True when AudioContext/HTMLAudio playback path produced playable audio. */
  playable: boolean;
  error: string | null;
};

export type AcceptanceCleanupObservation = {
  workersTerminated: boolean;
  audioContextsClosed: boolean;
  mediaTracksStopped: boolean;
  objectUrlsRevoked: boolean;
  notes: string[];
};

export type AcceptanceCacheObservation = {
  firstDownloadUsedNetwork: boolean;
  warmReuseSkippedNetwork: boolean;
  reverifyPassed: boolean;
  cancelledLoadRecovered: boolean;
  failedLoadRecovered: boolean;
};

export type AcceptanceRequestLogEntry = {
  url: string;
  method: string;
  resourceType: string;
  /** Host only — never query strings that might carry signed CDN noise in logs beyond host. */
  host: string;
};

export type LocalVoiceAcceptanceReport = {
  id: "phase-6-local-voice";
  version: 1;
  status: "passed" | "failed" | "blocked";
  startedAt: string;
  finishedAt: string;
  browser: {
    userAgent: string;
    language: string;
  };
  fixture: {
    name: string;
    sha256: string;
    bytes: number;
    phrase: string;
    sampleRateHz: number;
  };
  packages: AcceptancePackageEvidence[];
  whisper: AcceptanceWhisperResult | null;
  kokoro: AcceptanceSynthesisResult | null;
  piper: AcceptanceSynthesisResult | null;
  cache: AcceptanceCacheObservation;
  cleanup: AcceptanceCleanupObservation;
  requestLog: AcceptanceRequestLogEntry[];
  errors: string[];
};

export type LocalVoiceAcceptanceInput = {
  /** Base64 of the committed 16 kHz mono WAV fixture. */
  fixtureWavBase64: string;
  fixtureSha256: string;
  fixtureName: string;
  fixturePhrase: string;
  /** When true, wipe verified OPFS packages before first download. */
  clearBeforeRun?: boolean;
};
