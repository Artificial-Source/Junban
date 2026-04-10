import { describe, it, expect, vi } from "vitest";
import { importTasksWithRollback } from "../../src/core/import-execution.js";
import type { ImportedTask } from "../../src/core/import.js";

function makeImportedTask(overrides: Partial<ImportedTask> = {}): ImportedTask {
  return {
    title: "Imported task",
    description: null,
    status: "pending",
    priority: null,
    dueDate: null,
    dueTime: false,
    projectName: null,
    tagNames: [],
    recurrence: null,
    ...overrides,
  };
}

describe("importTasksWithRollback", () => {
  it("imports all tasks successfully", async () => {
    const services = {
      projectService: {
        getByName: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "project-1" }),
        delete: vi.fn().mockResolvedValue(true),
      },
      taskService: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ id: "task-1" })
          .mockResolvedValueOnce({ id: "task-2" }),
        complete: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(true),
      },
    };

    const result = await importTasksWithRollback(services, [
      makeImportedTask({ projectName: "Work" }),
      makeImportedTask({ title: "Done", status: "completed", projectName: "Work" }),
    ]);

    expect(result).toEqual({ imported: 2, errors: [] });
    expect(services.projectService.create).toHaveBeenCalledTimes(1);
    expect(services.taskService.complete).toHaveBeenCalledWith("task-2");
    expect(services.taskService.delete).not.toHaveBeenCalled();
    expect(services.projectService.delete).not.toHaveBeenCalled();
  });

  it("rolls back created tasks and projects when import fails", async () => {
    const services = {
      projectService: {
        getByName: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "project-1" }),
        delete: vi.fn().mockResolvedValue(true),
      },
      taskService: {
        create: vi
          .fn()
          .mockResolvedValueOnce({ id: "task-1" })
          .mockRejectedValueOnce(new Error("write failed")),
        complete: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(true),
      },
    };

    const result = await importTasksWithRollback(services, [
      makeImportedTask({ title: "First", projectName: "Work" }),
      makeImportedTask({ title: "Second", projectName: "Work" }),
    ]);

    expect(result.imported).toBe(0);
    expect(result.errors[0]).toContain("Import aborted and rolled back");
    expect(services.taskService.delete).toHaveBeenCalledWith("task-1");
    expect(services.projectService.delete).toHaveBeenCalledWith("project-1");
  });
});
