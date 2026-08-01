import { expect, test, type Page } from "@playwright/test";
import { appUrlWithToken, startServer, type ServerContext } from "./fixtures";
import { seedPhase3Workspace, type SeededPhase3Workspace } from "./phase3-seed";

let server: ServerContext;
let workspace: SeededPhase3Workspace;

const RICH_TASK_TITLE = "Ship v1.1 release documentation";

async function authenticate(page: Page, path = "/today"): Promise<void> {
  await page.goto(appUrlWithToken(server.baseUrl, server.token, path));
  await page.locator("main").waitFor({ state: "visible" });
}

async function apiJson<T>(path: string): Promise<T> {
  const response = await fetch(`${server.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${server.token}`,
      Origin: server.baseUrl,
    },
  });
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as T;
}

test.beforeAll(async () => {
  server = await startServer({ seed: false });
  workspace = await seedPhase3Workspace(server.baseUrl, server.token);
});

test.afterAll(async () => {
  await server.cleanup();
});

test("task details persist recurrence and reminder changes through Rust APIs", async ({ page }) => {
  await authenticate(page);

  await page.getByRole("button", { name: `Edit task: ${RICH_TASK_TITLE}` }).click();
  const details = page.getByRole("dialog", { name: `Task: ${RICH_TASK_TITLE}` });

  await details.getByText("Weekly", { exact: true }).click();
  await page
    .getByRole("dialog", { name: "Recurrence" })
    .getByRole("button", {
      name: "Monthly",
    })
    .click();
  await details.getByRole("button", { name: "Save" }).click();

  await details.getByRole("button", { name: "Edit reminder" }).click();
  await details.getByRole("textbox", { name: "Edit reminder time" }).fill("2026-12-16T10:00");
  await details.getByRole("button", { name: "Schedule" }).click();
  await expect(details.getByRole("button", { name: "Edit reminder" })).toBeVisible();

  const task = await apiJson<{ recurrence_rule: string | null; remind_at: string | null }>(
    `/api/v1/tasks/${workspace.richTaskId}`,
  );
  expect(task.recurrence_rule).toBe("monthly");
  expect(task.remind_at).toContain("2026-12-16");
});

test("daily planning, daily review, and weekly review are keyboard-reachable rituals", async ({
  page,
}) => {
  await authenticate(page);

  await page.getByRole("button", { name: "Plan My Day" }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (let step = 0; step < 3; step += 1) {
    await dialog.getByRole("button", { name: "Next" }).click();
  }
  await dialog.getByRole("button", { name: "Start My Day" }).click();
  await expect(dialog).not.toBeVisible();

  await page.getByRole("button", { name: "End of Day" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Skip" }).click();
  await expect(dialog).not.toBeVisible();

  await page.getByRole("button", { name: "Weekly Review" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).not.toBeVisible();
});

test("timeblocking schedules a task and exposes the durable block", async ({ page }) => {
  await authenticate(page, "/timeblocking");
  const title = "Prepare community call agenda";

  const before = await apiJson<{ time_blocks: Array<{ task_id: string | null }> }>(
    "/api/v1/time-blocks",
  );
  const scheduleButton = page.getByRole("button", { name: `Add ${title} to the schedule` });
  await scheduleButton.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "Add time block" });
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Save" }).click();

  await expect
    .poll(async () => {
      const after = await apiJson<{ time_blocks: Array<{ task_id: string | null }> }>(
        "/api/v1/time-blocks",
      );
      return after.time_blocks.length;
    })
    .toBe(before.time_blocks.length + 1);
});
