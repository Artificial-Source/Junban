import { test, expect } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startServer, appUrlWithToken, type ServerContext } from "./fixtures";
import {
  seedPhase2Workspace,
  PHASE2_TODAY,
  VISUAL_TIMESTAMP_OVERRIDES,
  type SeededWorkspace,
} from "./phase2-seed";

const BASELINE_DIR = join(
  process.cwd(),
  "goals",
  "rust-rewrite",
  "evidence",
  "phase-2-visual-baseline",
);

// Normal test commands must NOT regenerate the fixed baseline directory.
const SNAPSHOT_DIR = join(import.meta.dirname, "visual-phase-2.spec.ts-snapshots");
const PLATFORM =
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";

let server: ServerContext;
let seed: SeededWorkspace;

test.beforeAll(async () => {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  for (const scene of SCENES) {
    const src = join(BASELINE_DIR, scene.baselineFile);
    const dest = join(
      SNAPSHOT_DIR,
      `${scene.baselineFile.replace(".png", "")}-visual-phase-2-${PLATFORM}.png`,
    );
    if (existsSync(src)) {
      copyFileSync(src, dest);
    }
  }
  server = await startServer({ seed: false });
  seed = await seedPhase2Workspace(server.baseUrl, server.token);
});

test.afterAll(async () => {
  await server.cleanup();
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-23T10:30:00-07:00"));
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

  // Seed dates are relative to the server's real civil day so server-side view
  // selection remains truthful. Normalize those dates back to the frozen visual
  // day only after selection, keeping captures deterministic across run dates.
  // The real server clock also stamps completion/cancellation instants; this
  // visual-only interception remaps the named fixtures to documented instants.
  await page.route(/\/api\/v1\/tasks(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const requestUrl = new URL(route.request().url());
    const useDetailBackdropFixture =
      new URL(page.url()).searchParams.get("phase2-detail-fixture") === "1" &&
      requestUrl.searchParams.get("view") === "today";
    if (useDetailBackdropFixture) {
      requestUrl.searchParams.delete("view");
      requestUrl.searchParams.set("limit", "100");
    }
    const response = await route.fetch({
      url: useDetailBackdropFixture ? requestUrl.toString() : undefined,
    });
    const body = await response.json();
    if (body.as_of_date) body.as_of_date = PHASE2_TODAY;
    const normalizeTask = (task: Record<string, unknown>) => {
      if (typeof task.due_date === "string") {
        task.due_date = shiftCivilDate(task.due_date, seed.serverToday);
      }
      if (typeof task.deadline === "string") {
        task.deadline = shiftCivilDate(task.deadline, seed.serverToday);
      }
      if (
        (task.status === "completed" || task.status === "cancelled") &&
        typeof task.completed_at === "string"
      ) {
        const override = VISUAL_TIMESTAMP_OVERRIDES[String(task.title)];
        if (override) task.completed_at = override;
      }
    };
    if (Array.isArray(body.tasks)) {
      if (useDetailBackdropFixture) {
        body.tasks = body.tasks.filter(
          (task) => task.status === "pending" && typeof task.due_date === "string",
        );
      }
      for (const task of body.tasks) normalizeTask(task);
    }
    if (body.task && typeof body.task === "object") normalizeTask(body.task);
    if (typeof body.id === "string") normalizeTask(body);
    await route.fulfill({ response, json: body });
  });
});

function shiftCivilDate(value: string, sourceDate: string): string {
  const parse = (date: string) => {
    const [year, month, day] = date.slice(0, 10).split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  const delta = parse(PHASE2_TODAY) - parse(sourceDate);
  const shifted = new Date(parse(value) + delta).toISOString().slice(0, 10);
  return `${shifted}${value.slice(10)}`;
}

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
    name: "today-org-desktop-light",
    baselineFile: "today-org-desktop-light.png",
    viewport: DESKTOP,
    theme: "light",
  },
  {
    name: "inbox-org-desktop-dark",
    baselineFile: "inbox-org-desktop-dark.png",
    viewport: DESKTOP,
    theme: "dark",
  },
  {
    name: "today-org-mobile-light",
    baselineFile: "today-org-mobile-light.png",
    viewport: MOBILE,
    theme: "light",
  },
  {
    name: "upcoming-desktop-dark",
    baselineFile: "upcoming-desktop-dark.png",
    viewport: DESKTOP,
    theme: "dark",
  },
  {
    name: "project-list-desktop-light",
    baselineFile: "project-list-desktop-light.png",
    viewport: DESKTOP,
    theme: "light",
  },
  {
    name: "project-board-nord",
    baselineFile: "project-board-nord.png",
    viewport: DESKTOP,
    theme: "nord",
  },
  {
    name: "cancelled-desktop-light",
    baselineFile: "cancelled-desktop-light.png",
    viewport: DESKTOP,
    theme: "light",
  },
  {
    name: "task-detail-desktop-dark",
    baselineFile: "task-detail-desktop-dark.png",
    viewport: DESKTOP,
    theme: "dark",
  },
  {
    name: "filters-labels-desktop-dark",
    baselineFile: "filters-labels-desktop-dark.png",
    viewport: DESKTOP,
    theme: "dark",
  },
  {
    name: "command-palette-desktop-light",
    baselineFile: "command-palette-desktop-light.png",
    viewport: DESKTOP,
    theme: "light",
  },
  {
    name: "mobile-drawer-dark",
    baselineFile: "mobile-drawer-dark.png",
    viewport: MOBILE,
    theme: "dark",
  },
  {
    name: "quick-add-template-light",
    baselineFile: "quick-add-template-light.png",
    viewport: DESKTOP,
    theme: "light",
  },
];

