import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import type { IncomingMessage } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON in request body"));
      }
    });
  });
}

function apiPlugin() {
  return {
    name: "saydo-api",
    configureServer(server: ViteDevServer) {
      // Lazy-load bootstrap to avoid issues with Vite's module resolution
      let services: Awaited<ReturnType<typeof import("./src/bootstrap.js").bootstrap>> | null =
        null;

      async function getServices() {
        if (!services) {
          const { bootstrap } = await import("./src/bootstrap.js");
          services = bootstrap();
        }
        return services;
      }

      // POST /api/test-reset — delete all data (for E2E tests)
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/test-reset" || req.method !== "POST") return next();
        try {
          const svc = await getServices();
          // Delete all tasks (cascades to comments, activity, task_tags)
          const tasks = await svc.taskService.list();
          if (tasks.length > 0) {
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

      // POST /api/tasks — create task
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
            const task = await svc.taskService.create(body as any);
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
          const { ids, changes } = body as { ids: string[]; changes: any };
          const tasks = await svc.taskService.updateMany(ids, changes);
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

      // ── Templates ─────────────────────────────────────

      // GET/POST /api/templates
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/templates") return next();
        try {
          const svc = await getServices();
          const { TemplateService } = await import("./src/core/templates.js");
          const templateService = new TemplateService(svc.storage, svc.taskService);

          if (req.method === "GET") {
            const templates = await templateService.list();
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(templates));
            return;
          }

          if (req.method === "POST") {
            const body = await parseBody(req);
            const template = await templateService.create(body as any);
            res.setHeader("Content-Type", "application/json");
            res.statusCode = 201;
            res.end(JSON.stringify(template));
            return;
          }

          next();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // PATCH/DELETE /api/templates/:id and POST /api/templates/:id/instantiate
      server.middlewares.use(async (req, res, next) => {
        const instantiateMatch = req.url?.match(/^\/api\/templates\/([^/]+)\/instantiate$/);
        if (instantiateMatch && req.method === "POST") {
          try {
            const svc = await getServices();
            const { TemplateService } = await import("./src/core/templates.js");
            const templateService = new TemplateService(svc.storage, svc.taskService);
            const body = await parseBody(req);
            const task = await templateService.instantiate(
              instantiateMatch[1],
              (body as any).variables,
            );
            res.setHeader("Content-Type", "application/json");
            res.statusCode = 201;
            res.end(JSON.stringify(task));
          } catch (err: any) {
            res.statusCode = err.name === "NotFoundError" ? 404 : 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        const match = req.url?.match(/^\/api\/templates\/([^/]+)$/);
        if (!match) return next();

        try {
          const svc = await getServices();
          const { TemplateService } = await import("./src/core/templates.js");
          const templateService = new TemplateService(svc.storage, svc.taskService);
          const id = match[1];

          if (req.method === "PATCH") {
            const body = await parseBody(req);
            const template = await templateService.update(id, body as any);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(template));
            return;
          }

          if (req.method === "DELETE") {
            await templateService.delete(id);
            res.statusCode = 204;
            res.end();
            return;
          }

          next();
        } catch (err: any) {
          res.statusCode = err.name === "NotFoundError" ? 404 : 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      // GET /api/tags
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/tags" || req.method !== "GET") return next();

        try {
          const svc = await getServices();
          const tags = await svc.tagService.list();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(tags));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // GET/POST /api/projects
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/projects") return next();

        try {
          const svc = await getServices();

          if (req.method === "GET") {
            const projects = await svc.projectService.list();
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(projects));
            return;
          }

          if (req.method === "POST") {
            const body = await parseBody(req);
            const name = body.name as string;
            if (!name) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "name is required" }));
              return;
            }
            const project = await svc.projectService.create(name, {
              color: (body.color as string) || undefined,
              parentId: (body.parentId as string) || null,
              isFavorite: (body.isFavorite as boolean) || false,
              viewStyle: (body.viewStyle as "list" | "board" | "calendar") || "list",
            });
            if (body.icon) {
              const updated = await svc.projectService.update(project.id, {
                icon: body.icon as string,
              });
              res.setHeader("Content-Type", "application/json");
              res.statusCode = 201;
              res.end(JSON.stringify(updated ?? project));
              return;
            }
            res.setHeader("Content-Type", "application/json");
            res.statusCode = 201;
            res.end(JSON.stringify(project));
            return;
          }

          next();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // PATCH/DELETE /api/projects/:id
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/projects\/([^/]+)$/);
        if (!match) return next();

        const id = decodeURIComponent(match[1]);
        const svc = await getServices();

        if (req.method === "PATCH") {
          try {
            const body = await parseBody(req);
            const project = await svc.projectService.update(id, body as any);
            if (!project) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Project not found" }));
              return;
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(project));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Internal server error";
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        if (req.method === "DELETE") {
          try {
            await svc.projectService.delete(id);
            res.statusCode = 204;
            res.end();
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Internal server error";
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        next();
      });

      // ── Sections ─────────────────────────────────────

      // GET/POST /api/sections
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/sections")) return next();

        // POST /api/sections/reorder
        if (req.url === "/api/sections/reorder" && req.method === "POST") {
          try {
            const svc = await getServices();
            const body = await parseBody(req);
            const { orderedIds } = body as { orderedIds: string[] };
            await svc.sectionService.reorder(orderedIds);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Internal server error";
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        // PATCH/DELETE /api/sections/:id
        const idMatch = req.url.match(/^\/api\/sections\/([^/?]+)$/);
        if (idMatch) {
          const id = decodeURIComponent(idMatch[1]);
          const svc = await getServices();

          if (req.method === "PATCH") {
            try {
              const body = await parseBody(req);
              const section = await svc.sectionService.update(id, body as any);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(section));
            } catch (err: any) {
              res.statusCode = err.name === "NotFoundError" ? 404 : 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: err.message }));
            }
            return;
          }

          if (req.method === "DELETE") {
            try {
              await svc.sectionService.delete(id);
              res.statusCode = 204;
              res.end();
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : "Internal server error";
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: message }));
            }
            return;
          }

          return next();
        }

        // GET/POST /api/sections
        if (req.url === "/api/sections" || req.url.startsWith("/api/sections?")) {
          try {
            const svc = await getServices();

            if (req.method === "GET") {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const projectId = url.searchParams.get("projectId");
              if (!projectId) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "projectId is required" }));
                return;
              }
              const sections = await svc.sectionService.list(projectId);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(sections));
              return;
            }

            if (req.method === "POST") {
              const body = await parseBody(req);
              const section = await svc.sectionService.create(body as any);
              res.setHeader("Content-Type", "application/json");
              res.statusCode = 201;
              res.end(JSON.stringify(section));
              return;
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Internal server error";
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        next();
      });

      // ── Task Comments & Activity ───────────────────

      // GET/POST /api/tasks/:id/comments, GET /api/tasks/:id/activity
      server.middlewares.use(async (req, res, next) => {
        const commentMatch = req.url?.match(/^\/api\/tasks\/([^/]+)\/comments$/);
        if (commentMatch) {
          const taskId = decodeURIComponent(commentMatch[1]);
          const svc = await getServices();

          if (req.method === "GET") {
            try {
              const comments = svc.storage.listTaskComments(taskId);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(comments));
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : "Internal server error";
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: message }));
            }
            return;
          }

          if (req.method === "POST") {
            try {
              const body = await parseBody(req);
              const { generateId } = await import("./src/utils/ids.js");
              const now = new Date().toISOString();
              const comment = {
                id: generateId(),
                taskId,
                content: body.content as string,
                createdAt: now,
                updatedAt: now,
              };
              svc.storage.insertTaskComment(comment);
              res.setHeader("Content-Type", "application/json");
              res.statusCode = 201;
              res.end(JSON.stringify(comment));
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : "Internal server error";
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: message }));
            }
            return;
          }

          return next();
        }

        // GET /api/tasks/:id/activity
        const activityMatch = req.url?.match(/^\/api\/tasks\/([^/]+)\/activity$/);
        if (activityMatch && req.method === "GET") {
          const taskId = decodeURIComponent(activityMatch[1]);
          const svc = await getServices();
          try {
            const activity = svc.storage.listTaskActivity(taskId);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(activity));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Internal server error";
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        // PATCH/DELETE /api/comments/:id
        const singleCommentMatch = req.url?.match(/^\/api\/comments\/([^/]+)$/);
        if (singleCommentMatch) {
          const commentId = decodeURIComponent(singleCommentMatch[1]);
          const svc = await getServices();

          if (req.method === "PATCH") {
            try {
              const body = await parseBody(req);
              svc.storage.updateTaskComment(commentId, {
                content: body.content as string,
                updatedAt: new Date().toISOString(),
              });
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true }));
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : "Internal server error";
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: message }));
            }
            return;
          }

          if (req.method === "DELETE") {
            try {
              svc.storage.deleteTaskComment(commentId);
              res.statusCode = 204;
              res.end();
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : "Internal server error";
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: message }));
            }
            return;
          }

          return next();
        }

        next();
      });

      // Initialize plugins on first request (promise lock prevents double-init)
      let pluginInitPromise: Promise<void> | null = null;
      async function ensurePlugins() {
        if (!pluginInitPromise) {
          pluginInitPromise = (async () => {
            const svc = await getServices();
            // Use Vite's SSR module loader so .ts plugin files resolve correctly
            svc.pluginLoader.setModuleLoader((path) => server.ssrLoadModule(path));
            await svc.pluginLoader.loadAll();
          })();
        }
        await pluginInitPromise;
      }

      // GET /api/plugins — list all discovered plugins
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/plugins" || req.method !== "GET") return next();

        try {
          const svc = await getServices();
          await ensurePlugins();
          const plugins = svc.pluginLoader.getAll().map((p) => ({
            id: p.manifest.id,
            name: p.manifest.name,
            version: p.manifest.version,
            author: p.manifest.author,
            description: p.manifest.description,
            enabled: p.enabled,
            permissions: p.manifest.permissions,
            settings: p.manifest.settings,
            builtin: p.builtin ?? false,
            icon: p.manifest.icon,
          }));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(plugins));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // Plugin permissions: GET, approve, revoke
      server.middlewares.use(async (req, res, next) => {
        try {
          const approveMatch = req.url?.match(/^\/api\/plugins\/([^/]+)\/permissions\/approve$/);
          if (approveMatch && req.method === "POST") {
            const pluginId = approveMatch[1];
            const svc = await getServices();
            await ensurePlugins();
            const body = await parseBody(req);
            const { permissions } = body as { permissions: string[] };
            await svc.pluginLoader.approveAndLoad(pluginId, permissions);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          const revokeMatch = req.url?.match(/^\/api\/plugins\/([^/]+)\/permissions\/revoke$/);
          if (revokeMatch && req.method === "POST") {
            const pluginId = revokeMatch[1];
            const svc = await getServices();
            await ensurePlugins();
            await svc.pluginLoader.revokePermissions(pluginId);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          const permMatch = req.url?.match(/^\/api\/plugins\/([^/]+)\/permissions$/);
          if (permMatch && req.method === "GET") {
            const pluginId = permMatch[1];
            const svc = await getServices();
            const permissions = svc.storage.getPluginPermissions(pluginId);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ permissions }));
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

      // GET/PUT /api/plugins/:id/settings
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/plugins\/([^/]+)\/settings$/);
        if (!match) return next();

        try {
          const pluginId = match[1];
          const svc = await getServices();
          await ensurePlugins();

          if (req.method === "GET") {
            const plugin = svc.pluginLoader.get(pluginId);
            if (!plugin) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Plugin not found" }));
              return;
            }
            const stored = svc.settingsManager.getAll(pluginId);
            const definitions = plugin.manifest.settings ?? [];
            const values: Record<string, unknown> = {};
            for (const def of definitions) {
              values[def.id] = def.id in stored ? stored[def.id] : def.default;
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(values));
            return;
          }

          if (req.method === "PUT") {
            const body = await parseBody(req);
            const { key, value } = body as { key: string; value: unknown };
            await svc.settingsManager.set(pluginId, key, value);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
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

      // GET /api/plugins/commands — list all registered commands
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/plugins/commands" || req.method !== "GET") return next();

        try {
          const svc = await getServices();
          await ensurePlugins();
          const commands = svc.commandRegistry.getAll().map((c) => ({
            id: c.id,
            name: c.name,
            hotkey: c.hotkey,
          }));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(commands));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // POST /api/plugins/commands/:id — execute a command
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/plugins\/commands\/(.+)$/);
        if (!match || req.method !== "POST") return next();

        const svc = await getServices();
        await ensurePlugins();
        try {
          svc.commandRegistry.execute(decodeURIComponent(match[1]));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      // GET /api/plugins/ui/status-bar
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/plugins/ui/status-bar" || req.method !== "GET") return next();

        try {
          const svc = await getServices();
          await ensurePlugins();
          const items = svc.uiRegistry.getStatusBarItems().map((item) => ({
            id: item.id,
            text: item.text,
            icon: item.icon,
          }));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(items));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // GET /api/plugins/ui/panels
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/plugins/ui/panels" || req.method !== "GET") return next();

        try {
          const svc = await getServices();
          await ensurePlugins();
          const panels = svc.uiRegistry.getPanels().map((panel) => ({
            id: panel.id,
            title: panel.title,
            icon: panel.icon,
            content: svc.uiRegistry.getPanelContent(panel.id) ?? "",
          }));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(panels));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // GET /api/plugins/ui/views and GET /api/plugins/ui/views/:id/content
      server.middlewares.use(async (req, res, next) => {
        const contentMatch = req.url?.match(/^\/api\/plugins\/ui\/views\/([^/]+)\/content$/);
        if (!contentMatch && (req.url !== "/api/plugins/ui/views" || req.method !== "GET"))
          return next();

        try {
          if (contentMatch && req.method === "GET") {
            const svc = await getServices();
            await ensurePlugins();
            const content =
              svc.uiRegistry.getViewContent(decodeURIComponent(contentMatch[1])) ?? "";
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ content }));
            return;
          }

          const svc = await getServices();
          await ensurePlugins();
          const views = svc.uiRegistry.getViews().map((view) => ({
            id: view.id,
            name: view.name,
            icon: view.icon,
            slot: view.slot,
            contentType: view.contentType,
            pluginId: view.pluginId,
          }));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(views));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // POST /api/plugins/timeblocking/rpc — RPC bridge for timeblocking plugin store
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/plugins/timeblocking/rpc" || req.method !== "POST") return next();

        try {
          const svc = await getServices();
          await ensurePlugins();
          const body = await parseBody(req);
          const { method, args } = body as { method: string; args: unknown[] };

          // Get the timeblocking plugin instance
          const plugin = svc.pluginLoader.getAll().find((p) => p.manifest.id === "timeblocking");
          if (!plugin || !plugin.enabled) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Timeblocking plugin not loaded" }));
            return;
          }

          // Access the store from the plugin instance
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const instance = plugin.instance as any;
          const store = instance?.store;
          if (!store) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Timeblocking store not available" }));
            return;
          }

          // Route method calls
          let result: unknown;
          switch (method) {
            case "listBlocks":
              result = store.listBlocks(args[0] as string | undefined);
              break;
            case "listBlocksInRange":
              result = store.listBlocksInRange(args[0] as string, args[1] as string);
              break;
            case "listSlots":
              result = store.listSlots(args[0] as string | undefined);
              break;
            case "listSlotsInRange":
              result = store.listSlotsInRange(args[0] as string, args[1] as string);
              break;
            case "createBlock":
              result = await store.createBlock(args[0]);
              break;
            case "updateBlock":
              result = await store.updateBlock(args[0] as string, args[1]);
              break;
            case "deleteBlock":
              result = await store.deleteBlock(args[0] as string);
              break;
            case "createSlot":
              result = await store.createSlot(args[0]);
              break;
            case "addTaskToSlot":
              result = await store.addTaskToSlot(args[0] as string, args[1] as string);
              break;
            case "reorderSlotTasks":
              result = await store.reorderSlotTasks(args[0] as string, args[1] as string[]);
              break;
            case "getSettings": {
              const key = args[0] as string;
              const definitions = plugin.manifest.settings ?? [];
              const val = svc.settingsManager.get("timeblocking", key, definitions);
              result = val;
              break;
            }
            case "setSettings": {
              const sKey = args[0] as string;
              const sVal = args[1] as string;
              await svc.settingsManager.set("timeblocking", sKey, sVal);
              result = { ok: true };
              break;
            }
            case "listTasks": {
              const tasks = await svc.taskService.list();
              result = tasks;
              break;
            }
            default:
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: `Unknown method: ${method}` }));
              return;
          }

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ result: result ?? null }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // GET /api/plugins/store — read sources.json
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/plugins/store" || req.method !== "GET") return next();

        try {
          const sourcesPath = path.resolve(process.cwd(), "sources.json");
          const data = fs.readFileSync(sourcesPath, "utf-8");
          res.setHeader("Content-Type", "application/json");
          res.end(data);
        } catch {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ plugins: [] }));
        }
      });

      // POST /api/plugins/install — install a plugin from URL
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/plugins/install" || req.method !== "POST") return next();

        try {
          const svc = await getServices();
          await ensurePlugins();
          const body = await parseBody(req);
          const { pluginId, downloadUrl } = body as { pluginId: string; downloadUrl: string };

          const { PluginInstaller } = await import("./src/plugins/installer.js");
          const installer = new PluginInstaller(path.resolve(process.cwd(), "plugins"));

          const result = await installer.install(pluginId, downloadUrl);
          if (result.success) {
            const discovered = await svc.pluginLoader.discoverOne(pluginId);
            if (discovered) {
              try {
                await svc.pluginLoader.load(pluginId);
              } catch {
                // Plugin may need permission approval — that's fine
              }
            }
          }

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // POST /api/plugins/:id/uninstall — uninstall a plugin
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/plugins\/([^/]+)\/uninstall$/);
        if (!match || req.method !== "POST") return next();

        try {
          const pluginId = match[1];
          const svc = await getServices();
          await ensurePlugins();

          // Reject uninstall for built-in plugins
          const plugin = svc.pluginLoader.get(pluginId);
          if (plugin?.builtin) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({ success: false, error: "Cannot uninstall built-in extensions" }),
            );
            return;
          }

          // Unload plugin if loaded
          try {
            await svc.pluginLoader.unload(pluginId);
          } catch {
            // May not be loaded — that's fine
          }

          const { PluginInstaller } = await import("./src/plugins/installer.js");
          const installer = new PluginInstaller(path.resolve(process.cwd(), "plugins"));

          const result = await installer.uninstall(pluginId);
          if (result.success) {
            svc.storage.deletePluginPermissions(pluginId);
            svc.pluginLoader.remove(pluginId);
          }

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = message.includes("Invalid JSON") ? 400 : 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // POST /api/plugins/:id/toggle — activate/deactivate a built-in extension
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/plugins\/([^/]+)\/toggle$/);
        if (!match || req.method !== "POST") return next();

        try {
          const pluginId = match[1];
          const svc = await getServices();
          await ensurePlugins();

          const plugin = svc.pluginLoader.get(pluginId);
          if (!plugin) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Plugin not found" }));
            return;
          }

          if (plugin.enabled) {
            // Deactivate: unload and remove stored permissions
            await svc.pluginLoader.unload(pluginId);
            svc.storage.deletePluginPermissions(pluginId);
          } else {
            // Activate: approve all permissions and load
            const permissions = (plugin.manifest.permissions ?? []) as string[];
            await svc.pluginLoader.approveAndLoad(pluginId, permissions);
          }

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, enabled: plugin.enabled }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // GET /api/settings/storage — storage mode info
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/settings/storage" || req.method !== "GET") return next();

        const { loadEnv } = await import("./src/config/env.js");
        const env = loadEnv();
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            mode: env.STORAGE_MODE,
            path: env.STORAGE_MODE === "markdown" ? env.MARKDOWN_PATH : env.DB_PATH,
          }),
        );
      });

      // GET/PUT /api/settings/:key — generic app settings
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/settings\/([^/]+)$/);
        if (!match) return next();

        try {
          const key = decodeURIComponent(match[1]);
          const svc = await getServices();

          if (req.method === "GET") {
            const row = svc.storage.getAppSetting(key);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ value: row?.value ?? null }));
            return;
          }

          if (req.method === "PUT") {
            const body = await parseBody(req);
            svc.storage.setAppSetting(key, body.value as string);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
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

      // ── Stats Endpoints ──────────────────────────────────

      // GET /api/stats/daily?startDate=X&endDate=Y — daily stats for a date range
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        if (url.pathname !== "/api/stats/daily" || req.method !== "GET") return next();

        try {
          const svc = await getServices();
          const startDate = url.searchParams.get("startDate") ?? "";
          const endDate = url.searchParams.get("endDate") ?? "";
          const stats = await svc.statsService.getStats(startDate, endDate);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(stats));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // GET /api/stats/today — today's stats
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/stats/today" || req.method !== "GET") return next();

        try {
          const svc = await getServices();
          const stat = await svc.statsService.getToday();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(stat));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // ── AI Endpoints ──────────────────────────────────

      // GET /api/ai/providers — list all registered AI providers
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/ai/providers" || req.method !== "GET") return next();

        const svc = await getServices();
        const registry = svc.aiProviderRegistry;
        const providers = registry.getAll().map((r: any) => ({
          name: r.plugin.name,
          displayName: r.plugin.displayName,
          needsApiKey: r.plugin.needsApiKey,
          optionalApiKey: r.plugin.optionalApiKey ?? false,
          defaultModel: r.plugin.defaultModel,
          defaultBaseUrl: r.plugin.defaultBaseUrl,
          showBaseUrl: r.plugin.showBaseUrl ?? false,
          pluginId: r.pluginId,
        }));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(providers));
      });

      // GET/PUT /api/ai/config
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/ai/config")) return next();

        const svc = await getServices();

        if (req.method === "GET") {
          const providerSetting = svc.storage.getAppSetting("ai_provider");
          const modelSetting = svc.storage.getAppSetting("ai_model");
          const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
          const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              provider: providerSetting?.value ?? null,
              model: modelSetting?.value ?? null,
              baseUrl: baseUrlSetting?.value ?? null,
              hasApiKey: !!apiKeySetting?.value,
            }),
          );
          return;
        }

        if (req.method === "PUT") {
          const body = await parseBody(req);
          const { provider, apiKey, model, baseUrl } = body as {
            provider?: string;
            apiKey?: string;
            model?: string;
            baseUrl?: string;
          };
          if (provider) svc.storage.setAppSetting("ai_provider", provider);
          if (apiKey) svc.storage.setAppSetting("ai_api_key", apiKey);
          if (model !== undefined) {
            if (model) {
              svc.storage.setAppSetting("ai_model", model);
            } else {
              svc.storage.deleteAppSetting("ai_model");
            }
          }
          if (baseUrl !== undefined) {
            if (baseUrl) {
              svc.storage.setAppSetting("ai_base_url", baseUrl);
            } else {
              svc.storage.deleteAppSetting("ai_base_url");
            }
          }
          // Reset chat session when provider config changes
          svc.chatManager.clearSession(svc.storage);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        next();
      });

      // GET /api/ai/providers/:name/models — fetch available models for a provider
      server.middlewares.use(async (req, res, next) => {
        const modelsMatch = req.url?.match(/^\/api\/ai\/providers\/([^/]+)\/models(\?.*)?$/);
        if (!modelsMatch || req.method !== "GET") return next();

        try {
          const providerName = modelsMatch[1];
          const svc = await getServices();
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const baseUrlOverride = url.searchParams.get("baseUrl");

          const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
          const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

          const { fetchAvailableModels } = await import("./src/ai/model-discovery.js");
          const models = await fetchAvailableModels(providerName, {
            apiKey: apiKeySetting?.value,
            baseUrl: baseUrlOverride || baseUrlSetting?.value,
          });

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ models }));
        } catch {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ models: [] }));
        }
      });

      // POST /api/ai/providers/:name/models/load — load a model (LM Studio)
      server.middlewares.use(async (req, res, next) => {
        const loadMatch = req.url?.match(/^\/api\/ai\/providers\/([^/]+)\/models\/load$/);
        if (!loadMatch || req.method !== "POST") return next();

        try {
          const providerName = loadMatch[1];
          const svc = await getServices();
          const body = await parseBody(req);
          const { model: modelKey, baseUrl: baseUrlOverride } = body as {
            model: string;
            baseUrl?: string;
          };
          const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
          const apiKeySetting = svc.storage.getAppSetting("ai_api_key");

          if (providerName === "lmstudio") {
            const { loadLMStudioModel } = await import("./src/ai/model-discovery.js");
            await loadLMStudioModel(
              modelKey,
              (baseUrlOverride as string) || baseUrlSetting?.value || "http://localhost:1234/v1",
              apiKeySetting?.value,
            );
          }

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Failed to load model";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // POST /api/ai/chat — SSE streaming chat
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/ai/chat" || req.method !== "POST") return next();

        const svc = await getServices();
        const body = await parseBody(req);
        const message = (body as { message: string; voiceCall?: boolean; focusedTaskId?: string })
          .message;
        const voiceCall = (body as { voiceCall?: boolean }).voiceCall;
        const focusedTaskId = (body as { focusedTaskId?: string }).focusedTaskId;

        if (!message) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "message is required" }));
          return;
        }

        // Load provider config
        const providerSetting = svc.storage.getAppSetting("ai_provider");
        if (!providerSetting?.value) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.write(
            `data: ${JSON.stringify({ type: "error", data: "No AI provider configured. Go to Settings to set one up." })}\n\n`,
          );
          res.end();
          return;
        }

        try {
          const { gatherContext } = await import("./src/ai/chat.js");
          const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
          const modelSetting = svc.storage.getAppSetting("ai_model");
          const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

          const providerConfig = {
            provider: providerSetting.value as string,
            apiKey: apiKeySetting?.value,
            model: modelSetting?.value,
            baseUrl: baseUrlSetting?.value,
          };

          const executor = svc.aiProviderRegistry.createExecutor(providerConfig);

          const toolServices = {
            taskService: svc.taskService,
            projectService: svc.projectService,
            tagService: svc.tagService,
            statsService: svc.statsService,
            storage: svc.storage,
          };

          // Gather context for new sessions
          const isLocalProvider =
            providerSetting.value === "ollama" || providerSetting.value === "lmstudio";
          const contextBlock = await gatherContext(toolServices, {
            compact: isLocalProvider,
            voiceCall,
            focusedTaskId,
          });

          const session = svc.chatManager.getOrCreateSession(executor, toolServices, {
            queries: svc.storage,
            contextBlock,
            toolRegistry: svc.toolRegistry,
            model: modelSetting?.value ?? undefined,
            providerName: providerSetting.value as string,
          });

          session.addUserMessage(message);

          // SSE response
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");

          for await (const event of session.run()) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }

          res.end();
        } catch (err: any) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.write(
            `data: ${JSON.stringify({ type: "error", data: err.message ?? "Unknown error" })}\n\n`,
          );
          res.end();
        }
      });

      // GET /api/ai/messages — current chat history (from memory or DB)
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/ai/messages" || req.method !== "GET") return next();

        const svc = await getServices();
        let session = svc.chatManager.getSession();

        // Try to restore from DB if no in-memory session
        if (!session) {
          try {
            const providerSetting = svc.storage.getAppSetting("ai_provider");
            if (providerSetting?.value) {
              const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
              const modelSetting = svc.storage.getAppSetting("ai_model");
              const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

              const executor = svc.aiProviderRegistry.createExecutor({
                provider: providerSetting.value as string,
                apiKey: apiKeySetting?.value,
                model: modelSetting?.value,
                baseUrl: baseUrlSetting?.value,
              });

              session = svc.chatManager.restoreSession(
                executor,
                {
                  taskService: svc.taskService,
                  projectService: svc.projectService,
                  tagService: svc.tagService,
                  statsService: svc.statsService,
                  storage: svc.storage,
                },
                svc.storage,
                {
                  toolRegistry: svc.toolRegistry,
                  model: modelSetting?.value ?? undefined,
                  providerName: providerSetting.value as string,
                },
              );
            }
          } catch {
            // Non-critical — just return empty messages
          }
        }

        const messages = session ? session.getMessages() : [];
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(messages));
      });

      // POST /api/ai/clear — reset chat session
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/ai/clear" || req.method !== "POST") return next();

        const svc = await getServices();
        svc.chatManager.clearSession(svc.storage);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });

      // ── AI Session Endpoints ──────────────────────────

      // GET /api/ai/sessions — list all chat sessions
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/ai/sessions" || req.method !== "GET") return next();

        const svc = await getServices();
        const sessions = svc.storage.listChatSessions();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(sessions));
      });

      // POST /api/ai/sessions/new — start a new chat session
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/ai/sessions/new" || req.method !== "POST") return next();

        const svc = await getServices();
        // Fire-and-forget memory extraction from current session
        const currentSession = svc.chatManager.getSession();
        if (currentSession) {
          currentSession.extractMemories().catch(() => {});
        }
        (svc.chatManager as any).session = null;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ sessionId: "" }));
      });

      // AI session operations: rename, delete, switch, unload
      server.middlewares.use(async (req, res, next) => {
        // PUT /api/ai/sessions/:id/title — rename a session
        const titleMatch = req.url?.match(/^\/api\/ai\/sessions\/([^/]+)\/title$/);
        if (titleMatch && req.method === "PUT") {
          try {
            const svc = await getServices();
            const sessionId = decodeURIComponent(titleMatch[1]);
            const body = await parseBody(req);
            const title = (body as { title: string }).title;
            svc.storage.renameChatSession(sessionId, title);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Internal server error";
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        // POST /api/ai/sessions/:id/switch — switch to a session
        const switchMatch = req.url?.match(/^\/api\/ai\/sessions\/([^/]+)\/switch$/);
        if (switchMatch && req.method === "POST") {
          try {
            const svc = await getServices();
            // Fire-and-forget memory extraction from current session
            const currentSession = svc.chatManager.getSession();
            if (currentSession) {
              currentSession.extractMemories().catch(() => {});
            }
            const sessionId = decodeURIComponent(switchMatch[1]);
            const providerSetting = svc.storage.getAppSetting("ai_provider");
            if (!providerSetting?.value) {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify([]));
              return;
            }

            const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
            const modelSetting = svc.storage.getAppSetting("ai_model");
            const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

            const executor = svc.aiProviderRegistry.createExecutor({
              provider: providerSetting.value as string,
              apiKey: apiKeySetting?.value,
              model: modelSetting?.value,
              baseUrl: baseUrlSetting?.value,
            });

            const rows = svc.storage.listChatMessages(sessionId);
            if (rows.length === 0) {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify([]));
              return;
            }

            const toolServices = {
              taskService: svc.taskService,
              projectService: svc.projectService,
              tagService: svc.tagService,
              statsService: svc.statsService,
              storage: svc.storage,
            };

            const systemMessage = svc.chatManager.buildSystemMessage(
              toolServices,
              "",
              providerSetting.value as string,
            );
            const { ChatSession } = await import("./src/ai/chat.js");
            const session = new ChatSession(executor, toolServices, systemMessage, {
              sessionId,
              queries: svc.storage,
              toolRegistry: svc.toolRegistry,
              model: modelSetting?.value ?? undefined,
              providerName: providerSetting.value as string,
            });

            for (const row of rows) {
              if (row.role === "system") continue;
              const msg = {
                role: row.role as "user" | "assistant" | "tool",
                content: row.content,
                ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
                ...(row.toolCalls ? { toolCalls: JSON.parse(row.toolCalls) } : {}),
              };
              (session as any).messages.push(msg);
            }

            (svc.chatManager as any).session = session;
            const messages = session.getMessages();
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(messages));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Internal server error";
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        // DELETE /api/ai/sessions/:id — delete a session
        const deleteMatch = req.url?.match(/^\/api\/ai\/sessions\/([^/]+)$/);
        if (deleteMatch && req.method === "DELETE") {
          try {
            const svc = await getServices();
            const sessionId = decodeURIComponent(deleteMatch[1]);
            svc.storage.deleteChatSession(sessionId);
            svc.storage.deleteAppSetting(`chat_session_title:${sessionId}`);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Internal server error";
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        // POST /api/ai/providers/:name/models/unload — unload a model
        const unloadMatch = req.url?.match(/^\/api\/ai\/providers\/([^/]+)\/models\/unload$/);
        if (unloadMatch && req.method === "POST") {
          try {
            const providerName = decodeURIComponent(unloadMatch[1]);
            const svc = await getServices();
            const body = await parseBody(req);
            const { model: modelKey, baseUrl: baseUrlOverride } = body as {
              model: string;
              baseUrl?: string;
            };
            const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
            const apiKeySetting = svc.storage.getAppSetting("ai_api_key");

            if (providerName === "lmstudio") {
              const { unloadLMStudioModel } = await import("./src/ai/model-discovery.js");
              await unloadLMStudioModel(
                modelKey,
                (baseUrlOverride as string) || baseUrlSetting?.value || "http://localhost:1234/v1",
                apiKeySetting?.value,
              );
            }

            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Failed to unload model";
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        next();
      });

      // ── AI Memory Endpoints ──────────────────────────

      // GET /api/ai/memories — list all AI memories
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/ai/memories" || req.method !== "GET") return next();

        const svc = await getServices();
        const memories = svc.storage.listAiMemories();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(memories));
      });

      // AI memory operations: update, delete
      server.middlewares.use(async (req, res, next) => {
        // PUT /api/ai/memories/:id — update a memory
        const updateMatch = req.url?.match(/^\/api\/ai\/memories\/([^/]+)$/);
        if (updateMatch && req.method === "PUT") {
          try {
            const svc = await getServices();
            const id = decodeURIComponent(updateMatch[1]);
            const body = await parseBody(req);
            const { content, category } = body as { content: string; category: string };
            svc.storage.updateAiMemory(id, content, category as any);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Internal server error";
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        // DELETE /api/ai/memories/:id — delete a memory
        const deleteMatch = req.url?.match(/^\/api\/ai\/memories\/([^/]+)$/);
        if (deleteMatch && req.method === "DELETE") {
          try {
            const svc = await getServices();
            const id = decodeURIComponent(deleteMatch[1]);
            svc.storage.deleteAiMemory(id);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Internal server error";
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        next();
      });

      // ── Voice Proxy Endpoints ──────────────────────────

      // POST /api/voice/transcribe — proxy to Groq STT
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/voice/transcribe" || req.method !== "POST") return next();

        try {
          const apiKey = req.headers["x-api-key"] as string;
          if (!apiKey) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Missing API key" }));
            return;
          }

          // Collect raw body for multipart forwarding
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }
          const bodyBuffer = Buffer.concat(chunks);

          const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": req.headers["content-type"]!,
            },
            body: bodyBuffer,
          });

          const data = await groqRes.text();
          res.statusCode = groqRes.status;
          res.setHeader("Content-Type", "application/json");
          res.end(data);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Transcription proxy error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // POST /api/voice/synthesize — proxy to Groq TTS
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/voice/synthesize" || req.method !== "POST") return next();

        try {
          const apiKey = req.headers["x-api-key"] as string;
          if (!apiKey) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Missing API key" }));
            return;
          }

          const body = await parseBody(req);

          const groqRes = await fetch("https://api.groq.com/openai/v1/audio/speech", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });

          if (!groqRes.ok) {
            const errText = await groqRes.text();
            res.statusCode = groqRes.status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: errText }));
            return;
          }

          const audioBuffer = await groqRes.arrayBuffer();
          res.setHeader("Content-Type", "audio/wav");
          res.end(Buffer.from(audioBuffer));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Synthesis proxy error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // POST /api/voice/inworld-synthesize — streaming proxy to Inworld AI TTS
      // Uses the streaming endpoint (/voice:stream) for lower time-to-first-audio.
      // Reads NDJSON chunks, decodes base64 audioContent, streams raw bytes to client.
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/voice/inworld-synthesize" || req.method !== "POST") return next();

        try {
          const apiKey = req.headers["x-api-key"] as string;
          if (!apiKey) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Missing API key" }));
            return;
          }

          const body = await parseBody(req);

          const inworldRes = await fetch("https://api.inworld.ai/tts/v1/voice:stream", {
            method: "POST",
            headers: {
              Authorization: `Basic ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });

          if (!inworldRes.ok) {
            const errText = await inworldRes.text();
            res.statusCode = inworldRes.status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: errText }));
            return;
          }

          res.setHeader("Content-Type", "audio/mpeg");

          // Parse NDJSON stream: each line is {"result":{"audioContent":"<base64>",...}}
          const reader = inworldRes.body!.getReader();
          const decoder = new TextDecoder();
          let ndjsonBuf = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ndjsonBuf += decoder.decode(value, { stream: true });

            // Process complete lines
            while (ndjsonBuf.includes("\n")) {
              const idx = ndjsonBuf.indexOf("\n");
              const line = ndjsonBuf.slice(0, idx).trim();
              ndjsonBuf = ndjsonBuf.slice(idx + 1);

              if (!line) continue;
              try {
                const chunk = JSON.parse(line);
                if (chunk.error) {
                  // Stream-level error from Inworld
                  if (!res.headersSent) {
                    res.statusCode = 500;
                    res.setHeader("Content-Type", "application/json");
                  }
                  res.end(JSON.stringify({ error: chunk.error.message ?? "Inworld stream error" }));
                  return;
                }
                const audioB64 = chunk.result?.audioContent;
                if (audioB64) {
                  res.write(Buffer.from(audioB64, "base64"));
                }
              } catch {
                // Skip malformed NDJSON lines
              }
            }
          }

          res.end();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Inworld synthesis proxy error";
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
          }
          res.end(JSON.stringify({ error: message }));
        }
      });

      // GET /api/voice/inworld-voices — proxy to Inworld AI voice list
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/voice/inworld-voices" || req.method !== "GET") return next();

        try {
          const apiKey = req.headers["x-api-key"] as string;
          if (!apiKey) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Missing API key" }));
            return;
          }

          const inworldRes = await fetch("https://api.inworld.ai/tts/v1/voices", {
            headers: {
              Authorization: `Basic ${apiKey}`,
            },
          });

          if (!inworldRes.ok) {
            const errText = await inworldRes.text();
            res.statusCode = inworldRes.status;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: errText }));
            return;
          }

          const data = await inworldRes.json();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Inworld voices proxy error";
          res.statusCode = 500;
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
              (body as any).relatedTaskId,
              (body as any).type ?? "blocks",
            );
            res.statusCode = 201;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
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

      // /api/tasks/:id/complete and /api/tasks/:id
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/tasks\/([^/]+)\/complete$/);
        if (match && req.method === "POST") {
          const svc = await getServices();
          try {
            const task = await svc.taskService.complete(match[1]);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(task));
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

        if (req.method === "PATCH") {
          try {
            const body = await parseBody(req);
            const task = await svc.taskService.update(id, body as any);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(task));
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
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    tailwindcss(),
    react(),
    ...(command === "serve" ? [apiPlugin()] : []),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
          dest: "",
        },
        {
          src: "node_modules/onnxruntime-web/dist/*.wasm",
          dest: "",
        },
      ],
    }),
  ],
  resolve: {
    alias: {
      "@": "/src",
      // kokoro-js default entry imports Node.js-only modules (path, fs/promises).
      // Point to the self-contained web build for browser/worker compatibility.
      "kokoro-js": path.resolve(__dirname, "node_modules/kokoro-js/dist/kokoro.web.js"),
    },
  },
  worker: {
    format: "es",
  },
  build: {
    rollupOptions: {
      external: ["better-sqlite3"],
    },
  },
  optimizeDeps: {
    exclude: ["sql.js", "@mintplex-labs/piper-tts-web", "onnxruntime-web"],
  },
}));
