import fs from "node:fs";
import path from "node:path";
import type { ViteDevServer } from "vite";
import type { GetServices } from "./types.js";
import { parseBody } from "./types.js";

// Plugin initialization lock — shared across all plugin routes
let pluginInitPromise: Promise<void> | null = null;

export function createEnsurePlugins(server: ViteDevServer, getServices: GetServices) {
  return async function ensurePlugins() {
    if (!pluginInitPromise) {
      pluginInitPromise = (async () => {
        const svc = await getServices();
        // Use Vite's SSR module loader so .ts plugin files resolve correctly
        svc.pluginLoader.setModuleLoader((modulePath: string) =>
          server.ssrLoadModule(modulePath),
        );
        await svc.pluginLoader.loadAll();
      })();
    }
    await pluginInitPromise;
  };
}

export function registerPluginRoutes(
  server: ViteDevServer,
  getServices: GetServices,
) {
  const ensurePlugins = createEnsurePlugins(server, getServices);

  // GET /api/plugins — list all discovered plugins
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/plugins" || req.method !== "GET") return next();

    try {
      const svc = await getServices();
      await ensurePlugins();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugins = svc.pluginLoader.getAll().map((p: any) => ({
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const commands = svc.commandRegistry.getAll().map((c: any) => ({
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = svc.uiRegistry.getStatusBarItems().map((item: any) => ({
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const panels = svc.uiRegistry.getPanels().map((panel: any) => ({
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const views = svc.uiRegistry.getViews().map((view: any) => ({
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugin = svc.pluginLoader.getAll().find((p: any) => p.manifest.id === "timeblocking");
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

      const { PluginInstaller } = await import("../src/plugins/installer.js");
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

      const { PluginInstaller } = await import("../src/plugins/installer.js");
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
}
