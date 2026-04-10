import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/utils/tauri.js", () => ({
  isTauri: () => false,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  listTasks,
  createTask,
  completeTask,
  updateTask,
  deleteTask,
  completeManyTasks,
  deleteManyTasks,
  updateManyTasks,
  fetchDueReminders,
  listTaskTree,
  getChildren,
  indentTask,
  outdentTask,
  reorderTasks,
  importTasks,
} from "../../../src/ui/api/tasks.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// listTasks
// ---------------------------------------------------------------------------
describe("listTasks", () => {
  it("fetches /api/tasks with no params", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: "t1", title: "Task 1" }]),
    });

    const result = await listTasks();

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("/api/tasks");
    expect(url).not.toContain("?");
    expect(result).toEqual([{ id: "t1", title: "Task 1" }]);
  });

  it("appends search param", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await listTasks({ search: "buy milk" });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("search=buy+milk");
  });

  it("appends projectId param", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await listTasks({ projectId: "p1" });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("projectId=p1");
  });

  it("appends status param", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await listTasks({ status: "completed" });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("status=completed");
  });

  it("appends multiple params", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await listTasks({ search: "test", projectId: "p2", status: "pending" });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("search=test");
    expect(url).toContain("projectId=p2");
    expect(url).toContain("status=pending");
  });

  it("throws on server error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Server error" }),
    });

    await expect(listTasks()).rejects.toThrow("Server error");
  });
});

// ---------------------------------------------------------------------------
// createTask
// ---------------------------------------------------------------------------
describe("createTask", () => {
  it("POSTs to /api/tasks with JSON body", async () => {
    const created = { id: "t2", title: "New task" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(created),
    });

    const result = await createTask({ title: "New task" });

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New task" }),
    });
    expect(result).toEqual(created);
  });

  it("throws on error response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "Title required" }),
    });

    await expect(createTask({ title: "" })).rejects.toThrow("Title required");
  });
});

// ---------------------------------------------------------------------------
// completeTask
// ---------------------------------------------------------------------------
describe("completeTask", () => {
  it("POSTs to /api/tasks/:id/complete", async () => {
    const task = { id: "t1", title: "Done", status: "completed" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(task),
    });

    const result = await completeTask("t1");

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/t1/complete", {
      method: "POST",
    });
    expect(result).toEqual(task);
  });
});

// ---------------------------------------------------------------------------
// updateTask
// ---------------------------------------------------------------------------
describe("updateTask", () => {
  it("PATCHes /api/tasks/:id with changes", async () => {
    const updated = { id: "t1", title: "Updated" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(updated),
    });

    const result = await updateTask("t1", { title: "Updated" });

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/t1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated" }),
    });
    expect(result).toEqual(updated);
  });
});

// ---------------------------------------------------------------------------
// deleteTask
// ---------------------------------------------------------------------------
describe("deleteTask", () => {
  it("DELETEs /api/tasks/:id", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await deleteTask("t1");

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/t1", {
      method: "DELETE",
    });
  });

  it("throws on error response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "Not found" }),
    });

    await expect(deleteTask("bad-id")).rejects.toThrow("Not found");
  });
});

// ---------------------------------------------------------------------------
// completeManyTasks
// ---------------------------------------------------------------------------
describe("completeManyTasks", () => {
  it("POSTs to /api/tasks/bulk/complete with ids", async () => {
    const tasks = [
      { id: "t1", status: "completed" },
      { id: "t2", status: "completed" },
    ];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(tasks),
    });

    const result = await completeManyTasks(["t1", "t2"]);

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/bulk/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["t1", "t2"] }),
    });
    expect(result).toEqual(tasks);
  });
});

// ---------------------------------------------------------------------------
// deleteManyTasks
// ---------------------------------------------------------------------------
describe("deleteManyTasks", () => {
  it("POSTs to /api/tasks/bulk/delete with ids", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await deleteManyTasks(["t1", "t2"]);

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/bulk/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["t1", "t2"] }),
    });
  });

  it("throws on error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Bulk delete failed" }),
    });

    await expect(deleteManyTasks(["t1"])).rejects.toThrow("Bulk delete failed");
  });
});

