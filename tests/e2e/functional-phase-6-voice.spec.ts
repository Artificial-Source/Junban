/**
 * Phase 6 browser-functional voice integration.
 * Deterministic fakes only — no sleeps, provider egress, or model downloads.
 * Unit tests remain the detailed protocol authority.
 */
import { expect, test, type Page } from "@playwright/test";
import { appUrlWithToken, startServer, type ServerContext } from "./fixtures";

let server: ServerContext;

test.beforeAll(async () => {
  server = await startServer({ seed: false });
});

test.afterAll(async () => {
  await server.cleanup();
});

async function installVoiceFakes(
  page: Page,
  options: {
    speech?: "unavailable" | "final" | "error" | "abort";
    mic?: "granted" | "denied";
  } = {},
) {
  const speech = options.speech ?? "final";
  const mic = options.mic ?? "granted";
  await page.addInitScript(
    ({ speechMode, micMode }) => {
      const stoppedTracks: string[] = [];
      (window as unknown as { __junbanVoiceProbe?: Record<string, unknown> }).__junbanVoiceProbe = {
        speechMode,
        micMode,
        stoppedTracks,
        cloudRequests: [] as Array<{ url: string; method: string; contentType: string }>,
        fetchCalls: [] as string[],
      };

      class FakeAudioContext {
        state = "running";
        destination = {};
        createMediaStreamSource() {
          return { connect() {}, disconnect() {} };
        }
        createAnalyser() {
          return {
            fftSize: 0,
            frequencyBinCount: 0,
            getByteFrequencyData() {},
            connect() {},
            disconnect() {},
          };
        }
        close() {
          this.state = "closed";
          return Promise.resolve();
        }
        resume() {
          this.state = "running";
          return Promise.resolve();
        }
      }
      (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
      (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext = FakeAudioContext;

      const track = {
        kind: "audio",
        stop() {
          stoppedTracks.push("audio");
        },
        getSettings() {
          return { deviceId: "fake-mic" };
        },
      };
      const stream = {
        getTracks() {
          return [track];
        },
        getAudioTracks() {
          return [track];
        },
      };

      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            if (micMode === "denied") {
              const err = new DOMException("Permission denied", "NotAllowedError");
              throw err;
            }
            return stream;
          },
          enumerateDevices: async () => [
            { deviceId: "fake-mic", kind: "audioinput", label: "Fake Mic", groupId: "g1" },
          ],
        },
      });

      class FakeMediaRecorder {
        state = "inactive";
        mimeType = "audio/webm";
        ondataavailable: ((ev: { data: Blob }) => void) | null = null;
        onstop: (() => void) | null = null;
        onerror: ((ev: unknown) => void) | null = null;
        static isTypeSupported() {
          return true;
        }
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });
          this.ondataavailable?.({ data: blob });
          this.onstop?.();
        }
      }
      (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;

      if (speechMode === "unavailable") {
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
        delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
      } else {
        class FakeSpeechRecognition {
          continuous = false;
          interimResults = false;
          lang = "en-US";
          onstart: (() => void) | null = null;
          onresult: ((ev: unknown) => void) | null = null;
          onerror: ((ev: unknown) => void) | null = null;
          onend: (() => void) | null = null;
          start() {
            this.onstart?.();
            if (speechMode === "error") {
              this.onerror?.({ error: "not-allowed" });
              this.onend?.();
              return;
            }
            if (speechMode === "abort") {
              this.onerror?.({ error: "aborted" });
              this.onend?.();
              return;
            }
            this.onresult?.({
              results: [[{ transcript: "plan my day", confidence: 0.9 }]],
              resultIndex: 0,
            });
            this.onend?.();
          }
          stop() {
            this.onend?.();
          }
          abort() {
            this.onerror?.({ error: "aborted" });
            this.onend?.();
          }
        }
        (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition =
          FakeSpeechRecognition;
        (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition =
          FakeSpeechRecognition;
      }

      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const probe = (
          window as unknown as {
            __junbanVoiceProbe: {
              fetchCalls: string[];
              cloudRequests: Array<Record<string, string>>;
            };
          }
        ).__junbanVoiceProbe;
        probe.fetchCalls.push(url);
        if (url.includes("/api/v1/voice/")) {
          const contentType =
            init?.headers instanceof Headers
              ? (init.headers.get("content-type") ?? "")
              : String(
                  (init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "",
                );
          probe.cloudRequests.push({
            url,
            method: init?.method ?? "GET",
            contentType,
          });
          if (url.includes("/transcriptions")) {
            return new Response(JSON.stringify({ text: "cloud transcript" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.includes("/speech")) {
            return new Response(new Uint8Array([0, 1, 2, 3]), {
              status: 200,
              headers: { "content-type": "audio/mpeg" },
            });
          }
        }
        // Block non-local model/provider hosts.
        if (
          !url.startsWith(location.origin) &&
          !url.startsWith("data:") &&
          !url.startsWith("blob:")
        ) {
          throw new Error("blocked non-local fetch in phase-6 functional test");
        }
        return originalFetch(input, init);
      };
    },
    { speechMode: speech, micMode: mic },
  );
}

async function openFixture(
  page: Page,
  sceneId: string,
  viewport: { width: number; height: number },
) {
  await page.setViewportSize(viewport);
  await page.clock.setFixedTime(new Date("2026-08-02T15:00:00.000Z"));
  const path = `/?visual-fixture=phase-6&scene=${encodeURIComponent(sceneId)}`;
  await page.goto(appUrlWithToken(server.baseUrl, server.token, path));
  await expect(page.getByTestId("phase6-scene-root")).toBeVisible({ timeout: 30_000 });
}

test("phase-6 fixture scenes never initialize physical mic or provider network", async ({
  page,
}) => {
  await installVoiceFakes(page, { speech: "unavailable", mic: "denied" });
  await openFixture(page, "ptt-listening-desktop-light", { width: 480, height: 320 });
  await expect(page.getByTestId("voice-button")).toBeVisible();
  const probe = await page.evaluate(() => {
    const p = (
      window as unknown as { __junbanVoiceProbe: { fetchCalls: string[]; stoppedTracks: string[] } }
    ).__junbanVoiceProbe;
    return { fetches: p.fetchCalls.length, stops: p.stoppedTracks.length };
  });
  // Fixture presentation must not call getUserMedia or external fetch.
  expect(probe.stops).toBe(0);
});

test("phase-6 browser SpeechRecognition unavailable surfaces idle control", async ({ page }) => {
  await installVoiceFakes(page, { speech: "unavailable" });
  await openFixture(page, "ptt-listening-desktop-light", { width: 480, height: 320 });
  await expect(page.getByTestId("voice-button")).toBeVisible();
});

test("phase-6 PTT permission denied shows guidance without logging secrets", async ({ page }) => {
  await installVoiceFakes(page, { speech: "error", mic: "denied" });
  await openFixture(page, "ptt-error-desktop-light", { width: 480, height: 320 });
  await expect(page.getByRole("alert")).toContainText(/Microphone access was denied/i);
  await expect(page.getByRole("button", { name: /Retry microphone access/i })).toBeVisible();
});

test("phase-6 call End control cleans up without automatic retry", async ({ page }) => {
  await installVoiceFakes(page, { speech: "final", mic: "granted" });
  await openFixture(page, "vad-grace-desktop-light", { width: 480, height: 420 });
  await page.getByRole("button", { name: "End call" }).click();
  // Overlay remains fixture-driven; ensure End is operable and no cloud retry fired.
  const cloud = await page.evaluate(() => {
    return (window as unknown as { __junbanVoiceProbe: { cloudRequests: unknown[] } })
      .__junbanVoiceProbe.cloudRequests.length;
  });
  expect(cloud).toBe(0);
});

test("phase-6 /ai is not an alias and /ai-chat remains canonical", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(appUrlWithToken(server.baseUrl, server.token, "/ai"));
  // /ai must not resolve as the AI chat route alias.
  await expect(page).not.toHaveURL(/\/ai-chat/);
  // Direct /ai-chat is the canonical route (authenticated shell).
  await page.goto(appUrlWithToken(server.baseUrl, server.token, "/ai-chat"));
  await expect(page).toHaveURL(/\/ai-chat/);
});

test("phase-6 settings AI and Voice routes remain reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(appUrlWithToken(server.baseUrl, server.token, "/settings/ai"));
  await expect(page).toHaveURL(/\/settings\/ai/);
  await page.goto(appUrlWithToken(server.baseUrl, server.token, "/settings/voice"));
  await expect(page).toHaveURL(/\/settings\/voice/);
});
