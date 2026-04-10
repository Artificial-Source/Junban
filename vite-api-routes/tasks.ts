import type { RouteRegistrar } from "./types.js";
import { parseBody } from "./types.js";
import { CreateTaskInput, UpdateTaskInput, RestoreTaskInput } from "../src/core/types.js";

export const registerTaskRoutes: RouteRegistrar = (server, getServices) => {
  // POST /api/tasks — create task, GET /api/tasks — list tasks
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/tasks") return next();

    try {
      const svc = await getServices();

      if (req.method === "GET") {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const filter: Record<string, string> = {};
        const search = url.searchParams.get("search");
        const projectId = url.searchParams.get("projectId");
        const status = url.searchParams.get("status");
        if (search) filter.search = search;
        if (projectId) filter.projectId = projectId;
        if (status) filter.status = status;

        const tasks = await svc.taskService.list(
          Object.keys(filter).length > 0 ? filter : undefined,
        );
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(tasks));
        return;
      }

      if (req.method === "POST") {
        const body = await parseBody(req);
        const parsed = CreateTaskInput.safeParse(body);
        if (!parsed.success) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Validation failed", details: parsed.error.flatten() }));
          return;
        }
        const task = await svc.taskService.create(parsed.data);
        res.setHeader("Content-Type", "application/json");
        res.statusCode = 201;
        res.end(JSON.stringify(task));
        return;
      }

      next();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // GET /api/tasks/relations — list all task relations
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/tasks/relations" || req.method !== "GET") return next();
    try {
      const svc = await getServices();
      const relations = await svc.taskService.listAllRelations();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(relations));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  // POST /api/tasks/bulk/complete
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/tasks/bulk/complete" || req.method !== "POST") return next();
    try {
      const svc = await getServices();
      const body = await parseBody(req);
      const { ids } = body as { ids: string[] };
      if (!Array.isArray(ids) || ids.length > 500) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "ids must be an array with at most 500 items" }));
        return;
      }
      const tasks = await svc.taskService.completeMany(ids);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(tasks));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // POST /api/tasks/bulk/delete
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/tasks/bulk/delete" || req.method !== "POST") return next();
    try {
      const svc = await getServices();
      const body = await parseBody(req);
      const { ids } = body as { ids: string[] };
      if (!Array.isArray(ids) || ids.length > 500) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "ids must be an array with at most 500 items" }));
        return;
      }
      await svc.taskService.deleteMany(ids);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // POST /api/tasks/bulk/update
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/tasks/bulk/update" || req.method !== "POST") return next();
    try {
      const svc = await getServices();
      const body = await parseBody(req);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { ids, changes } = body as { ids: string[]; changes: any };
      if (!Array.isArray(ids) || ids.length > 500) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "ids must be an array with at most 500 items" }));
        return;
      }
      const parsed = UpdateTaskInput.safeParse(changes);
      if (!parsed.success) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({ error: "Invalid update payload", details: parsed.error.flatten() }),
        );
        return;
      }
      const tasks = await svc.taskService.updateMany(ids, parsed.data);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(tasks));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // POST /api/tasks/reorder
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/tasks/reorder" || req.method !== "POST") return next();
    try {
      const svc = await getServices();
      const body = await parseBody(req);
      const { orderedIds } = body as { orderedIds: string[] };
      await svc.taskService.reorder(orderedIds);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // POST /api/tasks/restore
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/tasks/restore" || req.method !== "POST") return next();
    try {
      const svc = await getServices();
      const body = await parseBody(req);
      const parsed = RestoreTaskInput.safeParse(body);
      if (!parsed.success) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Validation failed", details: parsed.error.flatten() }));
        return;
      }
      const task = await svc.taskService.restoreTask(parsed.data);
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 201;
      res.end(JSON.stringify(task));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // GET /api/tasks/reminders/due — list tasks with due reminders
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/tasks/reminders/due" || req.method !== "GET") return next();
    try {
      const svc = await getServices();
      const tasks = await svc.taskService.getDueReminders();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(tasks));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // GET /api/tasks/tree — list tasks as nested tree
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/tasks/tree" || req.method !== "GET") return next();
    try {
      const svc = await getServices();
      const tree = await svc.taskService.listTree();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(tree));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // POST /api/tasks/:id/indent and /api/tasks/:id/outdent
  server.middlewares.use(async (req, res, next) => {
    const indentMatch = req.url?.match(/^\/api\/tasks\/([^/]+)\/indent$/);
    if (indentMatch && req.method === "POST") {
      try {
        const svc = await getServices();
        const task = await svc.taskService.indent(indentMatch[1]);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(task));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        res.statusCode = err.name === "NotFoundError" ? 404 : 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const outdentMatch = req.url?.match(/^\/api\/tasks\/([^/]+)\/outdent$/);
    if (outdentMatch && req.method === "POST") {
      try {
        const svc = await getServices();
        const task = await svc.taskService.outdent(outdentMatch[1]);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(task));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        res.statusCode = err.name === "NotFoundError" ? 404 : 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // GET /api/tasks/:id/children — get children of a task
    const childrenMatch = req.url?.match(/^\/api\/tasks\/([^/]+)\/children$/);
    if (childrenMatch && req.method === "GET") {
      try {
        const svc = await getServices();
        const children = await svc.taskService.getChildren(childrenMatch[1]);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(children));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        res.statusCode = err.name === "NotFoundError" ? 404 : 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    next();
  });

  // /api/tasks/:id/relations
  server.middlewares.use(async (req, res, next) => {
    // DELETE /api/tasks/:id/relations/:relatedId
    const delRelMatch = req.url?.match(/^\/api\/tasks\/([^/]+)\/relations\/([^/]+)$/);
    if (delRelMatch && req.method === "DELETE") {
      try {
        const svc = await getServices();
        await svc.taskService.removeRelation(
          decodeURIComponent(delRelMatch[1]),
          decodeURIComponent(delRelMatch[2]),
        );
        res.statusCode = 204;
        res.end();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        res.statusCode = err.name === "NotFoundError" ? 404 : 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // GET /api/tasks/:id/relations
    const relMatch = req.url?.match(/^\/api\/tasks\/([^/]+)\/relations$/);
    if (relMatch && req.method === "GET") {
      try {
        const svc = await getServices();
        const taskId = decodeURIComponent(relMatch[1]);
        const { blocks, blockedBy } = await svc.taskService.getRelations(taskId);
        // Hydrate task objects
        const blocksTasks = [];
        for (const id of blocks) {
          const t = await svc.taskService.get(id);
          if (t) blocksTasks.push(t);
        }
        const blockedByTasks = [];
        for (const id of blockedBy) {
          const t = await svc.taskService.get(id);
          if (t) blockedByTasks.push(t);
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ blocks: blocksTasks, blockedBy: blockedByTasks }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        res.statusCode = err.name === "NotFoundError" ? 404 : 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /api/tasks/:id/relations
    if (relMatch && req.method === "POST") {
      try {
        const svc = await getServices();
        const taskId = decodeURIComponent(relMatch[1]);
        const body = await parseBody(req);
        await svc.taskService.addRelation(
          taskId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (body as any).relatedTaskId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (body as any).type ?? "blocks",
        );
        res.statusCode = 201;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        res.statusCode = err.message?.includes("cycle") ? 400 : 500;
        if (err.name === "NotFoundError") res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    next();
  });

  // /api/tasks/:id/uncomplete, /api/tasks/:id/complete, and /api/tasks/:id
  server.middlewares.use(async (req, res, next) => {
    const uncompleteMatch = req.url?.match(/^\/api\/tasks\/([^/]+)\/uncomplete$/);
    if (uncompleteMatch && req.method === "POST") {
      const svc = await getServices();
      try {
        const task = await svc.taskService.uncomplete(uncompleteMatch[1]);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(task));
      } catch (err: any) {
        res.statusCode = err.name === "NotFoundError" ? 404 : 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const match = req.url?.match(/^\/api\/tasks\/([^/]+)\/complete$/);
    if (match && req.method === "POST") {
      const svc = await getServices();
      try {
        const task = await svc.taskService.complete(match[1]);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(task));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        res.statusCode = err.name === "NotFoundError" ? 404 : 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const taskMatch = req.url?.match(/^\/api\/tasks\/([^/]+)$/);
    if (!taskMatch) return next();

    const id = taskMatch[1];
    const svc = await getServices();

    if (req.method === "GET") {
      try {
        const task = await svc.taskService.get(id);
        if (!task) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Task not found" }));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(task));
      } catch (err: any) {
        res.statusCode = err.name === "NotFoundError" ? 404 : 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === "PATCH") {
      try {
        const body = await parseBody(req);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const task = await svc.taskService.update(id, body as any);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(task));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        res.statusCode = err.name === "NotFoundError" ? 404 : 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === "DELETE") {
      await svc.taskService.delete(id);
      res.statusCode = 204;
      res.end();
      return;
    }

    next();
  });
};