// ---------------------------------------------------------------------------
// updateManyTasks
// ---------------------------------------------------------------------------
describe("updateManyTasks", () => {
  it("POSTs to /api/tasks/bulk/update with ids and changes", async () => {
    const updated = [{ id: "t1", priority: 1 }];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(updated),
    });

    const result = await updateManyTasks(["t1"], { priority: 1 });

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/bulk/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["t1"], changes: { priority: 1 } }),
    });
    expect(result).toEqual(updated);
  });
});

// ---------------------------------------------------------------------------
// fetchDueReminders
// ---------------------------------------------------------------------------
describe("fetchDueReminders", () => {
  it("GETs /api/tasks/reminders/due", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: "t5", reminder: true }]),
    });

    const result = await fetchDueReminders();

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/reminders/due");
    expect(result).toEqual([{ id: "t5", reminder: true }]);
  });
});

// ---------------------------------------------------------------------------
// listTaskTree
// ---------------------------------------------------------------------------
describe("listTaskTree", () => {
  it("GETs /api/tasks/tree", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: "t1", children: [] }]),
    });

    const result = await listTaskTree();

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/tree");
    expect(result).toEqual([{ id: "t1", children: [] }]);
  });
});

// ---------------------------------------------------------------------------
// getChildren
// ---------------------------------------------------------------------------
describe("getChildren", () => {
  it("GETs /api/tasks/:parentId/children", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: "child1" }]),
    });

    const result = await getChildren("parent1");

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/parent1/children");
    expect(result).toEqual([{ id: "child1" }]);
  });
});

// ---------------------------------------------------------------------------
// indentTask
// ---------------------------------------------------------------------------
describe("indentTask", () => {
  it("POSTs to /api/tasks/:id/indent", async () => {
    const task = { id: "t1", parentId: "t0" };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(task),
    });

    const result = await indentTask("t1");

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/t1/indent", {
      method: "POST",
    });
    expect(result).toEqual(task);
  });
});

// ---------------------------------------------------------------------------
// outdentTask
// ---------------------------------------------------------------------------
describe("outdentTask", () => {
  it("POSTs to /api/tasks/:id/outdent", async () => {
    const task = { id: "t1", parentId: null };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(task),
    });

    const result = await outdentTask("t1");

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/t1/outdent", {
      method: "POST",
    });
    expect(result).toEqual(task);
  });
});

// ---------------------------------------------------------------------------
// reorderTasks
// ---------------------------------------------------------------------------
describe("reorderTasks", () => {
  it("POSTs to /api/tasks/reorder with orderedIds", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await reorderTasks(["t3", "t1", "t2"]);

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds: ["t3", "t1", "t2"] }),
    });
  });

  it("throws on error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Reorder failed" }),
    });

    await expect(reorderTasks(["t1"])).rejects.toThrow("Reorder failed");
  });
});

// ---------------------------------------------------------------------------
// importTasks
// ---------------------------------------------------------------------------
describe("importTasks", () => {
  it("POSTs to /api/tasks/import with tasks array", async () => {
    const importResult = { imported: 2, errors: [] };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(importResult),
    });

    const tasks = [
      {
        title: "Task A",
        description: null,
        status: "pending" as const,
        priority: 1,
        dueDate: null,
        dueTime: false,
        projectName: null,
        tagNames: [],
        recurrence: null,
      },
      {
        title: "Task B",
        description: "desc",
        status: "completed" as const,
        priority: null,
        dueDate: "2026-03-01",
        dueTime: false,
        projectName: "Work",
        tagNames: ["urgent"],
        recurrence: null,
      },
    ];

    const result = await importTasks(tasks);

    expect(mockFetch).toHaveBeenCalledWith("/api/tasks/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks }),
    });
    expect(result).toEqual(importResult);
  });

  it("throws on server error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Import failed" }),
    });

    await expect(importTasks([])).rejects.toThrow("Import failed");
  });

  it("throws when tasks is not an array", async () => {
    await expect(importTasks({} as unknown as Parameters<typeof importTasks>[0])).rejects.toThrow(
      "tasks must be an array",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