function phase2VisualPath(path: string): string {
  if (path.includes("visual-fixture=")) return path;
  return `${path}${path.includes("?") ? "&" : "?"}visual-fixture=phase-2`;
}

async function applyTheme(page: import("@playwright/test").Page, theme: Theme) {
  await page.evaluate((value) => {
    localStorage.setItem("junban-theme", value);
    const root = document.documentElement;
    root.classList.remove("dark", "nord");
    if (value === "dark" || value === "nord") root.classList.add(value);
  }, theme);
}

async function openView(page: import("@playwright/test").Page, path: string, theme: Theme) {
  await page.setViewportSize({ width: DESKTOP.width, height: DESKTOP.height });
  const url = appUrlWithToken(server.baseUrl, server.token, phase2VisualPath(path));
  await page.goto(url);
  await page.waitForSelector("h1", { timeout: 10_000 });
  await applyTheme(page, theme);
  await page.reload();
  await page.waitForSelector("h1", { timeout: 10_000 });
}

async function settle(page: import("@playwright/test").Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

const SCREENSHOT_OPTS = { maxDiffPixelRatio: 0.01, threshold: 0.2 };

// ── Scene 1: Today with organization fields — desktop light ─────────────────
test("visual phase-2: today-org-desktop-light", async ({ page }) => {
  await openView(page, "/today", "light");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText("Review accessibility audit findings")).toBeVisible();
  await expect(page.getByText("Ship v1.1 release documentation")).toBeVisible();
  await expect(page.locator('aside[aria-label="Main navigation"]')).toBeVisible();
  await expect(page.locator("#overdue-heading")).toBeVisible();
  await expect(page.getByText("Website Redesign").first()).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("today-org-desktop-light.png", SCREENSHOT_OPTS);
});

// ── Scene 2: Inbox with organization fields — desktop dark ──────────────────
test("visual phase-2: inbox-org-desktop-dark", async ({ page }) => {
  await openView(page, "/inbox", "dark");
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(page.getByText("Buy milk")).toBeVisible();
  await expect(page.getByText("Call dentist")).toBeVisible();
  await expect(page.getByText("Completed setup checklist")).toBeVisible();
  await expect(page.locator('aside[aria-label="Main navigation"]')).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("inbox-org-desktop-dark.png", SCREENSHOT_OPTS);
});

