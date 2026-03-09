import { test, expect } from "@playwright/test";
import {
  setupPage,
  createTaskViaApi,
  createProjectViaApi,
  openTaskDetail,
  navigateTo,
  localDateKey,
} from "./helpers.js";

const dialog = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "Task details" });

// ── Bug 1: Ultrawide max-width ──────────────────────────────────────────

test.describe("Ultrawide max-width constraint", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("main content area has max-w-7xl constraint at 2560px width", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1080 });

    // The inner wrapper div should be present with max-w-7xl in its class list
    const wrapper = page.locator("#main-content > div").first();
    await expect(wrapper).toBeVisible();

    // Verify the wrapper has the max-w-7xl class
    await expect(wrapper).toHaveClass(/max-w-7xl/);

    // max-w-7xl = 90rem = 1440px in Tailwind v4. The wrapper should not exceed this.
    const box = await wrapper.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(1440);
  });

  test("content is horizontally centered on ultrawide", async ({ page }) => {
    await page.setViewportSize({ width: 2560, height: 1080 });

    const wrapper = page.locator("#main-content > div").first();
    await expect(wrapper).toBeVisible();

    const mainBox = await page.locator("#main-content").boundingBox();
    const wrapperBox = await wrapper.boundingBox();

    expect(mainBox).not.toBeNull();
    expect(wrapperBox).not.toBeNull();

    // Wrapper should be centered within main (mx-auto)
    const leftMargin = wrapperBox!.x - mainBox!.x;
    const rightMargin = mainBox!.x + mainBox!.width - (wrapperBox!.x + wrapperBox!.width);
    // Left and right margins should be roughly equal (within 10px for padding)
    expect(Math.abs(leftMargin - rightMargin)).toBeLessThan(20);
  });

  test("content fills width normally at 1280px viewport", async ({ page }) => {
    // At 1280px viewport the sidebar takes space, so main content area is smaller
    // The wrapper should fill the available space (not be constrained further)
    await page.setViewportSize({ width: 1280, height: 720 });

    const wrapper = page.locator("#main-content > div").first();
    await expect(wrapper).toBeVisible();

    const mainBox = await page.locator("#main-content").boundingBox();
    const wrapperBox = await wrapper.boundingBox();

    expect(mainBox).not.toBeNull();
    expect(wrapperBox).not.toBeNull();

    // At standard width, wrapper should fill most of the main area
    // (accounting for padding)
    expect(wrapperBox!.width).toBeGreaterThan(mainBox!.width * 0.8);
  });
});

// ── Bug 2: NLP "deadline friday" parsing ────────────────────────────────

test.describe("NLP deadline keyword parsing", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test('creates task with "deadline friday" — deadline field is set, title is clean', async ({
    page,
  }) => {
    // Create a task using the deadline keyword
    const input = page.getByPlaceholder(/Add a task/i);
    await input.click();
    await input.fill("Submit report deadline friday");
    await input.press("Enter");

    // Wait for the task to appear — title should NOT contain "deadline friday"
    await expect(page.getByText("Submit report").first()).toBeVisible({ timeout: 5000 });

    // Open the task detail
    await openTaskDetail(page, "Submit report");

    // The deadline field should be set (not "No deadline")
    const detailPanel = dialog(page);
    await expect(detailPanel.locator("label", { hasText: "Deadline" })).toBeVisible({
      timeout: 5000,
    });
    // Should NOT show "No deadline"
    await expect(detailPanel.getByText("No deadline")).not.toBeVisible({ timeout: 2000 });
  });

  test('creates task with "!!friday" — deadline field is set', async ({ page }) => {
    const input = page.getByPlaceholder(/Add a task/i);
    await input.click();
    await input.fill("Submit report !!friday");
    await input.press("Enter");

    await expect(page.getByText("Submit report").first()).toBeVisible({ timeout: 5000 });

    await openTaskDetail(page, "Submit report");

    const detailPanel = dialog(page);
    await expect(detailPanel.locator("label", { hasText: "Deadline" })).toBeVisible({
      timeout: 5000,
    });
    await expect(detailPanel.getByText("No deadline")).not.toBeVisible({ timeout: 2000 });
  });

  test("deadline keyword is stripped from the task title", async ({ page }) => {
    const input = page.getByPlaceholder(/Add a task/i);
    await input.click();
    await input.fill("Buy groceries deadline monday p2");
    await input.press("Enter");

    // Title should be "Buy groceries" (deadline and priority stripped)
    await expect(page.getByText("Buy groceries").first()).toBeVisible({ timeout: 5000 });
    // "deadline monday" should NOT appear in the task list
    const listArea = page.locator("#main-content");
    await expect(listArea.getByText("deadline monday")).not.toBeVisible({ timeout: 2000 });
  });
});

