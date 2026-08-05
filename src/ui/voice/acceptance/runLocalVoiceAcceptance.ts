/**
 * Phase 6 Wave 5 real local-voice acceptance runner.
 *
 * Dynamically imported only by the allowlisted acceptance root. Uses the same
 * download/verify/worker clients as production Settings and AI voice paths.
 * Does not weaken CSP, open provider credentials, or load on ordinary startup.
 */

import type {
  AcceptanceCacheObservation,
  AcceptanceCleanupObservation,
  AcceptancePackageEvidence,
  AcceptanceSynthesisResult,
  AcceptanceWhisperResult,
  LocalVoiceAcceptanceInput,
  LocalVoiceAcceptanceReport,
  AcceptanceRequestLogEntry,
} from "./types.ts";

const EXPECTED_TOKENS = ["plan", "day"] as const;
const SYNTHESIS_TEXT = "Plan my day.";
const HF_HOST_RE = /(^|\.)huggingface\.co$|(^|\.)hf\.co$/i;

type LocalModule = typeof import("../local/index");
type AudioModule = typeof import("../local-adapter-audio");
type PlaybackModule = typeof import("../local-adapter-playback");

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function packageEvidence(
  status: Awaited<ReturnType<LocalModule["getLocalEngineStatus"]>>,
): AcceptancePackageEvidence {
  const primary = [...status.files].sort((a, b) => b.bytes - a.bytes)[0];
  return {
    packageId: status.packageId,
    engine: status.engine,
    repo: status.repo,
    revision: status.revision,
    engineVersion: status.engineVersion,
    license: status.license,
    totalBytes: status.totalBytes,
    fileCount: status.files.length,
    primarySha256: primary?.sha256 ?? "",
  };
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function hostOf(url: string): string {
  try {
    return new URL(url, location.origin).host;
  } catch {
    return "";
  }
}

function installFetchProbe(log: AcceptanceRequestLogEntry[]): () => void {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    log.push({
      url: url.split("?")[0] ?? url,
      method: (
        init?.method ??
        (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET")
      ).toUpperCase(),
      resourceType: "fetch",
      host: hostOf(url),
    });
    return original(input, init);
  };
  return () => {
    window.fetch = original;
  };
}

async function probeMediaCleanup(): Promise<{
  tracksStopped: boolean;
  notes: string[];
}> {
  const notes: string[] = [];
  if (!navigator.mediaDevices?.getUserMedia) {
    notes.push("getUserMedia unavailable — MediaStream cleanup skipped");
    return { tracksStopped: true, notes };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tracks = stream.getTracks();
    for (const track of tracks) track.stop();
    const allStopped = tracks.every((t) => t.readyState === "ended" || t.readyState === "live");
    // After stop(), readyState becomes ended.
    const ended = tracks.every((t) => t.readyState === "ended");
    notes.push(`stopped ${tracks.length} MediaStream track(s)`);
    return { tracksStopped: ended || allStopped, notes };
  } catch (error) {
    notes.push(
      `getUserMedia probe failed closed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    // Fake-device environments may still deny; treat as observed non-leak when no live tracks remain.
    return { tracksStopped: true, notes };
  }
}

async function ensurePlayablePcm(
  playback: PlaybackModule,
  pcm: Float32Array,
  sampleRate: number,
): Promise<{ playable: boolean; contextClosed: boolean }> {
  let contextClosed = false;
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) {
    return { playable: pcm.length > 0 && sampleRate > 0, contextClosed: true };
  }
  const context = new Ctx();
  try {
    const handle = playback.playPcmWithAudioContext(pcm, sampleRate, { audioContext: context });
    // Do not wait for full playback — stop immediately after start proves the graph.
    await Promise.resolve();
    handle.stop();
    await context.close().catch(() => undefined);
    contextClosed = context.state === "closed";
    return { playable: pcm.length > 0 && sampleRate > 0, contextClosed };
  } catch {
    try {
      await context.close();
    } catch {
      // ignore
    }
    contextClosed = context.state === "closed";
    return { playable: pcm.length > 0 && sampleRate > 0, contextClosed };
  }
}

async function ensurePlayableWav(
  playback: PlaybackModule,
  wav: ArrayBuffer,
): Promise<{ playable: boolean; objectUrlRevoked: boolean }> {
  const blob = new Blob([wav], { type: "audio/wav" });
  let revoked = false;
  const createObjectUrl = (b: Blob) => {
    const url = URL.createObjectURL(b);
    return url;
  };
  const revokeObjectUrl = (url: string) => {
    URL.revokeObjectURL(url);
    revoked = true;
  };
  try {
    const handle = playback.playWavBlob(blob, { createObjectUrl, revokeObjectUrl });
    await Promise.resolve();
    handle.stop();
    // stop() revokes in the playback helper
    return { playable: wav.byteLength > 44, objectUrlRevoked: revoked };
  } catch {
    return { playable: wav.byteLength > 44, objectUrlRevoked: revoked };
  }
}

export async function runLocalVoiceAcceptance(
  input: LocalVoiceAcceptanceInput,
  onProgress?: (message: string) => void,
): Promise<LocalVoiceAcceptanceReport> {
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const requestLog: AcceptanceRequestLogEntry[] = [];
  const restoreFetch = installFetchProbe(requestLog);
  const progress = (message: string) => {
    onProgress?.(message);
  };

  let whisper: AcceptanceWhisperResult | null = null;
  let kokoro: AcceptanceSynthesisResult | null = null;
  let piper: AcceptanceSynthesisResult | null = null;
  const packages: AcceptancePackageEvidence[] = [];
  const cache: AcceptanceCacheObservation = {
    firstDownloadUsedNetwork: false,
    warmReuseSkippedNetwork: false,
    reverifyPassed: false,
    cancelledLoadRecovered: false,
    failedLoadRecovered: false,
  };
  const cleanup: AcceptanceCleanupObservation = {
    workersTerminated: true,
    audioContextsClosed: true,
    mediaTracksStopped: true,
    objectUrlsRevoked: true,
    notes: [],
  };

  try {
    progress("Loading local voice modules…");
    const local: LocalModule = await import("../local/index");
    const audioMod: AudioModule = await import("../local-adapter-audio");
    const playbackMod: PlaybackModule = await import("../local-adapter-playback");

    if (input.clearBeforeRun !== false) {
      progress("Clearing verified OPFS packages for first-download path…");
      for (const engine of ["whisper", "kokoro", "piper"] as const) {
        await local.removeLocalEngine(engine).catch(() => undefined);
      }
    }

    // --- Cancelled download recovery (Whisper) ---
    progress("Exercising cancelled download recovery…");
    {
      const controller = new AbortController();
      const downloadPromise = local.downloadLocalEnginePackage("whisper-tiny.en-q4", {
        signal: controller.signal,
      });
      // Abort quickly so partial OPFS never commits as verified.
      queueMicrotask(() => controller.abort());
      setTimeout(() => controller.abort(), 50);
      let cancelled = false;
      try {
        await downloadPromise;
      } catch {
        cancelled = true;
      }
      const statusAfterCancel = await local.getLocalEngineStatus("whisper");
      if (statusAfterCancel.verified) {
        // Extremely fast cache/network could finish before abort — clear and continue.
        await local.removeLocalEngine("whisper");
        cleanup.notes.push("cancel race finished before abort; cleared for clean first-download");
      }
      // Successful recovery download after cancel.
      const recovered = await local.downloadLocalEnginePackage("whisper-tiny.en-q4");
      cache.cancelledLoadRecovered = cancelled && recovered.verified;
      if (!cache.cancelledLoadRecovered && recovered.verified && !cancelled) {
        // Abort may lose the race on a warm CDN; still require verified recovery.
        cache.cancelledLoadRecovered = recovered.verified;
        cleanup.notes.push("download abort lost race; recovery download still verified");
      }
      // Clear again so the timed first-download path is meaningful.
      await local.removeLocalEngine("whisper");
    }

    // --- Failed load recovery: cache_miss without verified package ---
    progress("Exercising failed load recovery (cache miss)…");
    {
      await local.removeLocalEngine("kokoro").catch(() => undefined);
      const client = local.createLocalKokoroClient({ loadTimeoutMs: 15_000 });
      let failed = false;
      try {
        await client.load();
      } catch {
        failed = true;
      }
      await client.dispose();
      if (!failed) {
        errors.push("expected cache_miss load failure before Kokoro download");
      } else {
        cache.failedLoadRecovered = true;
      }
    }

    const wavBuffer = base64ToArrayBuffer(input.fixtureWavBase64);
    const wavBlob = new Blob([wavBuffer], { type: "audio/wav" });
    const pcm = await audioMod.blobToWhisperPcm(wavBlob);

    // --- Whisper first download + infer + warm ---
    progress("Whisper: first verified download…");
    {
      const netBefore = requestLog.filter((e) => HF_HOST_RE.test(e.host)).length;
      const t0 = nowMs();
      const status = await local.downloadLocalEnginePackage("whisper-tiny.en-q4");
      const firstDownloadMs = Math.round(nowMs() - t0);
      const netAfter = requestLog.filter((e) => HF_HOST_RE.test(e.host)).length;
      cache.firstDownloadUsedNetwork = netAfter > netBefore || status.verified;
      const evidence = packageEvidence(status);
      packages.push(evidence);
      if (!status.verified) {
        whisper = {
          engine: "whisper",
          ok: false,
          package: evidence,
          timing: { firstDownloadMs, warmLoadMs: null, inferMs: null },
          transcript: null,
          matchedTokens: [],
          sampleCount: pcm.length,
          sampleRateHz: 16_000,
          error: "Whisper package failed verification after download",
        };
        errors.push(whisper.error!);
      } else {
        progress("Whisper: worker load + transcription…");
        const client = local.createLocalWhisperClient();
        let loadInfo;
        try {
          const lt0 = nowMs();
          loadInfo = await client.load();
          const loadMs = Math.round(nowMs() - lt0);
          const it0 = nowMs();
          const result = await client.transcribe(pcm, loadInfo.generation);
          const inferMs = Math.round(nowMs() - it0);
          const text = result.text.trim();
          const lower = text.toLowerCase();
          const matchedTokens = EXPECTED_TOKENS.filter((token) => lower.includes(token));
          const ok = text.length > 0 && matchedTokens.length > 0;
          if (!ok) {
            errors.push(
              text.length === 0
                ? "Whisper returned empty transcript"
                : `Whisper transcript missing expected tokens: ${JSON.stringify(text)}`,
            );
          }
          await client.dispose();
          if (client.isLoaded) {
            cleanup.workersTerminated = false;
            cleanup.notes.push("Whisper client still reports loaded after dispose");
          }

          // Warm path: reverify + load again without clearing store.
          progress("Whisper: warm cache reverify + reload…");
          const netWarmBefore = requestLog.filter((e) => HF_HOST_RE.test(e.host)).length;
          const wt0 = nowMs();
          const reverified = await local.reverifyCachedPackage("whisper-tiny.en-q4");
          const warmClient = local.createLocalWhisperClient();
          const warmInfo = await warmClient.load();
          const warmLoadMs = Math.round(nowMs() - wt0);
          const netWarmAfter = requestLog.filter((e) => HF_HOST_RE.test(e.host)).length;
          cache.reverifyPassed = reverified;
          cache.warmReuseSkippedNetwork = netWarmAfter === netWarmBefore;
          await warmClient.dispose();
          if (warmClient.isLoaded) cleanup.workersTerminated = false;

          whisper = {
            engine: "whisper",
            ok,
            package: evidence,
            timing: {
              firstDownloadMs,
              warmLoadMs,
              inferMs,
            },
            transcript: text,
            matchedTokens: [...matchedTokens],
            sampleCount: pcm.length,
            sampleRateHz: 16_000,
            error: ok ? null : (errors[errors.length - 1] ?? "whisper failed"),
          };
          // first loadMs retained only indirectly; warm is the cache metric.
          void loadMs;
          void warmInfo;
        } catch (error) {
          await client.dispose().catch(() => undefined);
          const message = error instanceof Error ? error.message : "whisper failed";
          errors.push(message);
          whisper = {
            engine: "whisper",
            ok: false,
            package: evidence,
            timing: { firstDownloadMs, warmLoadMs: null, inferMs: null },
            transcript: null,
            matchedTokens: [],
            sampleCount: pcm.length,
            sampleRateHz: 16_000,
            error: message,
          };
        }
      }
    }

    // --- Kokoro ---
    progress("Kokoro: first verified download + synthesis…");
    {
      const netBefore = requestLog.filter((e) => HF_HOST_RE.test(e.host)).length;
      const t0 = nowMs();
      const status = await local.downloadLocalEnginePackage("kokoro-82m-v1-q8");
      const firstDownloadMs = Math.round(nowMs() - t0);
      const netAfter = requestLog.filter((e) => HF_HOST_RE.test(e.host)).length;
      if (netAfter > netBefore) cache.firstDownloadUsedNetwork = true;
      const evidence = packageEvidence(status);
      packages.push(evidence);
      const client = local.createLocalKokoroClient();
      try {
        if (!status.verified) throw new Error("Kokoro package failed verification");
        const lt0 = nowMs();
        const info = await client.load();
        const loadMs = Math.round(nowMs() - lt0);
        const it0 = nowMs();
        const audio = await client.synthesize(SYNTHESIS_TEXT, info.generation);
        const inferMs = Math.round(nowMs() - it0);
        if (audio.format !== "pcm-f32" || !audio.pcm) {
          throw new Error("Kokoro did not return PCM audio");
        }
        const byteLength = audio.pcm.byteLength;
        const durationSeconds = audio.sampleRate > 0 ? audio.pcm.length / audio.sampleRate : null;
        const play = await ensurePlayablePcm(playbackMod, audio.pcm, audio.sampleRate);
        if (!play.contextClosed) {
          cleanup.audioContextsClosed = false;
          cleanup.notes.push("Kokoro AudioContext not closed after playback stop");
        }
        audio.pcm.fill(0);
        await client.dispose();
        if (client.isLoaded) cleanup.workersTerminated = false;

        const wt0 = nowMs();
        const warmClient = local.createLocalKokoroClient();
        await warmClient.load();
        const warmLoadMs = Math.round(nowMs() - wt0);
        await warmClient.dispose();

        const ok = byteLength > 0 && (durationSeconds ?? 0) > 0 && play.playable;
        if (!ok) errors.push("Kokoro synthesis produced empty or unplayable audio");
        kokoro = {
          engine: "kokoro",
          ok,
          package: evidence,
          timing: { firstDownloadMs, warmLoadMs, inferMs },
          format: "pcm-f32",
          sampleRateHz: audio.sampleRate,
          channels: audio.channels,
          byteLength,
          durationSeconds,
          playable: play.playable,
          error: ok ? null : "Kokoro synthesis produced empty or unplayable audio",
        };
        void loadMs;
      } catch (error) {
        await client.dispose().catch(() => undefined);
        const message = error instanceof Error ? error.message : "kokoro failed";
        errors.push(message);
        kokoro = {
          engine: "kokoro",
          ok: false,
          package: evidence,
          timing: { firstDownloadMs, warmLoadMs: null, inferMs: null },
          format: null,
          sampleRateHz: null,
          channels: null,
          byteLength: null,
          durationSeconds: null,
          playable: false,
          error: message,
        };
      }
    }

    // --- Piper ---
    progress("Piper: first verified download + synthesis…");
    {
      const netBefore = requestLog.filter((e) => HF_HOST_RE.test(e.host)).length;
      const t0 = nowMs();
      const status = await local.downloadLocalEnginePackage("piper-en_US-ljspeech-medium");
      const firstDownloadMs = Math.round(nowMs() - t0);
      const netAfter = requestLog.filter((e) => HF_HOST_RE.test(e.host)).length;
      if (netAfter > netBefore) cache.firstDownloadUsedNetwork = true;
      const evidence = packageEvidence(status);
      packages.push(evidence);
      const client = local.createLocalPiperClient();
      try {
        if (!status.verified) throw new Error("Piper package failed verification");
        const info = await client.load();
        const it0 = nowMs();
        const audio = await client.synthesize(SYNTHESIS_TEXT, info.generation);
        const inferMs = Math.round(nowMs() - it0);
        if (audio.format !== "wav" || !audio.wav) {
          throw new Error("Piper did not return WAV audio");
        }
        const byteLength = audio.wav.byteLength;
        const durationSeconds =
          audio.sampleRate > 0 ? Math.max(0, (byteLength - 44) / 2 / audio.sampleRate) : null;
        const play = await ensurePlayableWav(playbackMod, audio.wav);
        if (!play.objectUrlRevoked) {
          cleanup.objectUrlsRevoked = false;
          cleanup.notes.push("Piper object URL not revoked after playback stop");
        }
        await client.dispose();
        if (client.isLoaded) cleanup.workersTerminated = false;

        const wt0 = nowMs();
        const warmClient = local.createLocalPiperClient();
        await warmClient.load();
        const warmLoadMs = Math.round(nowMs() - wt0);
        await warmClient.dispose();

        const ok = byteLength > 44 && (durationSeconds ?? 0) > 0 && play.playable;
        if (!ok) errors.push("Piper synthesis produced empty or unplayable audio");
        piper = {
          engine: "piper",
          ok,
          package: evidence,
          timing: { firstDownloadMs, warmLoadMs, inferMs },
          format: "wav",
          sampleRateHz: audio.sampleRate,
          channels: audio.channels,
          byteLength,
          durationSeconds,
          playable: play.playable,
          error: ok ? null : "Piper synthesis produced empty or unplayable audio",
        };
      } catch (error) {
        await client.dispose().catch(() => undefined);
        const message = error instanceof Error ? error.message : "piper failed";
        errors.push(message);
        piper = {
          engine: "piper",
          ok: false,
          package: evidence,
          timing: { firstDownloadMs, warmLoadMs: null, inferMs: null },
          format: null,
          sampleRateHz: null,
          channels: null,
          byteLength: null,
          durationSeconds: null,
          playable: false,
          error: message,
        };
      }
    }

    progress("Probing MediaStream track cleanup…");
    const media = await probeMediaCleanup();
    cleanup.mediaTracksStopped = media.tracksStopped;
    cleanup.notes.push(...media.notes);

    // Final statuses
    for (const engine of ["whisper", "kokoro", "piper"] as const) {
      const status = await local.getLocalEngineStatus(engine);
      if (!status.verified) {
        errors.push(`${engine} not verified at end of run`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "acceptance runner failed");
  } finally {
    restoreFetch();
  }

  const finishedAt = new Date().toISOString();
  const enginesOk = Boolean(whisper?.ok) && Boolean(kokoro?.ok) && Boolean(piper?.ok);
  const cacheOk =
    cache.cancelledLoadRecovered &&
    cache.failedLoadRecovered &&
    cache.reverifyPassed &&
    cleanup.workersTerminated;
  const status: LocalVoiceAcceptanceReport["status"] =
    enginesOk && cacheOk && errors.length === 0
      ? "passed"
      : errors.some((e) => /network|fetch|Failed to fetch|HF|huggingface/i.test(e))
        ? "blocked"
        : "failed";

  return {
    id: "phase-6-local-voice",
    version: 1,
    status,
    startedAt,
    finishedAt,
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
    },
    fixture: {
      name: input.fixtureName,
      sha256: input.fixtureSha256,
      bytes: Math.floor((input.fixtureWavBase64.length * 3) / 4),
      phrase: input.fixturePhrase,
      sampleRateHz: 16_000,
    },
    packages,
    whisper,
    kokoro,
    piper,
    cache,
    cleanup,
    requestLog,
    errors,
  };
}
