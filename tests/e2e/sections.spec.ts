import { test, expect } from "@playwright/test";
import { setupPage, createProjectViaApi, navigateTo } from "./helpers.js";

test.describe("Project sections", () => {
  let _projectId: string;

  test.beforeEach(async ({ page }) => {
    await setupPage(page);

    // Create a fresh project via API
    const project = await createProjectViaApi(page, "Work");
    _projectId = project.id;

    // Reload so the sidebar picks up the new project
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
  });

  test("can create a section via the Add section button", async ({ page }) => {
    // Navigate to the project in the sidebar
    await navigateTo(page, "Work");
    await expect(page.getByRole("heading", { name: "Work", exact: true, level: 1 })).toBeVisible();

    // Look for the "Add section" button
    const addSectionBtn = page.getByRole("button", { name: /Add section/i });
    await expect(addSectionBtn).toBeVisible({ timeout: 5000 });

    // Click to start adding a section
    await addSectionBtn.click();

    // Type the section name in the input that appears
    const sectionInput = page.getByPlaceholder("Section name...");
    await expect(sectionInput).toBeVisible();
    await sectionInput.fill("Design");

    // Confirm by pressing Enter
    await sectionInput.press("Enter");

    // Verify the section header "Design" appears
    await expect(page.getByText("Design").first()).toBeVisible({ timeout: 5000 });
  });

  test("can create multiple sections", async ({ page }) => {
    await navigateTo(page, "Work");

    // Create first section: "Design"
    const addSectionBtn = page.getByRole("button", { name: /Add section/i });
    await expect(addSectionBtn).toBeVisible({ timeout: 5000 });
    await addSectionBtn.click();

    const sectionInput = page.getByPlaceholder("Section name...");
    await sectionInput.fill("Design");
    await sectionInput.press("Enter");
    await expect(page.getByText("Design").first()).toBeVisible({ timeout: 5000 });

    // Create second section: "Development"
    // The add section button should reappear after the first section is created
    const addSectionBtn2 = page.getByRole("button", { name: /Add section/i });
    await expect(addSectionBtn2).toBeVisible({ timeout: 5000 });
    await addSectionBtn2.click();

    const sectionInput2 = page.getByPlaceholder("Section name...");
    await sectionInput2.fill("Development");
    await sectionInput2.press("Enter");

    // Verify both sections appear
    await expect(page.getByText("Design").first()).toBeVisible();
    await expect(page.getByText("Development").first()).toBeVisible();
  });

  test("can cancel section creation with Escape", async ({ page }) => {
    await navigateTo(page, "Work");

    const addSectionBtn = page.getByRole("button", { name: /Add section/i });
    await expect(addSectionBtn).toBeVisible({ timeout: 5000 });
    await addSectionBtn.click();

    const sectionInput = page.getByPlaceholder("Section name...");
    await expect(sectionInput).toBeVisible();
    await sectionInput.fill("Cancelled Section");

    // Press Escape to cancel
    await sectionInput.press("Escape");

    // The input should disappear and the "Add section" button should return
    await expect(sectionInput).not.toBeVisible();
    await expect(page.getByRole("button", { name: /Add section/i })).toBeVisible();

    // The cancelled section name should not appear as a section header
    await expect(page.getByText("Cancelled Section")).not.toBeVisible();
  });

  test("can confirm section creation with the check button", async ({ page }) => {
    await navigateTo(page, "Work");

    const addSectionBtn = page.getByRole("button", { name: /Add section/i });
    await expect(addSectionBtn).toBeVisible({ timeout: 5000 });
    await addSectionBtn.click();

    const sectionInput = page.getByPlaceholder("Section name...");
    await sectionInput.fill("QA");

    // Click the confirm button (check icon)
    const confirmBtn = page.getByLabel("Confirm add section");
    await confirmBtn.click();

    await expect(page.getByText("QA").first()).toBeVisible({ timeout: 5000 });
  });

  test("disabling feature_sections hides section UI", async ({ page }) => {
    // First navigate to project and verify Add section is visible
    await navigateTo(page, "Work");
    await expect(page.getByRole("button", { name: /Add section/i })).toBeVisible({ timeout: 5000 });

    // Disable sections via the API
    await page.request.put("/api/settings/feature_sections", {
      data: { value: "false" },
    });

    // Reload and navigate back to the project
    await page.reload();
    await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
    await navigateTo(page, "Work");

    // The "Add section" button should no longer appear
    await expect(page.getByRole("button", { name: /Add section/i })).not.toBeVisible({
      timeout: 3000,
    });

    // Re-enable for cleanup
    await page.request.put("/api/settings/feature_sections", {
      data: { value: "true" },
    });
  });
});
