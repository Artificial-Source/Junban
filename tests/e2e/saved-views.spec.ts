import { test, expect } from "@playwright/test";
import { setupPage, createTaskViaApi, navigateTo } from "./helpers.js";

test.describe("Saved views / filters", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("create a saved filter", async ({ page }) => {
    await navigateTo(page, "Filters & Labels");

    // Click the "Add filter" button
    await page.getByRole("button", { name: /Add filter/i }).click();

    // Fill in the filter name and query
    await page.getByPlaceholder(/name/i).fill("Urgent");
    await page.getByPlaceholder(/query/i).fill("p1");

    // Save the filter (button text is "Add")
    await page.getByRole("button", { name: "Add", exact: true }).click();

    // Assert it appears in the list
    await expect(page.getByText("Urgent")).toBeVisible();
  });

  test("saved filter in sidebar", async ({ page }) => {
    // Create a filter via the API settings directly
    await page.request.put("/api/settings/saved_filters", {
      data: {
        value: JSON.stringify([{ id: "test-filter-1", name: "My P1 Tasks", query: "p1" }]),
      },
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Check sidebar has "My Views" section and the filter name (use first() for desktop sidebar)
    const sidebar = page.locator("aside[aria-label='Main navigation']").first();
    await expect(sidebar.getByText("My Views")).toBeVisible({ timeout: 5000 });
    await expect(sidebar.getByText("My P1 Tasks")).toBeVisible();
  });

  test("click filter navigates to filtered view", async ({ page }) => {
    // Create a task with priority 1
    await createTaskViaApi(page, "Critical priority task", { priority: 1 });
    await createTaskViaApi(page, "Low priority task", { priority: 4 });

    // Create a saved filter
    await page.request.put("/api/settings/saved_filters", {
      data: {
        value: JSON.stringify([{ id: "sidebar-filter", name: "P1 Filter", query: "p1" }]),
      },
    });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Click the filter in the sidebar (use first() for desktop sidebar)
    const sidebar = page.locator("aside[aria-label='Main navigation']").first();
    await sidebar.getByText("P1 Filter").click();

    // URL should contain /filter/
    await expect(page).toHaveURL(/#\/filter\//);

    // The filtered view should show the matching task
    await expect(page.getByText("Critical priority task")).toBeVisible({ timeout: 5000 });
  });

  test("persists across reload", async ({ page }) => {
    await navigateTo(page, "Filters & Labels");

    // Click the "Add filter" button
    await page.getByRole("button", { name: /Add filter/i }).click();

    // Fill in and save
    await page.getByPlaceholder(/name/i).fill("Persisted Filter");
    await page.getByPlaceholder(/query/i).fill("due today");
    await page.getByRole("button", { name: "Add", exact: true }).click();

    // Verify in the main content area (avoid sidebar duplicates)
    await expect(page.getByText("Persisted Filter").first()).toBeVisible();

    // Reload
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    await navigateTo(page, "Filters & Labels");

    // Still there
    await expect(page.getByText("Persisted Filter").first()).toBeVisible({ timeout: 5000 });
  });
});
