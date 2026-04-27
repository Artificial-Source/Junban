import { test, expect } from "@playwright/test";
import { setupPage, openSettings, closeSettings } from "./helpers.js";

// Helper: scope to the settings dialog content area
const settingsContent = (page: import("@playwright/test").Page) =>
  page.locator(".flex-1.overflow-y-auto.p-6").last();

// ── Settings modal & navigation ─────────────────────────────────────────

test.describe("Settings modal", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("opens when clicking the Settings button", async ({ page }) => {
    await openSettings(page);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  });

  test("closes with the X button", async ({ page }) => {
    await openSettings(page);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await closeSettings(page);
    await expect(page.getByRole("heading", { name: "Settings" })).not.toBeVisible();
  });

  test("shows all setting tabs in the sidebar", async ({ page }) => {
    await openSettings(page);
    const tabs = [
      "Essentials",
      "Appearance",
      "Alerts",
      "Filters & Labels",
      "Keyboard",
      "Templates",
      "AI",
      "Agent Tools",
      "Data",
      "Advanced",
      "About",
    ];
    for (const tab of tabs) {
      await expect(page.getByRole("button", { name: tab, exact: true })).toBeVisible();
    }
  });

  test("can navigate between tabs", async ({ page }) => {
    await openSettings(page);

    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(page.getByText("Color scheme")).toBeVisible();

    await page.getByRole("button", { name: "Filters & Labels", exact: true }).click();
    await expect(page.getByText("My Filters")).toBeVisible();

    await page.getByRole("button", { name: "Alerts", exact: true }).click();
    await expect(page.getByText("Alerts & Feedback")).toBeVisible();

    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(page.getByText("Feature flags and developer controls")).toBeVisible();

    await page.getByRole("button", { name: "About", exact: true }).click();
    await expect(page.getByText("Junban").first()).toBeVisible();
  });

  test("keeps dark settings form controls readable", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("junban-theme", "dark");
    });
    await page.reload();
    await openSettings(page, "Essentials");

    const content = settingsContent(page);
    const weekStartRow = content.getByText("Week starts on").locator("..").locator("..");
    const weekStartSelect = weekStartRow.locator("select");
    await expect(weekStartSelect).toBeVisible();

    const styles = await weekStartSelect.evaluate((element) => {
      const computed = window.getComputedStyle(element);
      return {
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        colorScheme: computed.colorScheme,
      };
    });

    expect(styles.color).not.toBe(styles.backgroundColor);
    expect(styles.colorScheme).toContain("dark");
  });
});

// ── Essentials tab ──────────────────────────────────────────────────────

test.describe("Essentials settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays Date & Time section with controls", async ({ page }) => {
    await openSettings(page, "Essentials");
    const content = settingsContent(page);
    await expect(content.getByText("Date & Time")).toBeVisible();
    await expect(content.getByText("Week starts on")).toBeVisible();
    await expect(content.getByText("Date format")).toBeVisible();
    await expect(content.getByText("Time format")).toBeVisible();
    await expect(content.getByText("Default calendar view")).toBeVisible();
  });

  test("can change week start day", async ({ page }) => {
    await openSettings(page, "Essentials");

    const content = settingsContent(page);
    const weekStartRow = content.getByText("Week starts on").locator("..").locator("..");
    const weekStartSelect = weekStartRow.locator("select");
    await weekStartSelect.selectOption("monday");
    await expect(weekStartSelect).toHaveValue("monday");
  });

  test("can change date format", async ({ page }) => {
    await openSettings(page, "Essentials");

    const content = settingsContent(page);
    const dateFormatRow = content.getByText("Date format").locator("..").locator("..");
    const dateFormatSelect = dateFormatRow.locator("select");
    await dateFormatSelect.selectOption("iso");
    await expect(dateFormatSelect).toHaveValue("iso");
  });

  test("can toggle time format between 12h and 24h", async ({ page }) => {
    await openSettings(page, "Essentials");

    const content = settingsContent(page);
    await content.getByRole("button", { name: "24-hour" }).click();
    await expect(content.getByText("e.g. 14:30")).toBeVisible();
  });

  test("displays Task Behavior section", async ({ page }) => {
    await openSettings(page, "Essentials");
    const content = settingsContent(page);
    await expect(content.getByText("Task Behavior")).toBeVisible();
    await expect(content.getByText("Default priority")).toBeVisible();
    await expect(content.getByText("Confirm before deleting")).toBeVisible();
    await expect(content.getByText("Start screen")).toBeVisible();
  });

  test("can change default priority", async ({ page }) => {
    await openSettings(page, "Essentials");

    const content = settingsContent(page);
    const priorityRow = content.getByText("Default priority").locator("..").locator("..");
    const prioritySelect = priorityRow.locator("select");
    await prioritySelect.selectOption("p2");
    await expect(prioritySelect).toHaveValue("p2");
  });

  test("can change start screen", async ({ page }) => {
    await openSettings(page, "Essentials");

    const content = settingsContent(page);
    const startRow = content.getByText("Start screen").locator("..").locator("..");
    const startSelect = startRow.locator("select");
    await startSelect.selectOption("today");
    await expect(startSelect).toHaveValue("today");

    // Reset to inbox
    await startSelect.selectOption("inbox");
  });
});

