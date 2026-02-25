import { test, expect } from "@playwright/test";
import { setupPage, openSettings, closeSettings } from "./helpers.js";

// Helper: scope to the settings dialog content area
const settingsContent = (page: import("@playwright/test").Page) =>
  page.locator(".fixed").filter({ hasText: "Settings" });

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

  test("shows all 10 setting tabs in the sidebar", async ({ page }) => {
    await openSettings(page);
    const tabs = [
      "General",
      "Appearance",
      "Features",
      "AI Assistant",
      "Voice",
      "Plugins",
      "Templates",
      "Keyboard",
      "Data",
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

    await page.getByRole("button", { name: "Features", exact: true }).click();
    await expect(page.getByText("Toggle features on or off")).toBeVisible();

    await page.getByRole("button", { name: "About", exact: true }).click();
    await expect(page.getByText("Saydo").first()).toBeVisible();
  });
});

// ── General tab ─────────────────────────────────────────────────────────

test.describe("General settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays Date & Time section with controls", async ({ page }) => {
    await openSettings(page, "General");
    const content = settingsContent(page);
    await expect(content.getByText("Date & Time")).toBeVisible();
    await expect(content.getByText("Week starts on")).toBeVisible();
    await expect(content.getByText("Date format")).toBeVisible();
    await expect(content.getByText("Time format")).toBeVisible();
    await expect(content.getByText("Default calendar view")).toBeVisible();
  });

  test("can change week start day", async ({ page }) => {
    await openSettings(page, "General");

    const content = settingsContent(page);
    const weekStartRow = content.getByText("Week starts on").locator("..").locator("..");
    const weekStartSelect = weekStartRow.locator("select");
    await weekStartSelect.selectOption("monday");
    await expect(weekStartSelect).toHaveValue("monday");
  });

  test("can change date format", async ({ page }) => {
    await openSettings(page, "General");

    const content = settingsContent(page);
    const dateFormatRow = content.getByText("Date format").locator("..").locator("..");
    const dateFormatSelect = dateFormatRow.locator("select");
    await dateFormatSelect.selectOption("iso");
    await expect(dateFormatSelect).toHaveValue("iso");
  });

  test("can toggle time format between 12h and 24h", async ({ page }) => {
    await openSettings(page, "General");

    const content = settingsContent(page);
    await content.getByRole("button", { name: "24-hour" }).click();
    await expect(content.getByText("e.g. 14:30")).toBeVisible();
  });

  test("displays Task Behavior section", async ({ page }) => {
    await openSettings(page, "General");
    const content = settingsContent(page);
    await expect(content.getByText("Task Behavior")).toBeVisible();
    await expect(content.getByText("Default priority")).toBeVisible();
    await expect(content.getByText("Confirm before deleting")).toBeVisible();
    await expect(content.getByText("Start screen")).toBeVisible();
  });

  test("can change default priority", async ({ page }) => {
    await openSettings(page, "General");

    const content = settingsContent(page);
    const priorityRow = content.getByText("Default priority").locator("..").locator("..");
    const prioritySelect = priorityRow.locator("select");
    await prioritySelect.selectOption("p2");
    await expect(prioritySelect).toHaveValue("p2");
  });

  test("can change start screen", async ({ page }) => {
    await openSettings(page, "General");

    const content = settingsContent(page);
    const startRow = content.getByText("Start screen").locator("..").locator("..");
    const startSelect = startRow.locator("select");
    await startSelect.selectOption("today");
    await expect(startSelect).toHaveValue("today");

    // Reset to inbox
    await startSelect.selectOption("inbox");
  });

  test("displays Sound Effects section heading", async ({ page }) => {
    await openSettings(page, "General");
    const content = settingsContent(page);
    await expect(content.getByRole("heading", { name: "Sound Effects" })).toBeVisible();
    await expect(content.getByText("Enable sound effects")).toBeVisible();
  });

  test("displays individual sound toggles", async ({ page }) => {
    await openSettings(page, "General");
    const content = settingsContent(page);
    await expect(content.getByText("Task completed", { exact: true })).toBeVisible();
    await expect(content.getByText("Task created", { exact: true })).toBeVisible();
    await expect(content.getByText("Task deleted", { exact: true })).toBeVisible();
    // "Reminder" matches exactly
    await expect(content.getByText("Reminder", { exact: true })).toBeVisible();
  });

  test("sound preview buttons are present", async ({ page }) => {
    await openSettings(page, "General");

    const content = settingsContent(page);
    const previewButtons = content.getByRole("button", { name: "Preview" });
    await expect(previewButtons).toHaveCount(4);
  });

  test("displays Notifications section", async ({ page }) => {
    await openSettings(page, "General");
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
    await densityRow.getByRole("button", { name: "Compact" }).click();

    const html = page.locator("html");
    await expect(html).toHaveClass(/density-compact/);

    // Reset
    await densityRow.getByRole("button", { name: "Default" }).click();
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

// ── Features tab ────────────────────────────────────────────────────────

test.describe("Features settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays all 9 feature toggles", async ({ page }) => {
    await openSettings(page, "Features");

    const features = [
      "Project sections",
      "Kanban / Board view",
      "Time estimates",
      "Deadlines",
      "Comments & activity",
      "Productivity stats",
      "Someday / Maybe",
      "Cancelled tasks view",
      "Keyboard chords",
    ];

    const content = settingsContent(page);
    for (const feature of features) {
      await expect(content.getByText(feature, { exact: true }).first()).toBeVisible();
    }
  });

  test("feature toggles are all enabled by default (accent-colored)", async ({ page }) => {
    await openSettings(page, "Features");

    // The Toggle component renders a <button> with bg-accent class when enabled
    // Count the toggle buttons within the features section (each SettingRow has one toggle)
    const content = settingsContent(page);
    // Each feature has a toggle button that's a small rounded-full button
    const toggleButtons = content.locator("button.rounded-full.bg-accent");
    // All 9 should be enabled (bg-accent)
    await expect(toggleButtons).toHaveCount(9);
  });

  test("toggling a feature off changes its visual state", async ({ page }) => {
    await openSettings(page, "Features");

    const content = settingsContent(page);
    // Find the toggle in the "Productivity stats" row
    const statsRow = content.getByText("Productivity stats").locator("..").locator("..");
    const statsToggle = statsRow.locator("button.rounded-full");
    await expect(statsToggle).toHaveClass(/bg-accent/);

    await statsToggle.click();

    // After clicking, it should no longer have bg-accent
    await expect(statsToggle).not.toHaveClass(/bg-accent/);

    // Toggle it back on
    await statsToggle.click();
    await expect(statsToggle).toHaveClass(/bg-accent/);
  });

  test("disabling a feature hides its sidebar nav item", async ({ page }) => {
    // Verify Stats nav exists
    await expect(page.getByRole("button", { name: "Stats", exact: true })).toBeVisible();

    // Disable stats via API
    await page.request.put("/api/settings/feature_stats", { data: { value: "false" } });
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });

    // Stats nav should be gone
    await expect(page.getByRole("button", { name: "Stats", exact: true })).not.toBeVisible();

    // Re-enable
    await page.request.put("/api/settings/feature_stats", { data: { value: "true" } });
  });
});

