import { test, expect } from "@playwright/test";
import { setupPage } from "./helpers.js";

test.describe("Keyboard chord navigation", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
    await page.waitForTimeout(250);
  });

  test("g then t navigates to Today view", async ({ page }) => {
    // Start from Inbox (verified by setupPage)
    await expect(page.getByText("Inbox").first()).toBeVisible();

    // Press "g" then "t" to navigate to Today
    await page.keyboard.press("g");
    await page.keyboard.press("t");

    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  });

  test("g then u navigates to Upcoming view", async ({ page }) => {
    // Press "g" then "u" to navigate to Upcoming
    await page.keyboard.press("g");
    await page.keyboard.press("u");

    await expect(page.getByRole("heading", { name: "Upcoming", level: 1 })).toBeVisible();
  });

  test("g then i navigates back to Inbox", async ({ page }) => {
    // First navigate away from Inbox
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();

    // Now press "g" then "i" to go back to Inbox
    await page.keyboard.press("g");
    await page.keyboard.press("i");

    await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  });

  test("g then s navigates to Stats view", async ({ page }) => {
    await page.keyboard.press("g");
    await page.keyboard.press("s");

    await expect(page.getByRole("heading", { name: "Productivity", level: 1 })).toBeVisible();
  });

  test("full chord sequence: Inbox -> Today -> Upcoming -> Inbox", async ({ page }) => {
    // Inbox -> Today
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();

    // Today -> Upcoming
    await page.keyboard.press("g");
    await page.keyboard.press("u");
    await expect(page.getByRole("heading", { name: "Upcoming", level: 1 })).toBeVisible();

    // Upcoming -> Inbox
    await page.keyboard.press("g");
    await page.keyboard.press("i");
    await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  });

  test("chord indicator shows when g is pressed alone", async ({ page }) => {
    // The ChordIndicator shows a floating pill with the pending chord key
    // Press "g" to start a chord sequence
    await page.keyboard.press("g");

    // Look for the chord indicator containing the "G" key display
    // The indicator renders a <kbd> element with the chord letter uppercased
    const indicator = page.locator("kbd", { hasText: "G" });
    await expect(indicator).toBeVisible({ timeout: 2000 });

    // The chord indicator should disappear after the timeout (1.5s)
    await expect(indicator).not.toBeVisible({ timeout: 3000 });
  });

  test("chords do not fire when typing in an input field", async ({ page }) => {
    // Click on the task input field
    const input = page.getByPlaceholder(/Add a task/i);
    await input.click();

    // Type "g" then "t" inside the input -- should NOT navigate
    await input.press("g");
    await input.press("t");

    // Should still be on Inbox (not Today)
    await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  });

  test("disabling feature_chords prevents chord navigation", async ({ page }) => {
    // Disable chords via the settings API
    await page.request.put("/api/settings/feature_chords", {
      data: { value: "false" },
    });

    // Reload the page to pick up the setting (page will start at Inbox)
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Navigate to Today via sidebar click (not via chord)
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible({
      timeout: 5000,
    });

    // Now try the chord g+i to go back to Inbox (should NOT work since chords are disabled)
    await page.keyboard.press("g");
    await page.waitForTimeout(200);
    await page.keyboard.press("i");
    await page.waitForTimeout(1000);

    // Should still be on Today since chords are disabled
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();

    // Re-enable chords for cleanup
    await page.request.put("/api/settings/feature_chords", {
      data: { value: "true" },
    });
  });
});
