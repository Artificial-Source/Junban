import { test, expect, type Page } from "@playwright/test";
import { startServer, appUrlWithToken, type ServerContext } from "./fixtures";

let server: ServerContext;

test.beforeAll(async () => {
  server = await startServer({ seed: true });
});

test.afterAll(async () => {
  await server.cleanup();
});

test.beforeEach(async ({ page }) => {
  // Set the fixed browser clock to match the visual baseline
  await page.clock.setFixedTime(new Date("2026-07-23T10:30:00-07:00"));
  // Enable reduced motion
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia;
    window.matchMedia = (query: string) => ({
      ...matchMedia(query),
      matches: query === "(prefers-reduced-motion: reduce)" ? true : matchMedia(query).matches,
    });
  });
});

async function authenticate(page: Page): Promise<void> {
  await page.goto(appUrlWithToken(server.baseUrl, server.token, "/today"));
  // Wait for the app to load and authenticate
  await page.waitForSelector("h1", { timeout: 5000 });
}

test("fragment token is saved, URL token parts are scrubbed, and reload stays authenticated", async ({
  page,
}) => {
  await page.goto(
    `${server.baseUrl}/today?view=compact&access_token=ignored#access_token=${server.token}`,
  );
  await page.waitForSelector("h1");

  expect(page.url()).toContain("?view=compact");
  expect(page.url()).not.toContain("#access_token");
  expect(page.url()).not.toContain("access_token=ignored");

  const sessionToken = await page.evaluate(() => sessionStorage.getItem("junban-access-token"));
  expect(sessionToken).toBe(server.token);
  expect(await page.evaluate(() => localStorage.getItem("junban-access-token"))).toBeNull();

  await page.reload();
  await expect(page.locator("h1")).toBeVisible();
});

