import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
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

      // POST /api/tasks/bulk/complete
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/tasks/bulk/complete" || req.method !== "POST") return next();
        const svc = await getServices();
        const body = await parseBody(req);
        const { ids } = body as { ids: string[] };
        const tasks = await svc.taskService.completeMany(ids);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(tasks));
      });

      // POST /api/tasks/bulk/delete
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/tasks/bulk/delete" || req.method !== "POST") return next();
        const svc = await getServices();
        const body = await parseBody(req);
        const { ids } = body as { ids: string[] };
        await svc.taskService.deleteMany(ids);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });

      // POST /api/tasks/bulk/update
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/tasks/bulk/update" || req.method !== "POST") return next();
        const svc = await getServices();
        const body = await parseBody(req);
        const { ids, changes } = body as { ids: string[]; changes: any };
        const tasks = await svc.taskService.updateMany(ids, changes);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(tasks));
      });

      // POST /api/tasks/reorder
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/tasks/reorder" || req.method !== "POST") return next();
        const svc = await getServices();
        const body = await parseBody(req);
        const { orderedIds } = body as { orderedIds: string[] };
        await svc.taskService.reorder(orderedIds);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });

      // POST /api/tasks/import — import tasks from external formats
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/tasks/import" || req.method !== "POST") return next();
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

      // Plugin permissions: GET, approve, revoke
      server.middlewares.use(async (req, res, next) => {
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

      // POST /api/plugins/install — install a plugin from URL
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/plugins/install" || req.method !== "POST") return next();

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
      });

      // POST /api/plugins/:id/uninstall — uninstall a plugin
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/^\/api\/plugins\/([^/]+)\/uninstall$/);
        if (!match || req.method !== "POST") return next();

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
      });

      // ── AI Endpoints ──────────────────────────────────

      // GET /api/ai/providers — list all registered AI providers
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/api/ai/providers" || req.method !== "GET") return next();

        const svc = await getServices();
        const registry = (svc as any).aiProviderRegistry;
        if (registry) {
          const providers = registry.getAll().map((r: any) => ({
            name: r.name,
            displayName: r.displayName,
            needsApiKey: r.needsApiKey,
            defaultModel: r.defaultModel,
            defaultBaseUrl: r.defaultBaseUrl,
            showBaseUrl: r.showBaseUrl ?? false,
            pluginId: r.pluginId,
          }));
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(providers));
        } else {
          // Fallback: return built-in providers
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify([
              {
                name: "openai",
                displayName: "OpenAI",
                needsApiKey: true,
                defaultModel: "gpt-4o",
                showBaseUrl: false,
                pluginId: null,
              },
              {
                name: "anthropic",
                displayName: "Anthropic",
                needsApiKey: true,
                defaultModel: "claude-sonnet-4-5-20250929",
                showBaseUrl: false,
                pluginId: null,
              },
              {
                name: "openrouter",
                displayName: "OpenRouter",
                needsApiKey: true,
                defaultModel: "anthropic/claude-sonnet-4-5-20250929",
                showBaseUrl: false,
                pluginId: null,
              },
              {
                name: "ollama",
                displayName: "Ollama (local)",
                needsApiKey: false,
                defaultModel: "llama3.2",
                defaultBaseUrl: "http://localhost:11434",
                showBaseUrl: true,
                pluginId: null,
              },
              {
                name: "lmstudio",
                displayName: "LM Studio (local)",
                needsApiKey: false,
                defaultModel: "default",
                defaultBaseUrl: "http://localhost:1234",
                showBaseUrl: true,
                pluginId: null,
              },
            ]),
          );
        }
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
          const { createProvider } = await import("./src/ai/provider.js");
          const { gatherContext } = await import("./src/ai/chat.js");
          const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
          const modelSetting = svc.storage.getAppSetting("ai_model");
          const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

          const provider = createProvider({
            provider: providerSetting.value as any,
            apiKey: apiKeySetting?.value,
            model: modelSetting?.value,
            baseUrl: baseUrlSetting?.value,
          });

          const toolServices = {
            taskService: svc.taskService,
            projectService: svc.projectService,
          };

          // Gather context for new sessions
          const contextBlock = await gatherContext(toolServices);

          const session = svc.chatManager.getOrCreateSession(
            provider,
            toolServices,
            svc.storage,
            contextBlock,
          );

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
              const { createProvider } = await import("./src/ai/provider.js");
              const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
              const modelSetting = svc.storage.getAppSetting("ai_model");
              const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

              const provider = createProvider({
                provider: providerSetting.value as any,
                apiKey: apiKeySetting?.value,
                model: modelSetting?.value,
                baseUrl: baseUrlSetting?.value,
              });

              session = svc.chatManager.restoreSession(
                provider,
                { taskService: svc.taskService, projectService: svc.projectService },
                svc.storage,
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
  plugins: [tailwindcss(), react(), ...(command === "serve" ? [apiPlugin()] : [])],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  build: {
    rollupOptions: {
      external: ["better-sqlite3"],
    },
  },
  optimizeDeps: {
    exclude: ["sql.js"],
  },
}));
