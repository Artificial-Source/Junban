import type { RouteRegistrar } from "./types.js";
import { parseBody } from "./types.js";

export const registerMiscRoutes: RouteRegistrar = (server, getServices) => {
  // POST /api/test-reset — delete all data (for E2E tests)
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/test-reset" || req.method !== "POST") return next();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = await getServices();
      // Delete all tasks (cascades to comments, activity, task_tags)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tasks = await svc.taskService.list();
      if (tasks.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await svc.taskService.deleteMany(tasks.map((t: any) => t.id));
      }
      // Delete all projects (cascades to sections)
      const projects = await svc.projectService.list();
      for (const p of projects) {
        await svc.projectService.delete(p.id);
      }
      // Delete all tags
      const tags = await svc.tagService.list();
      for (const t of tags) {
        await svc.tagService.delete(t.id);
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // POST /api/tasks/import — import tasks from external formats
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/tasks/import" || req.method !== "POST") return next();
    try {
      const svc = await getServices();
      const body = await parseBody(req);
      const { tasks: importedTasks } = body as {
        tasks: Array<{
          title: string;
          description: string | null;
          status: "pending" | "completed";
          priority: number | null;
          dueDate: string | null;
          dueTime: boolean;
          projectName: string | null;
          tagNames: string[];
          recurrence: string | null;
        }>;
      };

      const errors: string[] = [];
      let imported = 0;

      for (const t of importedTasks) {
        try {
          let projectId: string | undefined;
          if (t.projectName) {
            const project = await svc.projectService.getOrCreate(t.projectName);
            projectId = project.id;
          }

          const task = await svc.taskService.create({
            title: t.title,
            description: t.description ?? undefined,
            priority: t.priority,
            dueDate: t.dueDate ?? undefined,
            dueTime: t.dueTime,
            projectId,
            recurrence: t.recurrence ?? undefined,
            tags: t.tagNames,
          });

          if (t.status === "completed") {
            await svc.taskService.complete(task.id);
          }

          imported++;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          errors.push(`Failed to import "${t.title}": ${err.message ?? "unknown error"}`);
        }
      }

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ imported, errors }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });
};