test("rejects malformed and query-only tokens while immediately scrubbing URL token parts", async ({
  browser,
}) => {
  for (const fragment of [
    "#access_token=",
    "#access_token=one&access_token=two",
    "#access_token=%E0%A4%A",
  ]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.baseUrl}/today?view=compact&access_token=ignored${fragment}`);

    await expect(page.getByText("No access token found")).toBeVisible();
    expect(page.url()).toContain("?view=compact");
    expect(page.url()).not.toContain("access_token");
    expect(await page.evaluate(() => sessionStorage.getItem("junban-access-token"))).toBeNull();
    await context.close();
  }
});

test("no-token state shows connection screen", async ({ page }) => {
  await page.goto(server.baseUrl + "/today");
  // Should show the connection screen, not the app
  await expect(page.locator("text=No access token found")).toBeVisible();
  // Should not show the app shell (no task input)
  await expect(page.getByPlaceholder("Add a task for today...")).not.toBeVisible();
});

test("same-page connection fragment authenticates without a forced reload", async ({ page }) => {
  await page.goto(server.baseUrl + "/today");
  await expect(page.getByText("No access token found")).toBeVisible();

  await page.evaluate((token) => {
    window.location.hash = `access_token=${encodeURIComponent(token)}`;
  }, server.token);

  await expect(page.getByPlaceholder("Add a task for today...")).toBeVisible();
  expect(page.url()).not.toContain("access_token");
  expect(await page.evaluate(() => sessionStorage.getItem("junban-access-token"))).toBe(
    server.token,
  );
});

test("authenticated CRUD: create, edit, complete, uncomplete, delete", async ({ page }) => {
  await authenticate(page);

  // Create a task
  await page.getByPlaceholder("Add a task for today...").fill("E2E test task");
  await page.getByPlaceholder("Add a task for today...").press("Enter");
  await expect(page.getByText("E2E test task")).toBeVisible({ timeout: 5000 });

  // Open the task detail panel
  await page.getByRole("button", { name: "Edit task: E2E test task" }).click();

  // Edit the title
  const titleInput = page.getByRole("textbox", { name: "Task title", exact: true });
  await titleInput.fill("E2E edited task");
  await page.getByRole("button", { name: "Save" }).click();

  // Close the detail panel
  await page.getByRole("button", { name: "Close task details" }).click();

  // Verify the edited title is visible
  await expect(page.getByText("E2E edited task")).toBeVisible();

  // Open detail panel again for completion toggle
  await page.getByRole("button", { name: "Edit task: E2E edited task" }).click();
  const dialog = page.getByRole("dialog", { name: /Task: E2E edited task/ });

  // Complete the task via the detail panel
  await dialog.getByRole("button", { name: /Complete task: E2E edited task/ }).click();
  await expect(dialog.getByRole("button", { name: /Mark task incomplete/ })).toBeVisible({
    timeout: 5000,
  });

  // Uncomplete via the detail panel
  await dialog.getByRole("button", { name: /Mark task incomplete/ }).click();
  await expect(dialog.getByRole("button", { name: /Complete task: E2E edited task/ })).toBeVisible({
    timeout: 5000,
  });

  // Delete the task (custom confirm dialog — not window.confirm)
  await dialog.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete task" }).click();
  await expect(page.getByRole("alertdialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Edit task: E2E edited task" })).not.toBeVisible({
    timeout: 5000,
  });
});

test("nullable due-date clearing", async ({ page }) => {
  await authenticate(page);

  // Create a task with a due date (it gets today's date by default from Today view)
  await page.getByPlaceholder("Add a task for today...").fill("Due date clear test");
  await page.getByPlaceholder("Add a task for today...").press("Enter");
  await expect(page.getByText("Due date clear test")).toBeVisible({ timeout: 5000 });

  // Open detail panel and clear due date
  await page.getByRole("button", { name: "Edit task: Due date clear test" }).click();
  const dialog = page.getByRole("dialog", { name: /Task: Due date clear test/ });
  const dateInput = dialog.locator("#task-due-date");
  // Clear the date input
  await dateInput.evaluate((el) => {
    (el as HTMLInputElement).value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await dialog.getByRole("button", { name: "Save" }).click();
  await dialog.getByRole("button", { name: "Close task details" }).click();

  // The task should no longer have a due date shown
  // (it should move from Today to Inbox since it has no due date)
  // Navigate to inbox to verify
  await page.goto(appUrlWithToken(server.baseUrl, server.token, "/inbox"));
  await page.waitForSelector("h1");
  await expect(page.getByText("Due date clear test")).toBeVisible();

  // Clean up — open detail and delete from dialog
  await page.getByRole("button", { name: "Edit task: Due date clear test" }).click();
  const clearDialog = page.getByRole("dialog", { name: /Task: Due date clear test/ });
  await clearDialog.getByRole("button", { name: "Delete task" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete task" }).click();
});

test("completion reversal works", async ({ page }) => {
  await authenticate(page);

  // Create a task
  await page.getByPlaceholder("Add a task for today...").fill("Reversal test");
  await page.getByPlaceholder("Add a task for today...").press("Enter");
  await expect(page.getByText("Reversal test")).toBeVisible({ timeout: 5000 });

  // Open detail panel to complete (detail panel stays open after toggle)
  await page.getByRole("button", { name: "Edit task: Reversal test" }).click();
  const dialog = page.getByRole("dialog", { name: /Task: Reversal test/ });

  // Complete
  await dialog.getByRole("button", { name: /Complete task: Reversal test/ }).click();
  await expect(dialog.getByRole("button", { name: /Mark task incomplete/ })).toBeVisible({
    timeout: 5000,
  });

  // Uncomplete
  await dialog.getByRole("button", { name: /Mark task incomplete/ }).click();
  await expect(dialog.getByRole("button", { name: /Complete task: Reversal test/ })).toBeVisible({
    timeout: 5000,
  });

  // Clean up
  await dialog.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete task" }).click();
});

test("idempotent transport retry: same operation ID does not duplicate", async ({ page }) => {
  await authenticate(page);

  // Make a direct API call with a specific idempotency key
  const opKey = "11111111-1111-4111-8111-111111111111";
  const response1 = await page.evaluate(
    async ({ url, token, key }) => {
      const res = await fetch(`${url}/api/v1/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
          Origin: url,
        },
        body: JSON.stringify({ title: "Idempotent test", due_date: null }),
      });
      return { status: res.status, body: await res.json() };
    },
    { url: server.baseUrl, token: server.token, key: opKey },
  );

  expect(response1.status).toBe(201);

  // Retry with the same key — should return the same result, not create a duplicate
  const response2 = await page.evaluate(
    async ({ url, token, key }) => {
      const res = await fetch(`${url}/api/v1/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
          Origin: url,
        },
        body: JSON.stringify({ title: "Idempotent test", due_date: null }),
      });
      return { status: res.status, body: await res.json() };
    },
    { url: server.baseUrl, token: server.token, key: opKey },
  );

  expect(response2.status).toBe(201);
  // Phase 2 mutation envelope: event.snapshot.task (not Phase 1 body.task).
  expect(response2.body.event.snapshot.task.id).toBe(response1.body.event.snapshot.task.id);
});

test("unauthorized API calls return 401", async ({ page }) => {
  await page.goto(server.baseUrl + "/today");
  // No token — should show connection screen
  await expect(page.locator("text=No access token found")).toBeVisible();

  // Direct API call without auth should fail
  const response = await page.evaluate(async (url) => {
    const res = await fetch(`${url}/api/v1/tasks`);
    return { status: res.status, body: await res.json() };
  }, server.baseUrl);

  expect(response.status).toBe(401);
  expect(response.body.error.code).toBe("authentication_required");
});

test("API-vs-SPA fallback: /api/unknown returns JSON 404, not SPA HTML", async ({ page }) => {
  await authenticate(page);

  const response = await page.evaluate(async (url) => {
    const res = await fetch(`${url}/api/unknown`);
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      body: await res.text(),
    };
  }, server.baseUrl);

  expect(response.status).toBe(404);
  expect(response.contentType).toContain("application/json");
  expect(response.body).not.toContain("<html");
});

test("cross-tab SSE convergence covers create, update, completion reversal, and delete", async ({
  browser,
}) => {
  const page1 = await browser.newPage();
  const page2 = await browser.newPage();

  await page1.clock.setFixedTime(new Date("2026-07-23T10:30:00-07:00"));
  await page2.clock.setFixedTime(new Date("2026-07-23T10:30:00-07:00"));
  await page1.goto(appUrlWithToken(server.baseUrl, server.token, "/today"));
  await page2.goto(appUrlWithToken(server.baseUrl, server.token, "/inbox"));
  await page1.waitForSelector("h1");
  await page2.waitForSelector("h1");

  await page1.getByPlaceholder("Add a task for today...").fill("Cross-tab convergence test");
  await page1.getByPlaceholder("Add a task for today...").press("Enter");
  await expect(page2.getByText("Cross-tab convergence test")).toBeVisible({ timeout: 10000 });

  await page1.getByRole("button", { name: "Edit task: Cross-tab convergence test" }).click();
  await page1
    .getByRole("textbox", { name: "Task title", exact: true })
    .fill("Cross-tab updated task");
  await page1.getByRole("button", { name: "Save" }).click();
  await expect(page2.getByText("Cross-tab updated task")).toBeVisible({ timeout: 10000 });
  await expect(page2.getByText("Cross-tab convergence test")).not.toBeVisible();

  const dialog = page1.getByRole("dialog", { name: /Task: Cross-tab updated task/ });
  await dialog.getByRole("button", { name: /Complete task: Cross-tab updated task/ }).click();
  await expect(
    page2.getByRole("button", { name: /Mark task incomplete: Cross-tab updated task/ }),
  ).toBeVisible({
    timeout: 10000,
  });

  await dialog
    .getByRole("button", { name: /Mark task incomplete: Cross-tab updated task/ })
    .click();
  await expect(
    page2.getByRole("button", { name: /Complete task: Cross-tab updated task/ }),
  ).toBeVisible({
    timeout: 10000,
  });

  await dialog.getByRole("button", { name: "Delete" }).click();
  await page1.getByRole("alertdialog").getByRole("button", { name: "Delete task" }).click();
  await expect(page2.getByText("Cross-tab updated task")).not.toBeVisible({ timeout: 10000 });
  await page1.close();
  await page2.close();
});

test("optimized server restart retains task state for an authenticated reload", async ({
  page,
}) => {
  await authenticate(page);
  await page.getByPlaceholder("Add a task for today...").fill("Restart persistence test");
  await page.getByPlaceholder("Add a task for today...").press("Enter");
  await expect(page.getByText("Restart persistence test")).toBeVisible();

  await server.restart();
  await page.reload();
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.getByText("Restart persistence test")).toBeVisible();
});

test("malformed request returns validation error", async ({ page }) => {
  await authenticate(page);

  const response = await page.evaluate(
    async ({ url, token }) => {
      const res = await fetch(`${url}/api/v1/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          Origin: url,
        },
        body: JSON.stringify({ title: "   ", due_date: null }),
      });
      return { status: res.status, body: await res.json() };
    },
    { url: server.baseUrl, token: server.token },
  );

  expect(response.status).toBe(422);
  expect(response.body.error.code).toBe("validation_error");
});