// ── Alerts tab ──────────────────────────────────────────────────────────

test.describe("Alerts settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays Sound Effects section heading", async ({ page }) => {
    await openSettings(page, "Alerts");
    const content = settingsContent(page);
    await expect(content.getByRole("heading", { name: "Sound Effects" })).toBeVisible();
    await expect(content.getByText("Enable sound effects")).toBeVisible();
  });

  test("displays individual sound toggles", async ({ page }) => {
    await openSettings(page, "Alerts");
    const content = settingsContent(page);
    await expect(content.getByText("Task completed", { exact: true })).toBeVisible();
    await expect(content.getByText("Task created", { exact: true })).toBeVisible();
    await expect(content.getByText("Task deleted", { exact: true })).toBeVisible();
    await expect(content.getByText("Reminder", { exact: true })).toBeVisible();
  });

  test("sound preview buttons are present", async ({ page }) => {
    await openSettings(page, "Alerts");

    const content = settingsContent(page);
    const previewButtons = content.getByRole("button", { name: "Preview" });
    await expect(previewButtons).toHaveCount(4);
  });

  test("displays Notifications section", async ({ page }) => {
    await openSettings(page, "Alerts");
    const content = settingsContent(page);
    await expect(content.getByRole("heading", { name: "Notifications" })).toBeVisible();
    await expect(content.getByText("Browser notifications", { exact: true })).toBeVisible();
    await expect(content.getByText("In-app toast notifications")).toBeVisible();
    await expect(content.getByText("Default reminder offset")).toBeVisible();
  });
});

// ── Appearance tab ──────────────────────────────────────────────────────

