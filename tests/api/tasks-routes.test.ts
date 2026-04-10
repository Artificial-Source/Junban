import { describe, it, expect, vi } from "vitest";
import { taskRoutes } from "../../src/api/tasks.js";

describe("taskRoutes import validation", () => {
  it("rejects /tasks/import when tasks is not an array", async () => {
    const services = {
      taskService: {
        create: vi.fn(),
        complete: vi.fn(),
      },
      projectService: {
        getByName: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
      },
    } as any;

    const app = taskRoutes(services);
    const response = await app.request(
      new Request("http://localhost/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: "not-an-array" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "tasks must be an array" });
    expect(services.taskService.create).not.toHaveBeenCalled();
  });
});
