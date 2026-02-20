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

      // GET /api/projects
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/projects" || req.method !== "GET") return next();

        try {
          const svc = await getServices();
          const projects = await svc.projectService.list();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(projects));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal server error";
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      });

      // Initialize plugins on first request
      let pluginsInitialized = false;
      async function ensurePlugins() {
        if (!pluginsInitialized) {
          const svc = await getServices();
          await svc.pluginLoader.loadAll();
          pluginsInitialized = true;
        }
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
        const message = (body as { message: string }).message;

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
          };

          // Gather context for new sessions
          const contextBlock = await gatherContext(toolServices);

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
                { taskService: svc.taskService, projectService: svc.projectService },
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
          src: "node_modules/@ricky0123/vad-web/dist/silero_vad.onnx",
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
  build: {
    rollupOptions: {
      external: ["better-sqlite3"],
    },
  },
  optimizeDeps: {
    exclude: ["sql.js", "@mintplex-labs/piper-tts-web", "onnxruntime-web"],
  },
}));
