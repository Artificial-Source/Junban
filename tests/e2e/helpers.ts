import { type Page, expect } from "@playwright/test";

/**
 * Dismiss the onboarding modal by clicking "Skip", then wait for the
 * main UI to be ready.  Also marks onboarding_completed via the API so
 * subsequent navigations within the same browser context won't show it again.
 */
export async function dismissOnboarding(page: Page) {
  // Mark completed via API so it doesn't reappear on page refreshes
  await page.request.put("/api/settings/onboarding_completed", {
    data: { value: "true" },
  });

  // If the modal is already visible, click Skip
  const skip = page.getByRole("button", { name: "Skip" });
  if (await skip.isVisible({ timeout: 2000 }).catch(() => false)) {
    await skip.click();
  }
}

/** Navigate to a view via the sidebar. */
export async function navigateTo(page: Page, viewLabel: string) {
  await page.getByRole("button", { name: viewLabel, exact: true }).click();
}

/** Create a task using the task input field. */
export async function createTask(page: Page, text: string) {
  const input = page.getByPlaceholder(/Add a task/i);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
  // Wait for the task to appear in the list
  await expect(page.getByText(text.replace(/\s*[#~!@+p]\S*/g, "").trim()).first()).toBeVisible({
    timeout: 5000,
  });
}

/** Open settings modal and navigate to a specific tab. */
export async function openSettings(page: Page, tab?: string) {
  await page.getByRole("button", { name: "Settings" }).click();
  if (tab) {
    await page.getByRole("button", { name: tab, exact: true }).click();
  }
}

/** Close the settings modal. */
export async function closeSettings(page: Page) {
  await page.getByLabel("Close settings").click();
}

/** Open a task's detail panel by clicking on its title. */
export async function openTaskDetail(page: Page, title: string) {
  await page.getByText(title, { exact: true }).first().click();
  // Wait for the detail panel to appear
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible({ timeout: 5000 });
}

/** Close the task detail panel. */
export async function closeTaskDetail(page: Page) {
  await page.getByRole("dialog", { name: "Task details" }).getByLabel("Close").click();
}

/** Reset all feature flags to their default enabled state. */
export async function resetFeatureFlags(page: Page) {
  const flags = [
    "feature_comments",
    "feature_duration",
    "feature_deadlines",
    "feature_sections",
    "feature_kanban",
    "feature_chords",
    "feature_someday",
    "feature_cancelled",
    "feature_stats",
  ];
  await Promise.all(
    flags.map((flag) => page.request.put(`/api/settings/${flag}`, { data: { value: "true" } })),
  );
}

/** Navigate to a fresh page and dismiss onboarding. */
export async function setupPage(page: Page) {
  await page.goto("/");
  // Reset the database so each test starts with a clean slate
  await page.request.post("/api/test-reset");
  await page.reload();
  await dismissOnboarding(page);
  await resetFeatureFlags(page);
  // Wait for the main content to render
  await expect(page.getByText("Inbox").first()).toBeVisible({ timeout: 10000 });
}

/** Create a project via API. */
export async function createProjectViaApi(
  page: Page,
  name: string,
  opts?: { color?: string; viewStyle?: string },
) {
  const response = await page.request.post("/api/projects", {
    data: {
      name,
      color: opts?.color ?? "#3b82f6",
      viewStyle: opts?.viewStyle ?? "list",
    },
  });
  return response.json();
}

/** Create a task via API (bypasses the UI). Returns the created task. */
export async function createTaskViaApi(
  page: Page,
  title: string,
  opts?: {
    dueDate?: string;
    priority?: number;
    projectId?: string;
    estimatedMinutes?: number;
    deadline?: string;
    isSomeday?: boolean;
    tags?: string[];
  },
) {
  const response = await page.request.post("/api/tasks", {
    data: {
      title,
      dueTime: false,
      tags: opts?.tags ?? [],
      ...opts,
    },
  });
  return response.json();
}

/** Complete a task via API. */
export async function completeTaskViaApi(page: Page, taskId: string) {
  await page.request.post(`/api/tasks/${taskId}/complete`);
}

/** Update a task via API. */
export async function updateTaskViaApi(
  page: Page,
  taskId: string,
  changes: Record<string, unknown>,
) {
  await page.request.patch(`/api/tasks/${taskId}`, { data: changes });
}
