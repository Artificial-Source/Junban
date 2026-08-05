/**
 * Phase 6 release-browser lazy chunk / network assertion.
 *
 * Ordinary boot must not *fetch* AI, voice, local-model, or model-origin
 * resources. AI/Voice surface chunks appear only after opening those surfaces.
 * Engine/model origins appear only after explicit local-model consent (not exercised
 * here — see opt-in acceptance-phase-6-local-voice).
 *
 * Safe for ordinary CI: no model downloads.
 *
 * Note: the main index may contain string references to lazy chunk filenames
 * (Vite import map). That is not a fetch. This suite asserts request URLs and
 * model origins, not the absence of lazy-name strings inside index.js.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import { appUrlWithToken, startServer, type ServerContext } from "./fixtures";

let server: ServerContext;

const MODEL_HOST_RE = /(^|\.)huggingface\.co$|(^|\.)hf\.co$/i;

/** Path/filename markers that must not be fetched on ordinary boot. */
const BOOT_FORBIDDEN_FETCH_RE =
  /LocalVoiceAcceptanceRoot|runLocalVoiceAcceptance|Phase6VisualRoot|AIChatRoute|AiTab-|VoiceTab-|load-whisper|load-kokoro|load-piper|load-vad|local-adapters|transformers\.web|\/kokoro-|piper-tts-web|piper-o91|ort\.bundle|vad\.worklet|voices_static/i;

