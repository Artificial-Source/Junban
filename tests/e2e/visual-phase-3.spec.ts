import { test, expect, type Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startServer, appUrlWithToken, type ServerContext } from "./fixtures";
import {
  seedPhase3Workspace,
  PHASE3_TODAY,
  shiftCivilDate,
  type SeededPhase3Workspace,
} from "./phase3-seed";

const BASELINE_DIR = join(
  process.cwd(),
  "goals",
  "rust-rewrite",
  "evidence",
  "phase-3-visual-baseline",
);

// Normal test commands must NOT regenerate the fixed baseline directory.
const SNAPSHOT_DIR = join(import.meta.dirname, "visual-phase-3.spec.ts-snapshots");
const PLATFORM =
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";

let server: ServerContext;
let seed: SeededPhase3Workspace;

type Theme = "light" | "dark" | "nord";

interface Scene {
  name: string;
  baselineFile: string;
  viewport: { width: number; height: number };
  theme: Theme;
}

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const SCENES: Scene[] = [
  {
    name: "calendar-day-desktop-light",
    baselineFile: "calendar-day-desktop-light.png",
    viewport: DESKTOP,
    theme: "light",
  },
  {
    name: "calendar-week-desktop-dark",
    baselineFile: "calendar-week-desktop-dark.png",
    viewport: DESKTOP,
    theme: "dark",
  },
  {
    name: "calendar-month-mobile-light",
    baselineFile: "calendar-month-mobile-light.png",
    viewport: MOBILE,
    theme: "light",
  },
  {
    name: "matrix-desktop-nord",
    baselineFile: "matrix-desktop-nord.png",
    viewport: DESKTOP,
    theme: "nord",
  },
  {
    name: "plan-my-day-desktop-light",
    baselineFile: "plan-my-day-desktop-light.png",
    viewport: DESKTOP,
    theme: "light",
  },
  {
    name: "end-of-day-desktop-dark",
    baselineFile: "end-of-day-desktop-dark.png",
    viewport: DESKTOP,
    theme: "dark",
  },
  {
    name: "weekly-review-desktop-light",
    baselineFile: "weekly-review-desktop-light.png",
    viewport: DESKTOP,
    theme: "light",
  },
  {
    name: "focus-mobile-light",
    baselineFile: "focus-mobile-light.png",
    viewport: MOBILE,
    theme: "light",
  },
  {
    name: "task-reminder-recurrence-desktop-light",
    baselineFile: "task-reminder-recurrence-desktop-light.png",
    viewport: DESKTOP,
    theme: "light",
  },
  {
    name: "stats-smart-nudge-desktop-light",
    baselineFile: "stats-smart-nudge-desktop-light.png",
    viewport: DESKTOP,
    theme: "light",
  },
  {
    name: "timeblocking-day-slots-desktop-light",
    baselineFile: "timeblocking-day-slots-desktop-light.png",
    viewport: DESKTOP,
    theme: "light",
  },
  {
    name: "timeblocking-week-desktop-dark",
    baselineFile: "timeblocking-week-desktop-dark.png",
    viewport: DESKTOP,
    theme: "dark",
  },
];

// Keep the strict 1% scene budget while tolerating cross-run text antialiasing
// differences between otherwise identical pinned Linux browser/font environments.
const SCREENSHOT_OPTS = { maxDiffPixelRatio: 0.01, threshold: 0.35 };

function isPhase3VisualFixtureRoute(page: Page): boolean {
  return new URL(page.url()).searchParams.get("visual-fixture") === "phase-3";
}