test.describe("Appearance settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays Theme section with color scheme options", async ({ page }) => {
    await openSettings(page, "Appearance");
    const content = settingsContent(page);
    await expect(content.getByText("Color scheme")).toBeVisible();

    // Theme SegmentedControl has System, Light, Dark, Nord
    const themeRow = content.getByText("Color scheme").locator("..").locator("..");
    await expect(themeRow.getByRole("button", { name: "Light" })).toBeVisible();
    await expect(themeRow.getByRole("button", { name: "Dark" })).toBeVisible();
    await expect(themeRow.getByRole("button", { name: "Nord" })).toBeVisible();
  });

  test("can switch to light theme", async ({ page }) => {
    await openSettings(page, "Appearance");
    const content = settingsContent(page);
    const themeRow = content.getByText("Color scheme").locator("..").locator("..");

    // First switch to dark, then to light to verify the transition
    await themeRow.getByRole("button", { name: "Dark" }).click();
    const html = page.locator("html");
    await expect(html).toHaveClass(/dark/);

    await themeRow.getByRole("button", { name: "Light" }).click();
    // Light theme = no "dark" class on html (light is the default state)
    await expect(html).not.toHaveClass(/dark/);
  });

  test("can switch to dark theme", async ({ page }) => {
    await openSettings(page, "Appearance");
    const content = settingsContent(page);
    const themeRow = content.getByText("Color scheme").locator("..").locator("..");
    await themeRow.getByRole("button", { name: "Dark" }).click();

    const html = page.locator("html");
    await expect(html).toHaveClass(/dark/);
  });

  test("displays accent color picker", async ({ page }) => {
    await openSettings(page, "Appearance");
    const content = settingsContent(page);
    await expect(content.getByText("Accent color")).toBeVisible();
  });

  test("displays Layout section with density, font size, font family", async ({ page }) => {
    await openSettings(page, "Appearance");
    const content = settingsContent(page);
    await expect(content.getByText("Layout").first()).toBeVisible();
    await expect(content.getByText("Density")).toBeVisible();
    await expect(content.getByText("Font size")).toBeVisible();
    await expect(content.getByText("Font family")).toBeVisible();
  });

  test("can change density", async ({ page }) => {
    await openSettings(page, "Appearance");
    const content = settingsContent(page);
    const densityRow = content.getByText("Density").locator("..").locator("..");
    const defaultButton = densityRow.getByRole("button", { name: "Default" });
    const defaultPadding = await defaultButton.evaluate((element) =>
      parseFloat(window.getComputedStyle(element).paddingTop),
    );
    await densityRow.getByRole("button", { name: "Compact" }).click();

    const html = page.locator("html");
    await expect(html).toHaveClass(/density-compact/);
    await expect
      .poll(async () =>
        densityRow
          .getByRole("button", { name: "Compact" })
          .evaluate((element) => parseFloat(window.getComputedStyle(element).paddingTop)),
      )
      .toBeLessThan(defaultPadding);

    // Reset
    await defaultButton.click();
  });

  test("can change font size", async ({ page }) => {
    await openSettings(page, "Appearance");
    const content = settingsContent(page);
    const fontSizeRow = content.getByText("Font size").locator("..").locator("..");
    await fontSizeRow.getByRole("button", { name: "Large" }).click();

    const html = page.locator("html");
    await expect(html).toHaveClass(/font-large/);

    // Reset
    await fontSizeRow.getByRole("button", { name: "Default" }).click();
  });

  test("can change font family", async ({ page }) => {
    await openSettings(page, "Appearance");
    const content = settingsContent(page);
    const fontRow = content.getByText("Font family").locator("..").locator("..");
    await fontRow.getByRole("button", { name: "Inter" }).click();

    // Font family is applied via inline CSS variable --font-sans on <html>
    const html = page.locator("html");
    await expect(html).toHaveCSS("--font-sans", /Inter/);

    // Reset
    await fontRow.getByRole("button", { name: "Outfit" }).click();
  });

  test("displays Accessibility section with reduce animations toggle", async ({ page }) => {
    await openSettings(page, "Appearance");
    const content = settingsContent(page);
    await expect(content.getByText("Accessibility").first()).toBeVisible();
    await expect(content.getByText("Reduce animations")).toBeVisible();
  });
});

// ── Advanced tab ────────────────────────────────────────────────────────

test.describe("Advanced settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays all feature toggles", async ({ page }) => {
    await openSettings(page, "Advanced");

    const features = [
      "Filters & Labels",
      "Project sections",
      "Kanban / Board view",
      "Time estimates",
      "Deadlines",
      "Comments & activity",
      "Eat the Frog",
      "Developer mode",
    ];

    const content = settingsContent(page);
    for (const feature of features) {
      await expect(content.getByText(feature, { exact: true }).first()).toBeVisible();
    }
  });

  test("feature toggles are all enabled by default (accent-colored)", async ({ page }) => {
    await openSettings(page, "Advanced");

    const content = settingsContent(page);
    const enabledByDefault = [
      "Filters & Labels",
      "Project sections",
      "Kanban / Board view",
      "Time estimates",
      "Deadlines",
      "Comments & activity",
      "Eat the Frog",
    ];

    for (const feature of enabledByDefault) {
      const toggle = content.locator(
        `xpath=.//p[normalize-space()='${feature}']/ancestor::div[contains(@class,'flex items-center justify-between')][1]//button`,
      );
      await expect(toggle).toHaveClass(/bg-accent/);
    }

    const developerToggle = content.locator(
      "xpath=.//p[normalize-space()='Developer mode']/ancestor::div[contains(@class,'flex items-center justify-between')][1]//button",
    );
    await expect(developerToggle).not.toHaveClass(/bg-accent/);
  });

  test("toggling a feature off changes its visual state", async ({ page }) => {
    await openSettings(page, "Advanced");

    const content = settingsContent(page);
    // Find the toggle in the "Project sections" row
    const sectionsToggle = content.locator(
      "xpath=.//p[normalize-space()='Project sections']/ancestor::div[contains(@class,'flex items-center justify-between')][1]//button",
    );
    await expect(sectionsToggle).toHaveClass(/bg-accent/);

    await sectionsToggle.click();

    // After clicking, it should no longer have bg-accent
    await expect(sectionsToggle).not.toHaveClass(/bg-accent/);

    // Toggle it back on
    await sectionsToggle.click();
    await expect(sectionsToggle).toHaveClass(/bg-accent/);
  });

  test("developer mode can be enabled", async ({ page }) => {
    await openSettings(page, "Advanced");

    const content = settingsContent(page);
    const developerToggle = content.locator(
      "xpath=.//p[normalize-space()='Developer mode']/ancestor::div[contains(@class,'flex items-center justify-between')][1]//button",
    );

    await expect(developerToggle).not.toHaveClass(/bg-accent/);
    await developerToggle.click();
    await expect(developerToggle).toHaveClass(/bg-accent/);
  });
});

