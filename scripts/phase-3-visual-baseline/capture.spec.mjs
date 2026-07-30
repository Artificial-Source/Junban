import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURE_NOW, seedWorkspace } from "./seed.mjs";

/**
 * Capture the twelve immutable Phase 3 legacy visual authorities.
 *
 * Source: Junban-legacy@5e2b2b5 (real rendered UI, including built-in plugins).
 * Output: goals/rust-rewrite/evidence/phase-3-visual-baseline/*.png
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(
  __dirname,
  "../../goals/rust-rewrite/evidence/phase-3-visual-baseline",
);
const OUT_DIR = process.env.PHASE3_VISUAL_OUT ?? DEFAULT_OUT;

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

async function applyTheme(page, theme) {
  await page.evaluate((value) => window.localStorage.setItem("junban-theme", value), theme);
}

/**
 * Theme + hash route, then full reload so ThemeManager re-reads storage.
 * Hash-only navigation does not re-apply theme.
 */
async function waitForShell(page) {
  // Desktop exposes the Views sidebar; mobile uses the bottom nav bar instead.
  const desktopNav = page.getByRole("navigation", { name: "Views" });
  const mobileNav = page.getByRole("navigation", { name: /mobile navigation|Main navigation/i });
  const bottomMenu = page.getByRole("button", { name: /^Menu$/i });
  await expect
    .poll(
      async () => {
        if (await desktopNav.isVisible().catch(() => false)) return true;
        if (await mobileNav.isVisible().catch(() => false)) return true;
        if (await bottomMenu.isVisible().catch(() => false)) return true;
        // Authenticated app chrome always mounts a main landmark once hydrated.
        if (await page.locator("main").first().isVisible().catch(() => false)) return true;
        return false;
      },
      { timeout: 25_000 },
    )
    .toBe(true);
}

async function openView(page, route, theme, viewport = DESKTOP) {
  await page.setViewportSize(viewport);
  await applyTheme(page, theme);
  await page.evaluate((r) => {
    window.location.hash = r;
  }, route);
  await page.reload();
  await waitForShell(page);
}

async function settle(page) {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  // Animations are effectively instant under reduce_animations + reduced-motion.
  await page.waitForTimeout(500);
}

/** Dismiss Smart Nudge toasts so they only appear in the dedicated authority scene. */
async function dismissNudges(page) {
  // Nudge evaluation is deferred; give it a brief window, then drain toasts.
  if (page.clock?.fastForward) {
    await page.clock.fastForward(1500).catch(() => {});
  }
  await page.waitForTimeout(300);
  for (let i = 0; i < 6; i++) {
    const toast = page.getByRole("alert").filter({ hasText: /overdue|deadline|stale|nudge/i });
    if (!(await toast.isVisible().catch(() => false))) return;
    const dismiss = toast.getByRole("button", { name: /Dismiss/i });
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click();
    } else {
      await toast.locator("button").last().click().catch(() => {});
    }
    await page.waitForTimeout(250);
  }
}

async function dismissOnboardingIfPresent(page) {
  const skip = page.getByRole("button", { name: "Skip" });
  if (await skip.isVisible({ timeout: 1500 }).catch(() => false)) {
    await skip.click();
  }
}

async function waitForApi(request) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      if ((await request.get("/api/health")).ok()) return;
    } catch {
      // backend still booting
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Phase 3 visual baseline backend API did not become ready in time");
}

async function shot(page, name) {
  mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, name);
  await page.screenshot({ path: target, animations: "disabled" });
  return target;
}

async function selectCalendarMode(page, mode) {
  // SegmentedControl renders radio inputs with visible labels Day/Week/Month.
  const radio = page.getByRole("radio", { name: mode, exact: true });
  if (await radio.count()) {
    await radio.check({ force: true });
  } else {
    await page.locator("label", { hasText: new RegExp(`^${mode}$`) }).first().click();
  }
  await settle(page);
}

async function captureCalendarDayLight(page) {
  await openView(page, "/calendar", "light", DESKTOP);
  await selectCalendarMode(page, "Day");
  await expect(page.getByText("Review accessibility audit findings").first()).toBeVisible({
    timeout: 15_000,
  });
  await dismissNudges(page);
  await settle(page);
  await shot(page, "calendar-day-desktop-light.png");
}

async function captureCalendarWeekDark(page) {
  await openView(page, "/calendar", "dark", DESKTOP);
  await selectCalendarMode(page, "Week");
  await expect(page.getByText("Publish plugin author guide").first()).toBeVisible({
    timeout: 15_000,
  });
  await dismissNudges(page);
  await settle(page);
  await shot(page, "calendar-week-desktop-dark.png");
}