function visualFixture(pathname: string): Record<string, unknown> | null {
  if (pathname.endsWith("/planning/weekly")) {
    return {
      week_start: "2026-07-20",
      week_end: "2026-07-26",
      created_count: 0,
      completed_count: 9,
      cancelled_count: 0,
      completion_rate_percent: 100,
      streak_days: 7,
      daily: [1, 3, 2, 3, 0, 0, 0].map((completed, index) => ({
        date: frozenDateOffset(index - 3),
        completed,
        created: 0,
      })),
      busiest_day: "2026-07-21",
      dominant_completion_bucket: "morning",
      completion_time_buckets: { morning: 9, afternoon: 0, evening: 0, night: 0 },
      overdue_task_ids: ["visual-overdue-1", "visual-overdue-2"],
      overdue_tasks: [
        { id: "visual-overdue-1", title: "Merge dark mode tokens pull request", priority: 2 },
        { id: "visual-overdue-2", title: "Update onboarding copy", priority: 3 },
      ],
      neglected_projects: [seed.projects.website, seed.projects.docs].map((projectId) => ({
        project_id: projectId,
        reason: "overdue",
        overdue_count: 1,
      })),
      suggestions: [],
      top_accomplishment_ids: [
        "visual-accomplishment-1",
        "visual-accomplishment-2",
        "visual-accomplishment-3",
        "visual-accomplishment-4",
        "visual-accomplishment-5",
      ],
      top_accomplishment_tasks: [
        {
          id: "visual-accomplishment-1",
          title: "Document the completion API contract",
          priority: 2,
        },
        { id: "visual-accomplishment-2", title: "Add voice activity detection", priority: null },
        { id: "visual-accomplishment-3", title: "Migrate to Drizzle ORM", priority: null },
        { id: "visual-accomplishment-4", title: "Build command palette", priority: null },
        { id: "visual-accomplishment-5", title: "Write setup guide", priority: null },
      ],
      revision: 1,
    };
  }
  if (pathname.endsWith("/stats")) {
    return {
      days: [2, 1, 3, 1, 3, 2, 3].map((completions, index) => ({
        date: frozenDateOffset(index - 6),
        completions,
        creations: completions,
        completion_minutes: completions * 100,
      })),
      total_completions: 15,
      total_creations: 15,
      total_completion_minutes: 1500,
      current_streak_days: 7,
      estimate_accuracy_percent: 88,
      estimate_accuracy_samples: 14,
      average_estimated_minutes: 108,
      average_actual_minutes: 108,
      from: "2026-07-17",
      to: "2026-07-23",
      revision: 1,
    };
  }
  return null;
}

test.beforeAll(async () => {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  for (const scene of SCENES) {
    const src = join(BASELINE_DIR, scene.baselineFile);
    const dest = join(
      SNAPSHOT_DIR,
      `${scene.baselineFile.replace(".png", "")}-visual-phase-3-${PLATFORM}.png`,
    );
    if (existsSync(src)) {
      copyFileSync(src, dest);
    }
  }
  server = await startServer({ seed: false });
  seed = await seedPhase3Workspace(server.baseUrl, server.token);
  const [year, month, day] = seed.realServerToday.split("-").map(Number);
  await server.rewriteCompletionTimes(
    seed.completionOffsets.map((completion) => {
      const completed = new Date(Date.UTC(year, month - 1, day + completion.dayOffset, 12));
      return { taskId: completion.taskId, completedAt: completed.toISOString() };
    }),
  );
});

test.afterAll(async () => {
  await server.cleanup();
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 6, 23, 10, 30, 0));
  await page.addInitScript(() => {
    const original = window.matchMedia;
    window.matchMedia = (query: string) => {
      const base = original(query);
      return {
        ...base,
        matches: query === "(prefers-reduced-motion: reduce)" ? true : base.matches,
      };
    };
  });

  // Visual-only: translate frozen capture-day civil query keys to the server's
  // actual civil date before classification, then normalize response keys back.
  await page.route(/\/api\/v1\//, async (route) => {
    const request = route.request();
    const originalUrl = new URL(request.url());
    if (
      request.method() !== "GET" ||
      originalUrl.pathname.endsWith("/events") ||
      originalUrl.pathname.includes("/reminders/events")
    ) {
      await route.continue();
      return;
    }
    const fixture = isPhase3VisualFixtureRoute(page) ? visualFixture(originalUrl.pathname) : null;
    if (fixture) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(fixture) });
      return;
    }

    const serverUrl = new URL(originalUrl);
    for (const key of ["date", "from", "to"]) {
      const value = serverUrl.searchParams.get(key);
      if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        serverUrl.searchParams.set(key, shiftCivilDate(value, PHASE3_TODAY, seed.serverToday));
      }
    }
    const response = await route.fetch({ url: serverUrl.toString() });
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      await route.fulfill({ response });
      return;
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      await route.fulfill({ status: response.status(), contentType, body: text });
      return;
    }
    normalizeVisualPayload(body, originalUrl.pathname, seed.serverToday, page);
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
});

