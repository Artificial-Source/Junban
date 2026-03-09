import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi } from "./helpers";

test.describe("Dopamine Menu (Quick Wins)", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("navigates to Quick Wins via sidebar", async ({ page }) => {
    await page.getByRole("button", { name: "Quick Wins", exact: true }).click();
    await expect(page.getByText("Need a quick win? Pick one!")).toBeVisible({ timeout: 5000 });
  });

  test("shows quick win tasks matching filter criteria", async ({ page }) => {
    // Create tasks: one quick (5min), one easy (p4), one hard (60min p1)
    await createTaskViaApi(page, "Quick 5min task", { estimatedMinutes: 5 });
    await createTaskViaApi(page, "Easy p4 task", { priority: 4 });
    await createTaskViaApi(page, "Hard 60min p1 task", {
      estimatedMinutes: 60,
      priority: 1,
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "Quick Wins", exact: true }).click();
    await expect(page.getByText("Quick 5min task")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Easy p4 task")).toBeVisible();
    // Hard task should NOT appear
    await expect(page.getByText("Hard 60min p1 task")).not.toBeVisible();
  });

  test("shows empty state when no quick wins", async ({ page }) => {
    // Create only hard tasks
    await createTaskViaApi(page, "Hard task", {
      estimatedMinutes: 60,
      priority: 1,
    });

    await page.getByRole("button", { name: "Quick Wins", exact: true }).click();
    await expect(
      page.getByText("No quick wins right now. You're tackling the hard stuff!"),
    ).toBeVisible({ timeout: 5000 });
  });
});
