import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi } from "./helpers.js";

test.describe("Search modal", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("opens with keyboard shortcut", async ({ page }) => {
    await page.keyboard.press("Control+f");

    const dialog = page.getByRole("dialog", { name: "Search tasks" });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(page.getByPlaceholder("Search tasks...")).toBeFocused();
  });

  test("finds task by title", async ({ page }) => {
    await createTaskViaApi(page, "Unique searchable task");
    await createTaskViaApi(page, "Another task here");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.keyboard.press("Control+f");
    await expect(page.getByRole("dialog", { name: "Search tasks" })).toBeVisible();

    await page.getByPlaceholder("Search tasks...").fill("searchable");

    // Should show the matching task
    await expect(page.getByText("Unique searchable task").first()).toBeVisible({ timeout: 5000 });
    // Should not show the non-matching task
    await expect(
      page.getByRole("dialog", { name: "Search tasks" }).getByText("Another task here"),
    ).not.toBeVisible();
  });

  test("shows empty results message", async ({ page }) => {
    await page.keyboard.press("Control+f");
    await expect(page.getByRole("dialog", { name: "Search tasks" })).toBeVisible();

    await page.getByPlaceholder("Search tasks...").fill("nonexistent xyz");

    await expect(page.getByText("No tasks found")).toBeVisible({ timeout: 5000 });
  });

  test("clicking result opens task detail", async ({ page }) => {
    await createTaskViaApi(page, "Clickable search result");
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.keyboard.press("Control+f");
    await page.getByPlaceholder("Search tasks...").fill("Clickable");

    // Click the search result
    await page.getByRole("option").first().click();

    // Task detail panel should open
    await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible({ timeout: 5000 });
  });
});
