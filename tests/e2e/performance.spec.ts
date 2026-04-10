import { test, expect, type Page, type TestInfo } from "@playwright/test";
import {
  createTask,
  createTaskViaApi,
  dismissOnboarding,
  navigateTo,
  openSettings,
} from "./helpers.js";

interface PerfMeasure {
  name: string;
  duration: number;
  startTime: number;
  detail?: Record<string, unknown>;
}

async function resetPerfApp(page: Page): Promise<void> {
  await page.request.post("/api/test-reset");
  await page.request.put("/api/settings/onboarding_completed", {
    data: { value: "true" },
  });
}

async function waitForPerfMeasure(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    (target) => {
      const measures = window.__JUNBAN_PERF__?.measures ?? [];
      return measures.some((measure) => measure.name === target);
    },
    name,
    { timeout: 10000 },
  );
}

async function getLatestPerfMeasure(page: Page, name: string): Promise<PerfMeasure> {
  const measure = await page.evaluate((target) => {
    const measures = window.__JUNBAN_PERF__?.measures ?? [];
    const matches = measures.filter((entry) => entry.name === target);
    return matches.at(-1) ?? null;
  }, name);

  if (!measure) {
    throw new Error(`Missing performance measure: ${name}`);
  }

  return measure;
}

async function clearPerfMeasures(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.__JUNBAN_PERF__) {
      window.__JUNBAN_PERF__.measures = [];
      window.__JUNBAN_PERF__.active = {};
    }
  });
}

async function attachMetrics(testInfo: TestInfo, name: string, metrics: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(metrics, null, 2),
    contentType: "application/json",
  });
}

test.describe("Performance Benchmarks", () => {
  test("measures empty-start startup performance", async ({ page }, testInfo) => {
    await resetPerfApp(page);

    await page.goto("/");
    await dismissOnboarding(page);
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    await waitForPerfMeasure(page, "junban:startup");
    await waitForPerfMeasure(page, "junban:tasks-refresh");

    const startup = await getLatestPerfMeasure(page, "junban:startup");
    const tasksRefresh = await getLatestPerfMeasure(page, "junban:tasks-refresh");
    const navigation = await page.evaluate(() => {
      const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      return {
        domContentLoaded: entry.domContentLoadedEventEnd,
        loadEventEnd: entry.loadEventEnd,
      };
    });

    const metrics = { startup, tasksRefresh, navigation };
    await attachMetrics(testInfo, "startup-empty", metrics);

    expect(startup.duration).toBeLessThan(2000);
    expect(tasksRefresh.duration).toBeLessThan(1200);
    expect(navigation.domContentLoaded).toBeLessThan(2000);
  });

  test("measures startup with a larger task set", async ({ page }, testInfo) => {
    await resetPerfApp(page);

    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        createTaskViaApi(page, `Perf seed task ${index + 1}`),
      ),
    );

    await page.goto("/");
    await dismissOnboarding(page);
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    await waitForPerfMeasure(page, "junban:startup");
    await waitForPerfMeasure(page, "junban:tasks-refresh");

    const startup = await getLatestPerfMeasure(page, "junban:startup");
    const tasksRefresh = await getLatestPerfMeasure(page, "junban:tasks-refresh");

    const metrics = { startup, tasksRefresh, seededTaskCount: 200 };
    await attachMetrics(testInfo, "startup-seeded", metrics);

    expect(startup.duration).toBeLessThan(3000);
    expect(tasksRefresh.duration).toBeLessThan(1800);
  });

  test("measures key runtime interactions", async ({ page }, testInfo) => {
    await resetPerfApp(page);
    await page.goto("/");
    await dismissOnboarding(page);
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    await waitForPerfMeasure(page, "junban:startup");

    await clearPerfMeasures(page);

    await createTask(page, "Runtime benchmark task");
    await waitForPerfMeasure(page, "junban:task-create");
    const taskCreate = await getLatestPerfMeasure(page, "junban:task-create");

    await page.getByLabel("Complete task").first().click();
    await waitForPerfMeasure(page, "junban:task-complete");
    const taskComplete = await getLatestPerfMeasure(page, "junban:task-complete");

    await openSettings(page);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await waitForPerfMeasure(page, "junban:settings-open");
    const settingsOpen = await getLatestPerfMeasure(page, "junban:settings-open");
    await page.getByLabel("Close settings").click();

    await navigateTo(page, "Today");
    await expect(page.getByText("Today").first()).toBeVisible();
    await waitForPerfMeasure(page, "junban:route-change");
    const routeChange = await getLatestPerfMeasure(page, "junban:route-change");

    const metrics = { taskCreate, taskComplete, settingsOpen, routeChange };
    await attachMetrics(testInfo, "runtime-interactions", metrics);

    expect(taskCreate.duration).toBeLessThan(1000);
    expect(taskComplete.duration).toBeLessThan(1000);
    expect(settingsOpen.duration).toBeLessThan(600);
    expect(routeChange.duration).toBeLessThan(600);
  });
});