// ── AI tab ───────────────────────────────────────────────────────────────

test.describe("AI settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays AI provider configuration", async ({ page }) => {
    await openSettings(page, "AI");
    const content = settingsContent(page);
    await expect(content.getByText("Provider").first()).toBeVisible({ timeout: 5000 });
  });
});

// ── Templates tab ───────────────────────────────────────────────────────

test.describe("Templates settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays templates management UI", async ({ page }) => {
    await openSettings(page, "Templates");
    const content = settingsContent(page);
    await expect(content.getByText("Templates").first()).toBeVisible({ timeout: 5000 });
  });
});

// ── Keyboard tab ────────────────────────────────────────────────────────

test.describe("Keyboard settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays keyboard shortcuts", async ({ page }) => {
    await openSettings(page, "Keyboard");
    const content = settingsContent(page);
    await expect(content.getByText("Keyboard").first()).toBeVisible({ timeout: 5000 });
  });
});

// ── Data tab ────────────────────────────────────────────────────────────

test.describe("Data settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays data management options", async ({ page }) => {
    await openSettings(page, "Data");
    const content = settingsContent(page);
    await expect(content.getByText("Export").first()).toBeVisible({ timeout: 5000 });
  });
});

// ── About tab ───────────────────────────────────────────────────────────

test.describe("About settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays app info", async ({ page }) => {
    await openSettings(page, "About");
    const content = settingsContent(page);
    await expect(content.getByText("Junban").first()).toBeVisible({ timeout: 5000 });
    await expect(content.getByText("Open Source Credits")).toBeVisible();
    await expect(content.getByText("Feedback")).toBeVisible();
  });
});

// ── Settings persistence ────────────────────────────────────────────────

test.describe("Settings persistence", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("general settings persist across page reloads", async ({ page }) => {
    // Set time format to 24h via API
    await page.request.put("/api/settings/time_format", { data: { value: "24h" } });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Verify the setting persisted
    await openSettings(page, "Essentials");
    const content = settingsContent(page);
    await expect(content.getByText("e.g. 14:30")).toBeVisible();

    // Reset
    await page.request.put("/api/settings/time_format", { data: { value: "12h" } });
  });

  test("feature flag changes persist across reloads", async ({ page }) => {
    // Disable someday via API
    await page.request.put("/api/settings/feature_someday", { data: { value: "false" } });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Someday should be gone from sidebar
    await expect(page.getByRole("button", { name: "Someday", exact: true })).not.toBeVisible();

    // Re-enable
    await page.request.put("/api/settings/feature_someday", { data: { value: "true" } });
  });

  test("start view setting is applied in the Essentials tab", async ({ page }) => {
    // Verify we can change the start screen setting and it persists
    await openSettings(page, "Essentials");
    const content = settingsContent(page);
    const startRow = content.getByText("Start screen").locator("..").locator("..");
    const startSelect = startRow.locator("select");

    // Change to Today
    await startSelect.selectOption("today");
    await expect(startSelect).toHaveValue("today");

    // Close settings, reopen, verify it persisted
    await closeSettings(page);
    await openSettings(page, "Essentials");
    const content2 = settingsContent(page);
    const startRow2 = content2.getByText("Start screen").locator("..").locator("..");
    await expect(startRow2.locator("select")).toHaveValue("today");

    // Reset
    await startRow2.locator("select").selectOption("inbox");
  });

  test("default calendar mode persists", async ({ page }) => {
    // Set calendar default to "week"
    await page.request.put("/api/settings/calendar_default_mode", { data: { value: "week" } });

    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Verify via settings UI
    await openSettings(page, "Essentials");
    const content = settingsContent(page);
    const calRow = content.getByText("Default calendar view").locator("..").locator("..");
    // The selected button has bg-accent class
    const weekBtn = calRow.getByRole("button", { name: "Week" });
    await expect(weekBtn).toHaveClass(/bg-accent/);

    // Reset
    await page.request.put("/api/settings/calendar_default_mode", { data: { value: "month" } });
  });
});