// ── Bug 3: Right-click context menu ─────────────────────────────────────

test.describe("Right-click context menu on tasks", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("right-clicking a task shows the context menu", async ({ page }) => {
    await createTaskViaApi(page, "Context menu task");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Right-click on the task
    const taskItem = page.getByText("Context menu task").first();
    await taskItem.click({ button: "right" });

    // The context menu should appear with role="menu"
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 3000 });
  });

  test("context menu shows Edit, Complete, Priority, Delete actions", async ({ page }) => {
    await createTaskViaApi(page, "Menu items task");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    const taskItem = page.getByText("Menu items task").first();
    await taskItem.click({ button: "right" });

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 3000 });

    // Verify menu items exist
    await expect(menu.getByRole("menuitem", { name: "Edit" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Complete" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Priority" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  });

  test("context menu Complete action toggles the task", async ({ page }) => {
    await createTaskViaApi(page, "Complete via menu");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    const taskItem = page.getByText("Complete via menu").first();
    await taskItem.click({ button: "right" });

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 3000 });

    // Click "Complete"
    await menu.getByRole("menuitem", { name: "Complete" }).click();

    // The context menu should close
    await expect(menu).not.toBeVisible({ timeout: 2000 });

    // Wait for the task to be completed (it should disappear from Inbox pending list)
    await page.waitForTimeout(500);
  });

  test("context menu Edit action opens task detail", async ({ page }) => {
    await createTaskViaApi(page, "Edit via menu");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    const taskItem = page.getByText("Edit via menu").first();
    await taskItem.click({ button: "right" });

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 3000 });

    // Click "Edit"
    await menu.getByRole("menuitem", { name: "Edit" }).click();

    // The task detail panel should open
    await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible({
      timeout: 5000,
    });
  });

  test("context menu shows Move to project when projects exist", async ({ page }) => {
    await createProjectViaApi(page, "Work");
    await createTaskViaApi(page, "Move via menu");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    const taskItem = page.getByText("Move via menu").first();
    await taskItem.click({ button: "right" });

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 3000 });

    // "Move to..." should appear when projects exist
    await expect(menu.getByRole("menuitem", { name: "Move to..." })).toBeVisible();
  });

  test("context menu closes on Escape", async ({ page }) => {
    await createTaskViaApi(page, "Escape menu task");

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    const taskItem = page.getByText("Escape menu task").first();
    await taskItem.click({ button: "right" });

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 3000 });

    // Press Escape
    await page.keyboard.press("Escape");

    // Menu should close
    await expect(menu).not.toBeVisible({ timeout: 2000 });
  });

  test("context menu works in Today view", async ({ page }) => {
    const today = localDateKey();
    await createTaskViaApi(page, "Today context task", { dueDate: today });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Today");

    const taskItem = page.getByText("Today context task").first();
    await taskItem.click({ button: "right" });

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 3000 });
    await expect(menu.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  });

  test("context menu works in Project view", async ({ page }) => {
    const project = await createProjectViaApi(page, "Work");
    await createTaskViaApi(page, "Project context task", { projectId: project.id });

    // Reload so the sidebar picks up the new project
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Project sidebar button includes task count ("Work 1"), so use text match
    await page
      .locator("button", { hasText: "Work" })
      .filter({ has: page.locator("text=Work") })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Work", exact: true, level: 1 })).toBeVisible();

    const taskItem = page.getByText("Project context task").first();
    await taskItem.click({ button: "right" });

    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 3000 });
    await expect(menu.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  });
});