async function captureCalendarMonthMobile(page) {
  await openView(page, "/calendar", "light", MOBILE);
  await selectCalendarMode(page, "Month");
  // Month view shows day cells; assert the period chrome is settled.
  await expect(page.getByRole("button", { name: "Today", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("radio", { name: "Month", exact: true })).toBeChecked();
  await dismissNudges(page);
  await settle(page);
  await shot(page, "calendar-month-mobile-light.png");
}

async function captureMatrixNord(page) {
  await openView(page, "/matrix", "nord", DESKTOP);
  await expect(page.getByRole("heading", { name: "Matrix" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Do First", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Schedule", exact: true })).toBeVisible();
  await dismissNudges(page);
  await settle(page);
  await shot(page, "matrix-desktop-nord.png");
}

async function capturePlanMyDay(page) {
  await openView(page, "/today", "light", DESKTOP);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await dismissNudges(page);
  await page.getByRole("button", { name: "Plan My Day" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("Review Overdue")).toBeVisible();
  await settle(page);
  await shot(page, "plan-my-day-desktop-light.png");
  await page.keyboard.press("Escape");
}

async function captureEndOfDayDark(page) {
  await openView(page, "/today", "dark", DESKTOP);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await dismissNudges(page);
  await page.getByRole("button", { name: "End of Day" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("Today's Wins")).toBeVisible();
  await settle(page);
  await shot(page, "end-of-day-desktop-dark.png");
  await page.keyboard.press("Escape");
}

async function captureWeeklyReview(page) {
  await openView(page, "/today", "light", DESKTOP);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await dismissNudges(page);
  await page.getByRole("button", { name: "Weekly Review" }).click();
  await expect(page.getByText("Weekly Review").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="summary-stats"]')).toBeVisible();
  await settle(page);
  await shot(page, "weekly-review-desktop-light.png");
  await page.keyboard.press("Escape");
}

async function captureFocusMobile(page) {
  await openView(page, "/today?focus=1", "light", MOBILE);
  await expect(page.getByRole("dialog", { name: "Focus mode" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Focus Mode", { exact: true })).toBeVisible();
  await dismissNudges(page);
  await settle(page);
  await shot(page, "focus-mobile-light.png");
}

async function captureTaskReminderRecurrence(page) {
  await openView(page, "/today", "light", DESKTOP);
  await expect(page.getByText("Ship v1.1 release documentation").first()).toBeVisible({
    timeout: 15_000,
  });
  await dismissNudges(page);
  await page
    .getByRole("button", { name: "Task: Ship v1.1 release documentation", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Task details" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("Reminder", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Recurrence", { exact: true })).toBeVisible();
  // Ensure the reminder/recurrence values are in view.
  await dialog.getByText("Recurrence", { exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByText("Weekly", { exact: true })).toBeVisible();
  // Reminder must render a concrete value (not the empty placeholder).
  await expect(dialog.getByText("No reminder")).toHaveCount(0);
  await expect(dialog.getByLabel(/Edit reminder|Set reminder/)).not.toHaveText(/No reminder/);
  await dismissNudges(page);
  await settle(page);
  await shot(page, "task-reminder-recurrence-desktop-light.png");
  await page.keyboard.press("Escape");
}

async function captureStatsSmartNudge(page) {
  await openView(page, "/stats", "light", DESKTOP);
  await expect(page.getByRole("heading", { name: "Productivity" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Last 7 Days")).toBeVisible();

  // Nudge evaluation is deferred (idle/timeout). Advance mocked timers and wait
  // for the overdue Smart Nudge toast that useAppState surfaces.
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
  await shot(page, "stats-smart-nudge-desktop-light.png");
}

async function openTimeblocking(page, theme) {
  // Namespaced plugin view id is timeblocking:timeblocking.
  await openView(page, "/plugin-view/timeblocking:timeblocking", theme, DESKTOP);
  const selector = page.getByTestId("view-mode-selector");
  if (!(await selector.isVisible({ timeout: 8_000 }).catch(() => false))) {
    const nav = page.getByRole("navigation", { name: "Views" });
    const link = nav.getByText(/^Timeblocking$/i).first();
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await settle(page);
  }
  await expect(page.getByTestId("view-mode-selector")).toBeVisible({ timeout: 20_000 });
}

async function captureTimeblockingDay(page) {
  await openTimeblocking(page, "light");
  await page.getByTestId("view-mode-1").click();
  await expect(page.getByText("Deep work: calendar day polish").first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Collaboration block").first()).toBeVisible();
  await dismissNudges(page);
  await settle(page);
  await shot(page, "timeblocking-day-slots-desktop-light.png");
}

async function captureTimeblockingWeekDark(page) {
  await openTimeblocking(page, "dark");
  await page.getByTestId("view-mode-7").click();
  await settle(page);
  // Week mode should still show today's deep-work block in the range.
  await expect(page.getByText("Deep work: calendar day polish").first()).toBeVisible({
    timeout: 15_000,
  });
  await dismissNudges(page);
  await settle(page);
  await shot(page, "timeblocking-week-desktop-dark.png");
}

test("capture Phase 3 legacy visual authorities", async ({ page }) => {
  // Freeze browser civil time so Today/Calendar/Stats/Focus classify the same day.
  await page.clock.setFixedTime(CAPTURE_NOW);

  await waitForApi(page.request);
  await seedWorkspace(page.request);

  await page.goto("/");
  await dismissOnboardingIfPresent(page);
  await page.reload();
  await waitForShell(page);

  // Confirm built-in plugin views registered after permission approval (desktop nav).
  const desktopNav = page.getByRole("navigation", { name: "Views" });
  if (await desktopNav.isVisible().catch(() => false)) {
    await expect(desktopNav.getByText(/Calendar/i).first()).toBeVisible({ timeout: 20_000 });
  }

  // Capture the Smart Nudge toast before any scene dismisses session nudges.
  await captureStatsSmartNudge(page);

  await captureCalendarDayLight(page);
  await captureCalendarWeekDark(page);
  await captureCalendarMonthMobile(page);
  await captureMatrixNord(page);
  await capturePlanMyDay(page);
  await captureEndOfDayDark(page);
  await captureWeeklyReview(page);
  await captureFocusMobile(page);
  await captureTaskReminderRecurrence(page);
  await captureTimeblockingDay(page);
  await captureTimeblockingWeekDark(page);
});