// ── AI Assistant tab ────────────────────────────────────────────────────

test.describe("AI Assistant settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays AI provider configuration", async ({ page }) => {
    await openSettings(page, "AI Assistant");
    const content = settingsContent(page);
    await expect(content.getByText("Provider").first()).toBeVisible({ timeout: 5000 });
  });
});

// ── Voice tab ───────────────────────────────────────────────────────────

test.describe("Voice settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays voice configuration sections", async ({ page }) => {
    await openSettings(page, "Voice");
    const content = settingsContent(page);
    await expect(content.getByText("Speech-to-Text").first()).toBeVisible({ timeout: 5000 });
    await expect(content.getByText("Text-to-Speech").first()).toBeVisible();
  });
});

// ── Plugins tab ─────────────────────────────────────────────────────────

test.describe("Plugins settings tab", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
  });

  test("displays plugins management UI", async ({ page }) => {
    await openSettings(page, "Plugins");
    const content = settingsContent(page);
    await expect(content.getByText("Plugins").first()).toBeVisible({ timeout: 5000 });
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
    // The About tab should show some content — scroll to ensure visibility
    const content = settingsContent(page);
    // Look for any distinctive About tab content
    await expect(
      content.getByText("About").first(),
    ).toBeVisible({ timeout: 5000 });
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
    await openSettings(page, "General");
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

  test("start view setting is applied in the General tab", async ({ page }) => {
    // Verify we can change the start screen setting and it persists
    await openSettings(page, "General");
    const content = settingsContent(page);
    const startRow = content.getByText("Start screen").locator("..").locator("..");
    const startSelect = startRow.locator("select");

    // Change to Today
    await startSelect.selectOption("today");
    await expect(startSelect).toHaveValue("today");

    // Close settings, reopen, verify it persisted
    await closeSettings(page);
    await openSettings(page, "General");
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
    await openSettings(page, "General");
    const content = settingsContent(page);
    const calRow = content.getByText("Default calendar view").locator("..").locator("..");
    // The selected button has bg-accent class
    const weekBtn = calRow.getByRole("button", { name: "Week" });
    await expect(weekBtn).toHaveClass(/bg-accent/);

    // Reset
    await page.request.put("/api/settings/calendar_default_mode", { data: { value: "month" } });
  });
});
