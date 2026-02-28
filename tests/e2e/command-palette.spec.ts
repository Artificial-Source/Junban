import { test, expect } from "@playwright/test";
import { setupPage } from "./helpers.js";

test.describe("Command palette", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("opens with Ctrl+K", async ({ page }) => {
    await page.keyboard.press("Control+k");

    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(page.getByPlaceholder("Type a command...")).toBeFocused();
  });

  test("filters commands by text", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();

    await page.getByPlaceholder("Type a command...").fill("today");

    // Should show a "Go to Today" or similar command
    const resultList = page.locator("#command-palette-list");
    await expect(resultList.getByRole("option").first()).toBeVisible({ timeout: 5000 });
  });

  test("navigates via Enter selection", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();

    await page.getByPlaceholder("Type a command...").fill("today");

    // Wait for filtered results
    await expect(page.locator("#command-palette-list").getByRole("option").first()).toBeVisible({ timeout: 5000 });

    // Press Enter to execute the first command
    await page.keyboard.press("Enter");

    // Command palette should close
    await expect(page.getByRole("dialog", { name: "Command palette" })).not.toBeVisible();
  });

  test("shows empty filter message", async ({ page }) => {
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();

    await page.getByPlaceholder("Type a command...").fill("zzznonexistent");

    await expect(page.getByText("No matching commands")).toBeVisible({ timeout: 5000 });
  });
});
