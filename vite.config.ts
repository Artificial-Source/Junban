import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import type { ViteDevServer } from "vite";
import type { IncomingMessage } from "node:http";

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
  });
}

function apiPlugin() {
  return {
    name: "docket-api",
    configureServer(server: ViteDevServer) {
      // Lazy-load bootstrap to avoid issues with Vite's module resolution
      let services: Awaited<
        ReturnType<typeof import("./src/bootstrap.js").bootstrap>
      > | null = null;

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
      });

      // GET /api/projects
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/projects" || req.method !== "GET") return next();

        const svc = await getServices();
        const projects = await svc.projectService.list();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(projects));
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
      });

      // GET/PUT /api/plugins/:id/settings
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/plugins\/([^/]+)\/settings$/);
        if (!match) return next();

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
      });

      // GET /api/plugins/commands — list all registered commands
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/plugins/commands" || req.method !== "GET") return next();

        const svc = await getServices();
        await ensurePlugins();
        const commands = svc.commandRegistry.getAll().map((c) => ({
          id: c.id,
          name: c.name,
          hotkey: c.hotkey,
        }));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(commands));
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

        const svc = await getServices();
        await ensurePlugins();
        const items = svc.uiRegistry.getStatusBarItems().map((item) => ({
          id: item.id,
          text: item.text,
          icon: item.icon,
        }));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(items));
      });

      // GET /api/plugins/ui/panels
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/plugins/ui/panels" || req.method !== "GET") return next();

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
      });

      // GET /api/plugins/ui/views and GET /api/plugins/ui/views/:id/content
      server.middlewares.use(async (req, res, next) => {
        const contentMatch = req.url?.match(/^\/api\/plugins\/ui\/views\/([^/]+)\/content$/);
        if (contentMatch && req.method === "GET") {
          const svc = await getServices();
          await ensurePlugins();
          const content = svc.uiRegistry.getViewContent(decodeURIComponent(contentMatch[1])) ?? "";
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ content }));
          return;
        }

        if (req.url !== "/api/plugins/ui/views" || req.method !== "GET") return next();

        const svc = await getServices();
        await ensurePlugins();
        const views = svc.uiRegistry.getViews().map((view) => ({
          id: view.id,
          name: view.name,
          icon: view.icon,
        }));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(views));
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

export default defineConfig({
  plugins: [react(), apiPlugin()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