// ── Scene 3: Today organization state — mobile light ────────────────────────
test("visual phase-2: today-org-mobile-light", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto(appUrlWithToken(server.baseUrl, server.token, phase2VisualPath("/today")));
  await page.waitForSelector("h1", { timeout: 10_000 });
  await applyTheme(page, "light");
  await page.reload();
  await page.waitForSelector("h1", { timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await expect(page.getByText("Review accessibility audit findings")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("today-org-mobile-light.png", SCREENSHOT_OPTS);
});

// ── Scene 4: Upcoming with overdue and future groups — desktop dark ─────────
test("visual phase-2: upcoming-desktop-dark", async ({ page }) => {
  await openView(page, "/upcoming", "dark");
  await expect(page.getByRole("heading", { name: "Upcoming", exact: true })).toBeVisible();
  await expect(page.locator("#overdue-heading")).toBeVisible();
  await expect(page.getByText("Publish plugin author guide")).toBeVisible();
  await expect(page.getByText("Record product demo video")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("upcoming-desktop-dark.png", SCREENSHOT_OPTS);
});

// ── Scene 5: Project section list — desktop light ───────────────────────────
test("visual phase-2: project-list-desktop-light", async ({ page }) => {
  await openView(page, `/projects/${seed.projects.docs}`, "light");
  await expect(page.getByRole("heading", { name: "Documentation", exact: true })).toBeVisible();
  await expect(page.getByText("Write API reference")).toBeVisible();
  await expect(page.getByText("Review README")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("project-list-desktop-light.png", SCREENSHOT_OPTS);
});

// ── Scene 6: Project board with three sections — desktop Nord ──────────────
test("visual phase-2: project-board-nord", async ({ page }) => {
  await openView(page, `/projects/${seed.projects.website}/board`, "nord");
  await expect(page.getByRole("heading", { name: "Website Redesign", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Backlog board column" })).toBeVisible();
  await expect(page.getByRole("region", { name: "In Progress board column" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Done board column" })).toBeVisible();
  await expect(page.getByText("Migrate to Tailwind v4 tokens")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("project-board-nord.png", SCREENSHOT_OPTS);
});

// ── Scene 7: Cancelled grouped history with restore — desktop light ─────────
test("visual phase-2: cancelled-desktop-light", async ({ page }) => {
  await openView(page, "/cancelled", "light");
  await expect(page.getByRole("heading", { name: "Cancelled", exact: true })).toBeVisible();
  await expect(page.getByText("Duplicate issue report")).toBeVisible();
  await expect(page.getByText("Outdated spec review")).toBeVisible();
  await expect(page.getByText("Deprecated API cleanup")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore" }).first()).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("cancelled-desktop-light.png", SCREENSHOT_OPTS);
});

// ── Scene 8: Full task-detail panel — desktop dark ──────────────────────────
test("visual phase-2: task-detail-desktop-dark", async ({ page }) => {
  await openView(page, "/today?visual-fixture=phase-2&phase2-detail-fixture=1", "dark");
  await expect(page.getByText("Ship v1.1 release documentation")).toBeVisible();
  await page.getByRole("button", { name: "Edit task: Ship v1.1 release documentation" }).click();
  const dialog = page.getByRole("dialog", { name: /Ship v1.1 release documentation/ });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("Publish cohesive v1.1 documentation")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("task-detail-desktop-dark.png", SCREENSHOT_OPTS);
});

// ── Scene 9: Filters & Labels plus saved-filter result — desktop dark ───────
test("visual phase-2: filters-labels-desktop-dark", async ({ page }) => {
  await openView(page, "/filters-labels", "dark");
  await expect(page.getByRole("heading", { name: "Filters & Labels" })).toBeVisible();
  await expect(page.getByText("High Priority").first()).toBeVisible();
  await expect(page.getByText("frontend").first()).toBeVisible();
  await expect(page.getByText("Ship feature")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("filters-labels-desktop-dark.png", SCREENSHOT_OPTS);
});

// ── Scene 10: Command palette — desktop light ───────────────────────────────
test("visual phase-2: command-palette-desktop-light", async ({ page }) => {
  await openView(page, "/today", "light");
  await expect(page.getByText("Review accessibility audit findings")).toBeVisible();
  // Ensure no input is focused so the shortcut fires.
  await page.locator("body").focus();
  await page.keyboard.press("Control+Shift+P");
  const dialog = page.getByRole("dialog", { name: /Command Palette|palette|commands/i });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await expect(dialog.getByRole("combobox")).toBeVisible();
  await expect(dialog.getByText(/Today|Inbox|Upcoming/).first()).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("command-palette-desktop-light.png", SCREENSHOT_OPTS);
});

// ── Scene 11: Open mobile drawer with project tree — mobile dark ────────────
test("visual phase-2: mobile-drawer-dark", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto(appUrlWithToken(server.baseUrl, server.token, phase2VisualPath("/today")));
  await page.waitForSelector("h1", { timeout: 10_000 });
  await applyTheme(page, "dark");
  await page.reload();
  await page.waitForSelector("h1", { timeout: 10_000 });
  await page.getByRole("button", { name: "Open navigation menu" }).click();
  const drawer = page.getByRole("dialog", { name: /navigation|menu|drawer/i });
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  await expect(drawer.getByText("Website Redesign")).toBeVisible();
  await expect(drawer.getByText("Documentation")).toBeVisible();
  await expect(drawer.getByText("Community")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("mobile-drawer-dark.png", SCREENSHOT_OPTS);
});

// ── Scene 12: Quick Add with template selector open — desktop light ─────────
test("visual phase-2: quick-add-template-light", async ({ page }) => {
  await openView(page, "/today", "light");
  await expect(page.getByText("Review accessibility audit findings")).toBeVisible();
  await page.locator("body").focus();
  await page.keyboard.press("Control+A");
  const dialog = page.getByRole("dialog", { name: "Quick Add" });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  await dialog.getByRole("button", { name: "Templates" }).click();
  await expect(dialog.getByText("Ship feature")).toBeVisible({ timeout: 5_000 });
  await settle(page);
  await expect(page).toHaveScreenshot("quick-add-template-light.png", SCREENSHOT_OPTS);
});