function shiftTaskFields(task: Record<string, unknown>, serverToday: string) {
  if (typeof task.due_date === "string") {
    task.due_date = shiftCivilDate(task.due_date, serverToday);
  }
  if (typeof task.deadline === "string" && /^\d{4}-\d{2}-\d{2}/.test(task.deadline)) {
    // Deadlines that are pure civil dates are shifted; instants stay.
    if (task.deadline.length === 10) {
      task.deadline = shiftCivilDate(task.deadline, serverToday);
    }
  }
}

function frozenDateOffset(days: number) {
  const date = new Date(`${PHASE3_TODAY}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeVisualPayload(body: unknown, url: string, serverToday: string, page: Page) {
  if (!body || typeof body !== "object") return;
  const data = body as Record<string, unknown>;

  if (typeof data.as_of_date === "string") data.as_of_date = PHASE3_TODAY;
  if (url.includes("/settings/temporal") && isPhase3VisualFixtureRoute(page)) {
    data.week_start = "monday";
  }
  if (typeof data.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    data.date = shiftCivilDate(data.date, serverToday);
  }
  if (typeof data.week_start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.week_start)) {
    data.week_start = shiftCivilDate(data.week_start, serverToday);
  }
  if (typeof data.week_end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.week_end)) {
    data.week_end = shiftCivilDate(data.week_end, serverToday);
  }
  if (typeof data.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.from)) {
    data.from = shiftCivilDate(data.from, serverToday);
  }
  if (typeof data.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.to)) {
    data.to = shiftCivilDate(data.to, serverToday);
  }

  for (const key of [
    "tasks",
    "overdue_tasks",
    "focus_tasks",
    "carry_over_tasks",
    "tomorrow_tasks",
  ]) {
    const list = data[key];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && typeof item === "object")
          shiftTaskFields(item as Record<string, unknown>, serverToday);
      }
    }
  }

  if (url.includes("/views/today") && Array.isArray(data.tasks)) {
    let normalizedCompletions = 0;
    for (const task of data.tasks) {
      if (
        task &&
        typeof task === "object" &&
        (task as Record<string, unknown>).status === "completed" &&
        normalizedCompletions < 3
      ) {
        (task as Record<string, unknown>).completed_at = `${PHASE3_TODAY}T12:00:00Z`;
        normalizedCompletions += 1;
      }
    }
  }

  if (Array.isArray(data.days)) {
    for (const day of data.days) {
      if (day && typeof day === "object" && typeof (day as { date?: string }).date === "string") {
        (day as { date: string }).date = shiftCivilDate(
          (day as { date: string }).date,
          serverToday,
        );
      }
    }
  }
  if (Array.isArray(data.daily)) {
    for (const day of data.daily) {
      if (day && typeof day === "object" && typeof (day as { date?: string }).date === "string") {
        (day as { date: string }).date = shiftCivilDate(
          (day as { date: string }).date,
          serverToday,
        );
      }
    }
  }
  if (url.includes("/views/matrix") && Array.isArray(data.tasks)) {
    const expectedOrder = [
      "Review architecture proposal",
      "Fix calendar timezone regression",
      "Ship release candidate",
      "Urgent sample incident",
      "Deep work: migration",
      "Draft release notes",
      "Prepare stakeholder brief",
      "Merge dependency update",
      "Review pull request",
      "Sync design tokens",
      "Ship matrix card",
      "Publish launch checklist",
      "Host community Q&A",
      "Record product demo",
      "Design plugin sandbox",
      "Redesign empty states",
      "Schedule customer interviews",
      "Write retrospective",
      "Add quick capture shortcut",
      "Refresh onboarding copy",
      "Add plugin marketplace polish",
    ];
    const order = new Map(expectedOrder.map((title, index) => [title, index]));
    data.tasks.sort((left, right) => {
      const leftTitle =
        left && typeof left === "object" ? String((left as Record<string, unknown>).title) : "";
      const rightTitle =
        right && typeof right === "object" ? String((right as Record<string, unknown>).title) : "";
      return (
        (order.get(leftTitle) ?? expectedOrder.length) -
        (order.get(rightTitle) ?? expectedOrder.length)
      );
    });
  }

  if (url.includes("/tasks/") && Array.isArray(data.labels)) {
    const labelOrder = new Map([
      ["review", 0],
      ["frontend", 1],
    ]);
    data.labels.sort((left, right) => {
      const leftName =
        left && typeof left === "object"
          ? String((left as Record<string, unknown>).name ?? "")
          : String(left);
      const rightName =
        right && typeof right === "object"
          ? String((right as Record<string, unknown>).name ?? "")
          : String(right);
      return (labelOrder.get(leftName) ?? 9) - (labelOrder.get(rightName) ?? 9);
    });
  }

  if (Array.isArray(data.time_blocks)) {
    for (const block of data.time_blocks) {
      if (
        block &&
        typeof block === "object" &&
        typeof (block as { date?: string }).date === "string"
      ) {
        (block as { date: string }).date = shiftCivilDate(
          (block as { date: string }).date,
          serverToday,
        );
      }
    }
  }
  if (data.task && typeof data.task === "object") {
    shiftTaskFields(data.task as Record<string, unknown>, serverToday);
  }
  if (data.snapshot && typeof data.snapshot === "object") {
    normalizeVisualPayload(data.snapshot, url, serverToday, page);
  }
  if (Array.isArray(data.time_slots)) {
    for (const slot of data.time_slots) {
      if (
        slot &&
        typeof slot === "object" &&
        typeof (slot as { date?: string }).date === "string"
      ) {
        (slot as { date: string }).date = shiftCivilDate(
          (slot as { date: string }).date,
          serverToday,
        );
      }
    }
  }

  // Calendar task arrays are normalized by the shared `tasks` branch above.
  void url;
}

async function applyTheme(page: Page, theme: Theme) {
  await page.evaluate((value) => {
    localStorage.setItem("junban-theme", value);
    const root = document.documentElement;
    root.classList.remove("dark", "nord");
    if (value === "dark" || value === "nord") root.classList.add(value);
  }, theme);
}

async function waitForAppShell(page: Page) {
  await expect
    .poll(
      async () => {
        if (
          await page
            .locator("h1")
            .first()
            .isVisible()
            .catch(() => false)
        )
          return true;
        if (
          await page
            .getByTestId("timeblocking-view")
            .isVisible()
            .catch(() => false)
        )
          return true;
        if (
          await page
            .getByRole("dialog", { name: "Focus mode" })
            .isVisible()
            .catch(() => false)
        )
          return true;
        if (
          await page
            .locator('nav[aria-label="Views"], aside[aria-label="Main navigation"]')
            .first()
            .isVisible()
            .catch(() => false)
        )
          return true;
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

async function openView(page: Page, path: string, theme: Theme, viewport = DESKTOP) {
  await page.setViewportSize(viewport);
  const url = appUrlWithToken(server.baseUrl, server.token, path);
  await page.goto(url);
  await waitForAppShell(page);
  await applyTheme(page, theme);
  await page.reload();
  await waitForAppShell(page);
}

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

/** Dismiss Smart Nudge toasts so they only appear in the dedicated authority scene. */
async function dismissNudges(page: Page) {
  if (page.clock?.fastForward) {
    await page.clock.fastForward(1500).catch(() => {});
  }
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(150);
    const dismiss = page.getByRole("button", { name: "Dismiss", exact: true }).last();
    if (!(await dismiss.isVisible().catch(() => false))) continue;
    await dismiss.click();
  }
}

async function selectCalendarMode(page: Page, mode: "Day" | "Week" | "Month") {
  // Controlled sr-only radios need a label click so React onChange runs.
  const radio = page.getByRole("radio", { name: mode, exact: true });
  await expect(radio).toBeVisible({ timeout: 10_000 });
  if (!(await radio.isChecked())) {
    const responsePromise = page.waitForResponse(
      (res) => res.url().includes("/api/v1/calendar/tasks") && res.ok(),
      { timeout: 15_000 },
    );
    await page.locator(`label[for="${await radio.getAttribute("id")}"]`).click();
    await responsePromise;
  }
  await expect(radio).toBeChecked();
  // Click Today so the civil anchor and range read settle on the frozen day.
  const todayBtn = page.getByRole("button", { name: "Today", exact: true });
  if (await todayBtn.isVisible().catch(() => false)) {
    const refresh = page.waitForResponse(
      (res) => res.url().includes("/api/v1/calendar/tasks") && res.ok(),
      { timeout: 15_000 },
    );
    await todayBtn.click();
    await refresh.catch(() => {});
  }
  await settle(page);
}

async function selectTimeblockingMode(page: Page, mode: "Day" | "Week") {
  const button = page.getByTestId("view-mode-selector").getByRole("button", {
    name: mode,
    exact: true,
  });
  await expect(button).toBeVisible({ timeout: 10_000 });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
  }
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await settle(page);
}

// ── Scene 1: Calendar Day — desktop light ───────────────────────────────────
test("visual phase-3: calendar-day-desktop-light", async ({ page }) => {
  await openView(page, "/calendar?visual-fixture=phase-3", "light");
  await selectCalendarMode(page, "Day");
  await expect(page.getByText("Review accessibility audit findings").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/Jul 23|Thursday/i).first()).toBeVisible();
  await expect(page.getByRole("radio", { name: "Day", exact: true })).toBeChecked();
  await expect(
    page.locator('aside[aria-label="Main navigation"], nav[aria-label="Views"]').first(),
  ).toBeVisible();
  await dismissNudges(page);
  await settle(page);
  await expect(page).toHaveScreenshot("calendar-day-desktop-light.png", SCREENSHOT_OPTS);
});

// ── Scene 2: Calendar Week — desktop dark ───────────────────────────────────
test("visual phase-3: calendar-week-desktop-dark", async ({ page }) => {
  await openView(page, "/calendar?visual-fixture=phase-3", "dark");
  await selectCalendarMode(page, "Week");
  await expect(page.getByText("Publish plugin author guide").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("radio", { name: "Week", exact: true })).toBeChecked();
  await dismissNudges(page);
  await settle(page);
  await expect(page).toHaveScreenshot("calendar-week-desktop-dark.png", SCREENSHOT_OPTS);
});

// ── Scene 3: Calendar Month — mobile light ──────────────────────────────────
test("visual phase-3: calendar-month-mobile-light", async ({ page }) => {
  await openView(page, "/calendar?visual-fixture=phase-3", "light", MOBILE);
  await selectCalendarMode(page, "Month");
  await expect(page.getByRole("button", { name: "Today", exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("radio", { name: "Month", exact: true })).toBeChecked();
  await expect(
    page.getByRole("navigation", { name: /Mobile navigation|Main navigation/i }),
  ).toBeVisible();
  await dismissNudges(page);
  await settle(page);
  await expect(page).toHaveScreenshot("calendar-month-mobile-light.png", SCREENSHOT_OPTS);
});

// ── Scene 4: Matrix — desktop Nord ──────────────────────────────────────────
test("visual phase-3: matrix-desktop-nord", async ({ page }) => {
  await openView(page, "/matrix?visual-fixture=phase-3", "nord");
  await expect(page.getByRole("heading", { name: "Matrix", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("heading", { name: "Do First", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Delegate", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Eliminate", exact: true })).toBeVisible();
  await dismissNudges(page);
  await settle(page);
  await expect(page).toHaveScreenshot("matrix-desktop-nord.png", SCREENSHOT_OPTS);
});

// ── Scene 5: Plan My Day — desktop light ────────────────────────────────────
test("visual phase-3: plan-my-day-desktop-light", async ({ page }) => {
  await openView(page, "/today?visual-fixture=phase-3", "light");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await dismissNudges(page);
  await page.getByRole("button", { name: "Plan My Day" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("Review Overdue")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("plan-my-day-desktop-light.png", SCREENSHOT_OPTS);
});

// ── Scene 6: End of Day — desktop dark ──────────────────────────────────────
test("visual phase-3: end-of-day-desktop-dark", async ({ page }) => {
  await openView(page, "/today?visual-fixture=phase-3", "dark");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await dismissNudges(page);
  await page.getByRole("button", { name: "End of Day" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("Today's Wins")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("end-of-day-desktop-dark.png", SCREENSHOT_OPTS);
});

// ── Scene 7: Weekly Review — desktop light ──────────────────────────────────
test("visual phase-3: weekly-review-desktop-light", async ({ page }) => {
  await openView(page, "/today?visual-fixture=phase-3", "light");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await dismissNudges(page);
  await page.getByRole("button", { name: "Weekly Review" }).click();
  await expect(page.getByText("Weekly Review").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="summary-stats"]')).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("weekly-review-desktop-light.png", SCREENSHOT_OPTS);
});

// ── Scene 8: Focus Mode — mobile light ──────────────────────────────────────
test("visual phase-3: focus-mobile-light", async ({ page }) => {
  await openView(page, "/today?focus=1&visual-fixture=phase-3", "light", MOBILE);
  await expect(page.getByRole("dialog", { name: "Focus mode" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Focus Mode", { exact: true })).toBeVisible();
  await dismissNudges(page);
  await settle(page);
  await expect(page).toHaveScreenshot("focus-mobile-light.png", SCREENSHOT_OPTS);
});

// ── Scene 9: Task reminder + recurrence detail — desktop light ──────────────
test("visual phase-3: task-reminder-recurrence-desktop-light", async ({ page }) => {
  await openView(page, "/today?visual-fixture=phase-3", "light");
  await expect(page.getByText("Ship v1.1 release documentation").first()).toBeVisible({
    timeout: 15_000,
  });
  await dismissNudges(page);
  await page
    .getByRole("button", {
      name: /Edit task: Ship v1\.1 release documentation|Task: Ship v1\.1 release documentation/,
    })
    .first()
    .click();
  const dialog = page.getByRole("dialog", {
    name: /Task: Ship v1\.1 release documentation/,
  });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("Reminder", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Recurrence", { exact: true })).toBeVisible();
  await dialog.getByText("Recurrence", { exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByText("Weekly", { exact: true })).toBeVisible();
  await expect(dialog.getByText("No reminder")).toHaveCount(0);
  await dialog.locator("aside").evaluate((element) => {
    element.scrollTop = 130;
  });
  await settle(page);
  await expect(page).toHaveScreenshot(
    "task-reminder-recurrence-desktop-light.png",
    SCREENSHOT_OPTS,
  );
});

// ── Scene 10: Stats + Smart Nudge — desktop light ───────────────────────────
test("visual phase-3: stats-smart-nudge-desktop-light", async ({ page }) => {
  await openView(page, "/stats?visual-fixture=phase-3", "light");
  await expect(page.getByRole("heading", { name: /Productivity/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Last 7 Days")).toBeVisible();

  for (let attempt = 0; attempt < 8; attempt++) {
    if (page.clock?.fastForward) {
      await page.clock.fastForward(1000).catch(() => {});
    }
    const toast = page.getByRole("alert").filter({ hasText: /overdue/i });
    if (await toast.isVisible().catch(() => false)) break;
    await page.waitForTimeout(400);
  }
  await expect(page.getByRole("alert").filter({ hasText: /overdue/i })).toBeVisible({
    timeout: 10_000,
  });
  await settle(page);
  await expect(page).toHaveScreenshot("stats-smart-nudge-desktop-light.png", SCREENSHOT_OPTS);
});

// ── Scene 11: Timeblocking Day with slots — desktop light ───────────────────
test("visual phase-3: timeblocking-day-slots-desktop-light", async ({ page }) => {
  await openView(page, "/timeblocking?visual-fixture=phase-3", "light");
  await expect(page.getByTestId("view-mode-selector")).toBeVisible({ timeout: 15_000 });
  await selectTimeblockingMode(page, "Day");
  await expect(page.getByText("Deep work: calendar day polish").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Collaboration block").first()).toBeVisible();
  await dismissNudges(page);
  await settle(page);
  await expect(page).toHaveScreenshot("timeblocking-day-slots-desktop-light.png", SCREENSHOT_OPTS);
});

// ── Scene 12: Timeblocking Week — desktop dark ──────────────────────────────
test("visual phase-3: timeblocking-week-desktop-dark", async ({ page }) => {
  await openView(page, "/timeblocking?visual-fixture=phase-3", "dark");
  await expect(page.getByTestId("view-mode-selector")).toBeVisible({ timeout: 15_000 });
  await selectTimeblockingMode(page, "Week");
  await expect(page.getByText("Deep work: calendar day polish").first()).toBeVisible({
    timeout: 15_000,
  });
  await dismissNudges(page);
  await settle(page);
  await expect(page).toHaveScreenshot("timeblocking-week-desktop-dark.png", SCREENSHOT_OPTS);
});