/** Engine runtime markers that must not appear in scripts that *were* fetched on boot. */
const BOOT_SCRIPT_FORBIDDEN = [
  "whisper-tiny.en",
  "Kokoro-82M",
  "piper_phonemize",
  "silero_vad",
  "@huggingface/transformers",
  "kokoro-js",
  "@mintplex-labs/piper-tts-web",
  "@ricky0123/vad-web",
  "onnxruntime-node",
  "junban-whisper",
  "junban-kokoro",
  "junban-piper",
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isModelOrigin(url: string): boolean {
  return MODEL_HOST_RE.test(hostOf(url));
}

function assetName(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

async function readSameOriginScriptTexts(
  page: Page,
  origin: string,
  requests: string[],
): Promise<Array<{ url: string; text: string }>> {
  const scriptUrls = [
    ...new Set(
      requests.filter(
        (url) =>
          url.startsWith(origin) &&
          (url.endsWith(".js") || url.includes("/assets/") || url.includes(".mjs")),
      ),
    ),
  ];
  const out: Array<{ url: string; text: string }> = [];
  for (const url of scriptUrls) {
    try {
      const response = await page.request.get(url);
      if (!response.ok()) continue;
      const text = await response.text();
      if (text.includes("\0") || text.length > 8_000_000) continue;
      out.push({ url, text });
    } catch {
      // ignore
    }
  }
  return out;
}

function collectRequests(page: Page) {
  const requests: Array<{ url: string; resourceType: string }> = [];
  const onRequest = (req: Request) => {
    requests.push({ url: req.url(), resourceType: req.resourceType() });
  };
  page.on("request", onRequest);
  return {
    requests,
    stop: () => page.off("request", onRequest),
    urls: () => requests.map((r) => r.url),
  };
}

test.beforeAll(async () => {
  server = await startServer({ seed: false });
});

test.afterAll(async () => {
  await server.cleanup();
});

test("ordinary / initial load fetches no AI/voice/local-model chunks or model origins", async ({
  page,
}) => {
  const origin = server.baseUrl;
  const probe = collectRequests(page);

  await page.goto(appUrlWithToken(origin, server.token, "/today"), { waitUntil: "load" });
  await page.waitForSelector("h1", { timeout: 30_000 });
  // SSE stays open — do not wait for networkidle.
  await page.waitForTimeout(1_000);
  probe.stop();

  const modelHits = probe.urls().filter((url) => isModelOrigin(url));
  expect(modelHits, `model origins on boot: ${modelHits.join(", ")}`).toEqual([]);

  for (const url of probe.urls()) {
    if (url.startsWith("data:") || url.startsWith("blob:")) continue;
    expect(url.startsWith(origin), `external boot request: ${url}`).toBe(true);
    expect(assetName(url), `forbidden boot fetch: ${url}`).not.toMatch(BOOT_FORBIDDEN_FETCH_RE);
  }

  const scripts = await readSameOriginScriptTexts(page, origin, probe.urls());
  expect(scripts.length).toBeGreaterThan(0);

  // Only inspect fetched scripts other than the main index for engine markers.
  // Index may hold lazy chunk *names* without loading those modules.
  for (const script of scripts) {
    const path = assetName(script.url);
    if (/\/assets\/index-/.test(path)) continue;
    for (const marker of BOOT_SCRIPT_FORBIDDEN) {
      expect(script.text, `${script.url} contains ${marker}`).not.toContain(marker);
    }
  }

  expect(await page.getByTestId("local-voice-acceptance-root").count()).toBe(0);
  expect(
    await page.evaluate(() => document.documentElement.dataset.localVoiceAcceptance ?? ""),
  ).toBe("");
});

test("AI and Voice settings chunks appear only after opening those surfaces", async ({ page }) => {
  const origin = server.baseUrl;

  const boot = collectRequests(page);
  await page.goto(appUrlWithToken(origin, server.token, "/today"), { waitUntil: "load" });
  await page.waitForSelector("h1", { timeout: 30_000 });
  await page.waitForTimeout(1_000);
  boot.stop();
  const bootSet = new Set(boot.urls());

  // Open Settings → AI
  const ai = collectRequests(page);
  await page.goto(appUrlWithToken(origin, server.token, "/settings/ai"), { waitUntil: "load" });
  await expect(page.getByTestId("ai-settings-tab")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
  ai.stop();

  expect(ai.urls().filter((u) => isModelOrigin(u))).toEqual([]);
  const aiNew = ai.urls().filter((u) => !bootSet.has(u));
  expect(
    aiNew.some((u) => /AiTab-|useAiConfigController|AIChatRoute/i.test(assetName(u))),
    `expected AI settings chunk among: ${aiNew.map(assetName).join(", ")}`,
  ).toBe(true);
  expect(
    aiNew.some(
      (u) =>
        BOOT_FORBIDDEN_FETCH_RE.test(assetName(u)) &&
        /load-whisper|transformers|kokoro-|piper/i.test(u),
    ),
  ).toBe(false);

  // Open Settings → Voice
  const voice = collectRequests(page);
  await page.goto(appUrlWithToken(origin, server.token, "/settings/voice"), {
    waitUntil: "load",
  });
  await expect(page.getByTestId("voice-settings-tab")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
  voice.stop();

  expect(voice.urls().filter((u) => isModelOrigin(u))).toEqual([]);
  const voiceNew = voice.urls().filter((u) => !bootSet.has(u) && !ai.urls().includes(u));
  expect(
    voiceNew.some((u) => /VoiceTab-|local-|manifest-/i.test(assetName(u))),
    `expected Voice settings chunk among: ${voiceNew.map(assetName).join(", ")}`,
  ).toBe(true);

  await expect(page.getByTestId("local-model-card-whisper-tiny.en-q4")).toBeVisible();
  await expect(page.getByTestId("local-model-card-kokoro-82m-v1-q8")).toBeVisible();
  await expect(page.getByTestId("local-model-card-piper-en_US-ljspeech-medium")).toBeVisible();

  // No worker construction / engine package fetch until consent Load.
  const workerFetches = voice.requests.filter(
    (r) =>
      r.resourceType === "worker" || /whisper\.worker|kokoro\.worker|piper\.worker/i.test(r.url),
  );
  expect(workerFetches, JSON.stringify(workerFetches)).toEqual([]);
  expect(
    voice
      .urls()
      .some((u) =>
        /transformers\.web|\/kokoro-|piper-tts-web|load-whisper|load-kokoro|load-piper/i.test(u),
      ),
  ).toBe(false);
});

test("acceptance query is inert without exact allowlist value and does not load engines", async ({
  page,
}) => {
  const origin = server.baseUrl;
  const probe = collectRequests(page);

  await page.goto(appUrlWithToken(origin, server.token, "/today?acceptance=1"), {
    waitUntil: "load",
  });
  await page.waitForSelector("h1", { timeout: 30_000 });
  await page.waitForTimeout(500);
  probe.stop();

  expect(await page.getByTestId("local-voice-acceptance-root").count()).toBe(0);
  expect(probe.urls().filter((u) => isModelOrigin(u))).toEqual([]);
  expect(probe.urls().some((u) => /LocalVoiceAcceptance|runLocalVoiceAcceptance/i.test(u))).toBe(
    false,
  );
});

test("exact acceptance query mounts only the allowlisted lazy seam", async ({ page }) => {
  const origin = server.baseUrl;
  const probe = collectRequests(page);

  await page.goto(appUrlWithToken(origin, server.token, "/?acceptance=phase-6-local-voice"), {
    waitUntil: "load",
  });
  await expect(page.getByTestId("local-voice-acceptance-root")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500);
  probe.stop();

  // Seam chunk is allowed; models and engine packages are not until Run.
  expect(probe.urls().some((u) => /LocalVoiceAcceptanceRoot/i.test(u))).toBe(true);
  expect(probe.urls().filter((u) => isModelOrigin(u))).toEqual([]);
  expect(
    probe.urls().some((u) => /transformers\.web|\/kokoro-|piper-tts-web|load-whisper/i.test(u)),
  ).toBe(false);
  await expect(page.getByTestId("local-voice-acceptance-run")).toBeVisible();
});
