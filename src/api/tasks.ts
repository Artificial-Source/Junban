import { Hono } from "hono";
import type { AppServices } from "../bootstrap.js";
import {
  CreateTaskInput,
  UpdateTaskInput,
  CommentContentInput,
  RestoreTaskInput,
} from "../core/types.js";
import { importTasksWithRollback } from "../core/import-execution.js";

export function taskRoutes(services: AppServices): Hono {
  const app = new Hono();

  // GET /tasks — list tasks with optional filters
  app.get("/", async (c) => {
    const search = c.req.query("search");
    const projectId = c.req.query("projectId");
    const status = c.req.query("status");
    const filter: Record<string, string> = {};
    if (search) filter.search = search;
    if (projectId) filter.projectId = projectId;
    if (status) filter.status = status;

    const tasks = await services.taskService.list(
      Object.keys(filter).length > 0 ? filter : undefined,
    );
    return c.json(tasks);
  });

  // POST /tasks — create a task
  app.post("/", async (c) => {
    const body = await c.req.json();
    const parsed = CreateTaskInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }
    const task = await services.taskService.create(parsed.data);
    return c.json(task, 201);
  });

  // GET /tasks/relations — list all task relations
  app.get("/relations", async (c) => {
    const relations = await services.taskService.listAllRelations();
    return c.json(relations);
  });

  // GET /tasks/reminders/due — list tasks with due reminders
  app.get("/reminders/due", async (c) => {
    const tasks = await services.taskService.getDueReminders();
    return c.json(tasks);
  });

  // GET /tasks/tree — list tasks as nested tree
  app.get("/tree", async (c) => {
    const tree = await services.taskService.listTree();
    return c.json(tree);
  });

  // POST /tasks/bulk/complete
  app.post("/bulk/complete", async (c) => {
    const { ids } = await c.req.json();
    if (!Array.isArray(ids) || ids.length > 500) {
      return c.json({ error: "ids must be an array with at most 500 items" }, 400);
    }
    const tasks = await services.taskService.completeMany(ids);
    return c.json(tasks);
  });

  // POST /tasks/bulk/delete
  app.post("/bulk/delete", async (c) => {
    const { ids } = await c.req.json();
    if (!Array.isArray(ids) || ids.length > 500) {
      return c.json({ error: "ids must be an array with at most 500 items" }, 400);
    }
    await services.taskService.deleteMany(ids);
    return c.json({ ok: true });
  });

  // POST /tasks/bulk/update
  app.post("/bulk/update", async (c) => {
    const { ids, changes } = await c.req.json();
    if (!Array.isArray(ids) || ids.length > 500) {
      return c.json({ error: "ids must be an array with at most 500 items" }, 400);
    }
    const parsed = UpdateTaskInput.safeParse(changes);
    if (!parsed.success) {
      return c.json({ error: "Invalid update payload", details: parsed.error.flatten() }, 400);
    }
    const tasks = await services.taskService.updateMany(ids, parsed.data);
    return c.json(tasks);
  });

  // POST /tasks/reorder
  app.post("/reorder", async (c) => {
    const { orderedIds } = await c.req.json();
    await services.taskService.reorder(orderedIds);
    return c.json({ ok: true });
  });

  // POST /tasks/import — import tasks from external formats
  app.post("/import", async (c) => {
    const body = await c.req.json();
    if (!body || !Array.isArray(body.tasks)) {
      return c.json({ error: "tasks must be an array" }, 400);
    }

    const importedTasks = body.tasks;
    const result = await importTasksWithRollback(
      {
        taskService: services.taskService,
        projectService: services.projectService,
      },
      importedTasks,
    );

    return c.json(result);
  });

  // POST /tasks/restore — restore a previously deleted task snapshot
  app.post("/restore", async (c) => {
    const body = await c.req.json();
    const parsed = RestoreTaskInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }
    const task = await services.taskService.restoreTask(parsed.data);
    return c.json(task, 201);
  });

  // GET /tasks/:id — get a single task
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const task = await services.taskService.get(id);
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json(task);
  });

  // POST /tasks/:id/complete
  app.post("/:id/complete", async (c) => {
    const id = c.req.param("id");
    const task = await services.taskService.complete(id);
    return c.json(task);
  });

  // POST /tasks/:id/uncomplete
  app.post("/:id/uncomplete", async (c) => {
    const id = c.req.param("id");
    const task = await services.taskService.uncomplete(id);
    return c.json(task);
  });

  // POST /tasks/:id/indent
  app.post("/:id/indent", async (c) => {
    const id = c.req.param("id");
    const task = await services.taskService.indent(id);
    return c.json(task);
  });

  // POST /tasks/:id/outdent
  app.post("/:id/outdent", async (c) => {
    const id = c.req.param("id");
    const task = await services.taskService.outdent(id);
    return c.json(task);
  });

  // GET /tasks/:id/children
  app.get("/:id/children", async (c) => {
    const id = c.req.param("id");
    const children = await services.taskService.getChildren(id);
    return c.json(children);
  });

  // GET /tasks/:id/relations
  app.get("/:id/relations", async (c) => {
    const taskId = decodeURIComponent(c.req.param("id"));
    const { blocks, blockedBy } = await services.taskService.getRelations(taskId);
    const blocksTasks = [];
    for (const id of blocks) {
      const t = await services.taskService.get(id);
      if (t) blocksTasks.push(t);
    }
    const blockedByTasks = [];
    for (const id of blockedBy) {
      const t = await services.taskService.get(id);
      if (t) blockedByTasks.push(t);
    }
    return c.json({ blocks: blocksTasks, blockedBy: blockedByTasks });
  });

  // POST /tasks/:id/relations
  app.post("/:id/relations", async (c) => {
    const taskId = decodeURIComponent(c.req.param("id"));
    const body = await c.req.json();
    await services.taskService.addRelation(taskId, body.relatedTaskId, body.type ?? "blocks");
    return c.json({ ok: true }, 201);
  });

  // DELETE /tasks/:id/relations/:relatedId
  app.delete("/:id/relations/:relatedId", async (c) => {
    const taskId = decodeURIComponent(c.req.param("id"));
    const relatedId = decodeURIComponent(c.req.param("relatedId"));
    await services.taskService.removeRelation(taskId, relatedId);
    return c.body(null, 204);
  });

  // GET /tasks/:id/comments
  app.get("/:id/comments", async (c) => {
    const taskId = decodeURIComponent(c.req.param("id"));
    const comments = services.storage.listTaskComments(taskId);
    return c.json(comments);
  });

  // POST /tasks/:id/comments
  app.post("/:id/comments", async (c) => {
    const taskId = decodeURIComponent(c.req.param("id"));
    const body = await c.req.json();
    const parsed = CommentContentInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }
    const { generateId } = await import("../utils/ids.js");
    const now = new Date().toISOString();
    const comment = {
      id: generateId(),
      taskId,
      content: parsed.data.content,
      createdAt: now,
      updatedAt: now,
    };
    services.storage.insertTaskComment(comment);
    return c.json(comment, 201);
  });

  // GET /tasks/:id/activity
  app.get("/:id/activity", async (c) => {
    const taskId = decodeURIComponent(c.req.param("id"));
    const activity = services.storage.listTaskActivity(taskId);
    return c.json(activity);
  });

  // PATCH /tasks/:id
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = UpdateTaskInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Validation failed", details: parsed.error.flatten() }, 400);
    }
    const task = await services.taskService.update(id, parsed.data);
    return c.json(task);
  });

  // DELETE /tasks/:id
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await services.taskService.delete(id);
    return c.body(null, 204);
  });

  return app;
}
