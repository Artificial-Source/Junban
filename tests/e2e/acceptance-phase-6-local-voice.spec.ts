/**
 * Phase 6 Wave 5 opt-in real-browser local-voice acceptance.
 *
 * NOT part of ordinary CI. Run via:
 *   JUNBAN_LOCAL_VOICE_ACCEPTANCE=1 pnpm test:e2e:local-voice-acceptance
 *
 * Requires: pnpm build, cargo build --release -p junban-server, network to
 * Hugging Face for first-download (weights are not in git), Chromium.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { appUrlWithToken, startServer, type ServerContext } from "./fixtures";

const ENABLED = process.env.JUNBAN_LOCAL_VOICE_ACCEPTANCE === "1";
const FIXTURE_REL = "tests/acceptance/fixtures/whisper-plan-my-day-16k.wav";
const FIXTURE_SHA256 = "09d36ecbb7c00737df3eb862321c312948a0741ad29aa32085685deb1ca96aa3";
const FIXTURE_PHRASE = "plan my day";
const EVIDENCE_PATH = join(
  process.cwd(),
  "goals/rust-rewrite/evidence/phase-6-wave-5-local-voice-acceptance.json",
);
const BLOCKER_PATH = join(
  process.cwd(),
  "goals/rust-rewrite/evidence/phase-6-wave-5-local-voice-acceptance-blocker.json",
);

test.describe.configure({ mode: "serial" });

test.skip(!ENABLED, "Set JUNBAN_LOCAL_VOICE_ACCEPTANCE=1 to run real local-voice acceptance");

let server: ServerContext;

test.beforeAll(async () => {
  server = await startServer({ seed: false });
});

test.afterAll(async () => {
  await server.cleanup();
});

function loadFixture() {
  const abs = join(process.cwd(), FIXTURE_REL);
  if (!existsSync(abs)) {
    throw new Error(`Missing spoken fixture at ${FIXTURE_REL}`);
  }
  const buf = readFileSync(abs);
  const sha = createHash("sha256").update(buf).digest("hex");
  if (sha !== FIXTURE_SHA256) {
    throw new Error(`Fixture SHA-256 mismatch: ${sha}`);
  }
  return {
    base64: buf.toString("base64"),
    sha256: sha,
    bytes: buf.byteLength,
    name: "whisper-plan-my-day-16k.wav",
    phrase: FIXTURE_PHRASE,
  };
}

function writeEvidence(report: unknown, path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

test("settings voice consent download path admits one verified package", async ({ page }) => {
  // Prove the real Settings UI consent Load path for Whisper before the full runner.
  // Full three-engine inference remains on the acceptance surface (same download APIs).
  test.setTimeout(20 * 60_000);

  const requests: string[] = [];
  page.on("request", (req) => requests.push(req.url()));

  await page.goto(appUrlWithToken(server.baseUrl, server.token, "/settings/voice"), {
    waitUntil: "load",
  });
  await expect(page.getByTestId("voice-settings-tab")).toBeVisible({ timeout: 60_000 });
  const card = page.getByTestId("local-model-card-whisper-tiny.en-q4");
  await expect(card).toBeVisible();

  // If already ready from a prior partial run, remove first for first-download signal.
  const removeBtn = card.getByRole("button", { name: /Remove /i });
  if (await removeBtn.isVisible().catch(() => false)) {
    await removeBtn.click();
    const confirm = card.getByRole("button", { name: /^Remove$/ });
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
    }
    await expect(card.getByRole("button", { name: /Load /i })).toBeVisible({ timeout: 60_000 });
  }

  const consent = card.locator('input[type="checkbox"]');
  await consent.check();
  const loadBtn = card.getByRole("button", { name: /Load /i });
  await expect(loadBtn).toBeEnabled();
  await loadBtn.click();

  await expect(card.getByText("Ready", { exact: true })).toBeVisible({ timeout: 15 * 60_000 });
  const usedHf = requests.some((u) => {
    try {
      return /(^|\.)huggingface\.co$|(^|\.)hf\.co$/i.test(new URL(u).hostname);
    } catch {
      return false;
    }
  });
  expect(usedHf).toBe(true);
});

test("real Chromium hash-verified Whisper/Kokoro/Piper inference acceptance", async ({
  browser,
}) => {
  test.setTimeout(45 * 60_000);

  const fixture = loadFixture();
  const requestLog: Array<{ url: string; method: string; resourceType: string }> = [];

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // Fake media for cleanup probe without a physical mic.
    permissions: ["microphone"],
  });
  await context.grantPermissions(["microphone"], { origin: server.baseUrl });

  const page = await context.newPage();
  page.on("request", (req) => {
    requestLog.push({
      url: req.url().split("?")[0] ?? req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
    });
  });

  // Chromium launch args for fake device come from the project config.
  const path = `/?acceptance=phase-6-local-voice`;
  await page.goto(appUrlWithToken(server.baseUrl, server.token, path), {
    waitUntil: "load",
  });
  await expect(page.getByTestId("local-voice-acceptance-root")).toBeVisible({
    timeout: 60_000,
  });

  await page.evaluate(
    ({ base64, sha256, name, phrase }) => {
      window.__junbanLocalVoiceAcceptanceInput = {
        fixtureWavBase64: base64,
        fixtureSha256: sha256,
        fixtureName: name,
        fixturePhrase: phrase,
        clearBeforeRun: true,
      };
    },
    {
      base64: fixture.base64,
      sha256: fixture.sha256,
      name: fixture.name,
      phrase: fixture.phrase,
    },
  );

  let report: Record<string, unknown>;
  try {
    report = await page.evaluate(async () => {
      const run = window.__junbanLocalVoiceAcceptanceRun;
      if (!run) throw new Error("acceptance run bridge missing");
      return (await run()) as unknown as Record<string, unknown>;
    });
  } catch (error) {
    const blocker = {
      id: "phase-6-local-voice",
      version: 1,
      status: "blocked",
      reason: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
      browser: await page.evaluate(() => navigator.userAgent),
      fixture: {
        name: fixture.name,
        sha256: fixture.sha256,
        bytes: fixture.bytes,
        phrase: fixture.phrase,
      },
      requestHosts: [
        ...new Set(
          requestLog.map((r) => {
            try {
              return new URL(r.url).hostname;
            } catch {
              return "";
            }
          }),
        ),
      ].filter(Boolean),
      note: "Executable harness ran but did not complete acceptance. Do not claim pass.",
    };
    writeEvidence(blocker, BLOCKER_PATH);
    await context.close();
    throw error;
  }

  // Merge Playwright-level request log hosts into the report for evidence.
  const enriched = {
    ...report,
    playwright: {
      browser: "chromium",
      requestCount: requestLog.length,
      requestHosts: [
        ...new Set(
          requestLog.map((r) => {
            try {
              return new URL(r.url).hostname;
            } catch {
              return "";
            }
          }),
        ),
      ].filter(Boolean),
      runId: randomUUID(),
    },
  };

  writeEvidence(enriched, EVIDENCE_PATH);

  await context.close();

  expect(enriched.status, JSON.stringify(enriched.errors ?? enriched, null, 2)).toBe("passed");

  const whisper = enriched.whisper as {
    ok: boolean;
    transcript: string;
    matchedTokens: string[];
    package: { revision: string; primarySha256: string; totalBytes: number };
    timing: { firstDownloadMs: number; warmLoadMs: number; inferMs: number };
  };
  const kokoro = enriched.kokoro as {
    ok: boolean;
    byteLength: number;
    durationSeconds: number;
    playable: boolean;
    package: { revision: string; primarySha256: string; totalBytes: number };
  };
  const piper = enriched.piper as {
    ok: boolean;
    byteLength: number;
    durationSeconds: number;
    playable: boolean;
    package: { revision: string; primarySha256: string; totalBytes: number };
  };

  expect(whisper.ok).toBe(true);
  expect(whisper.transcript.length).toBeGreaterThan(0);
  expect(whisper.matchedTokens.length).toBeGreaterThan(0);
  expect(whisper.package.revision).toMatch(/^[a-f0-9]{40}$/);
  expect(whisper.timing.inferMs).toBeGreaterThan(0);

  expect(kokoro.ok).toBe(true);
  expect(kokoro.byteLength).toBeGreaterThan(0);
  expect(kokoro.durationSeconds).toBeGreaterThan(0);
  expect(kokoro.playable).toBe(true);

  expect(piper.ok).toBe(true);
  expect(piper.byteLength).toBeGreaterThan(44);
  expect(piper.durationSeconds).toBeGreaterThan(0);
  expect(piper.playable).toBe(true);

  const cache = enriched.cache as {
    reverifyPassed: boolean;
    cancelledLoadRecovered: boolean;
    failedLoadRecovered: boolean;
  };
  expect(cache.reverifyPassed).toBe(true);
  expect(cache.cancelledLoadRecovered).toBe(true);
  expect(cache.failedLoadRecovered).toBe(true);

  const cleanup = enriched.cleanup as {
    workersTerminated: boolean;
    mediaTracksStopped: boolean;
  };
  expect(cleanup.workersTerminated).toBe(true);
  expect(cleanup.mediaTracksStopped).toBe(true);
});