test("board move control is keyboard-operable across sections (P2-FE-008)", async ({ page }) => {
  await authenticate(page);

  const setup = await page.evaluate(
    async ({ url, token }) => {
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: url,
      };
      const projectRes = await fetch(`${url}/api/v1/projects`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          name: "Board Keyboard Project",
          color: "#3366ff",
          view: "board",
        }),
      });
      if (!projectRes.ok) {
        throw new Error(`project create failed: ${projectRes.status} ${await projectRes.text()}`);
      }
      const projectEvent = (await projectRes.json()) as {
        event: { snapshot?: { project?: { id: string } } };
      };
      const projectId = projectEvent.event.snapshot?.project?.id;
      if (!projectId) throw new Error("missing project id");

      const sectionIds: string[] = [];
      for (const name of ["Todo", "Doing"]) {
        const sectionRes = await fetch(`${url}/api/v1/sections`, {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ name, project_id: projectId }),
        });
        if (!sectionRes.ok) {
          throw new Error(`section create failed: ${sectionRes.status} ${await sectionRes.text()}`);
        }
        const sectionEvent = (await sectionRes.json()) as {
          event: { snapshot?: { section?: { id: string } } };
        };
        const sectionId = sectionEvent.event.snapshot?.section?.id;
        if (!sectionId) throw new Error("missing section id");
        sectionIds.push(sectionId);
      }

      const taskRes = await fetch(`${url}/api/v1/tasks`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          title: "Keyboard board card",
          project_id: projectId,
          section_id: sectionIds[0],
        }),
      });
      if (!taskRes.ok) {
        throw new Error(`task create failed: ${taskRes.status} ${await taskRes.text()}`);
      }

      return { projectId };
    },
    { url: server.baseUrl, token: server.token },
  );

  await page.goto(appUrlWithToken(server.baseUrl, server.token, `/projects/${setup.projectId}`));
  await expect(page.getByRole("heading", { name: "Board Keyboard Project" })).toBeVisible();
  await expect(page.getByText("Keyboard board card")).toBeVisible();

  const moveBtn = page.getByRole("button", { name: "Move task Keyboard board card" });
  await moveBtn.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: /Move Keyboard board card to section/ });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Doing" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "No Section" })).toBeVisible();

  await menu.getByRole("menuitem", { name: "Doing" }).press("Enter");

  const doingColumn = page.getByLabel("Doing board column");
  await expect(doingColumn.getByText("Keyboard board card")).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("Task moved")).toBeVisible({ timeout: 5000 });
});

test("templates can be created from Filters & Labels (P2-FE-007)", async ({ page }) => {
  await authenticate(page);
  await page.goto(appUrlWithToken(server.baseUrl, server.token, "/filters-labels"));
  await expect(page.getByRole("heading", { name: "Filters & Labels" })).toBeVisible();

  await page.getByRole("button", { name: "New Template" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("E2E Template");
  await page.getByRole("textbox", { name: "Title Template", exact: true }).fill("Ship {{feature}}");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByText("E2E Template")).toBeVisible({ timeout: 5000 });
  await expect(page.getByText("Ship {{feature}}")).toBeVisible();
});
