import fs from "node:fs";
import path from "node:path";
import type { ViteDevServer } from "vite";
import type { GetServices } from "./types.js";
import { parseBody } from "./types.js";
import { ValidationError } from "../src/core/errors.js";
import { validateOutboundNetworkUrl } from "../src/plugins/network-policy.js";
import {
  areCommunityPluginsEnabled,
  COMMUNITY_PLUGINS_DISABLED_ERROR,
  hasSettingsPermission,
  settingsPermissionError,
  validateApprovalPermissions,
} from "../src/plugins/route-policy.js";
import {
  expectRpcObject,
  expectRpcOptionalString,
  expectRpcString,
  expectRpcStringArray,
  validateTimeblockingRpcPayload,
} from "../src/plugins/timeblocking-rpc-validation.js";

// Plugin initialization lock — shared across all plugin routes
let pluginInitPromise: Promise<void> | null = null;

function statusFromError(message: string, err: unknown): number {
  if (message.includes("Invalid JSON") || err instanceof ValidationError) {
    return 400;
  }
  return 500;
}

export function createEnsurePlugins(server: ViteDevServer, getServices: GetServices) {
  return async function ensurePlugins() {
    if (!pluginInitPromise) {
      pluginInitPromise = (async () => {
        const svc = await getServices();
        // Use Vite's SSR module loader so .ts plugin files resolve correctly
        svc.pluginLoader.setModuleLoader((modulePath: string) => server.ssrLoadModule(modulePath));
        await svc.pluginLoader.loadAll();
      })();
    }
    await pluginInitPromise;
  };
}

export function registerPluginRoutes(server: ViteDevServer, getServices: GetServices) {
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

        // Block approving community plugins when restricted mode is on
        const plugin = svc.pluginLoader.get(pluginId);
        if (plugin && !plugin.builtin && !areCommunityPluginsEnabled(svc.storage)) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: COMMUNITY_PLUGINS_DISABLED_ERROR }));
          return;
        }

        const body = await parseBody(req);
        const { permissions } = body as { permissions: string[] };
        const validation = validateApprovalPermissions(permissions);
        if (!validation.ok) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: validation.error }));
          return;
        }

        await svc.pluginLoader.approveAndLoad(pluginId, validation.permissions);
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
        if (!hasSettingsPermission(plugin.manifest.permissions)) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: settingsPermissionError(pluginId) }));
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
        const plugin = svc.pluginLoader.get(pluginId);
        if (!plugin) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Plugin not found" }));
          return;
        }
        if (!hasSettingsPermission(plugin.manifest.permissions)) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: settingsPermissionError(pluginId) }));
          return;
        }

        const body = await parseBody(req);
        const { key, value } = body as { key: string; value: unknown };
        const definitions = plugin.manifest.settings ?? [];
        await svc.settingsManager.setSetting(pluginId, key, value, definitions);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      next();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = statusFromError(message, err);
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

  // POST /api/plugins/ui/status-bar/:id/click
  server.middlewares.use(async (req, res, next) => {
    const match = req.url?.match(/^\/api\/plugins\/ui\/status-bar\/([^/]+)\/click$/);
    if (!match || req.method !== "POST") return next();

    try {
      const svc = await getServices();
      await ensurePlugins();

      const id = decodeURIComponent(match[1]);
      const item = svc.uiRegistry.getStatusBarItems().find((entry) => entry.id === id);
      if (!item) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Status bar item not found" }));
        return;
      }

      if (item.onClick) {
        item.onClick();
      }

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal server error";
      res.statusCode = statusFromError(message, err);
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
        pluginId: panel.pluginId,
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
        const content = svc.uiRegistry.getViewContent(decodeURIComponent(contentMatch[1])) ?? "";
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
      const payloadValidation = validateTimeblockingRpcPayload(await parseBody(req));
      if (!payloadValidation.ok) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: payloadValidation.error }));
        return;
      }
      const { method, args } = payloadValidation.value;

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
        case "listBlocks": {
          const date = expectRpcOptionalString(args, 0, "date");
          if (!date.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: date.error }));
            return;
          }

          result = store.listBlocks(date.value);
          break;
        }
        case "listBlocksInRange": {
          const start = expectRpcString(args, 0, "startDate");
          if (!start.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: start.error }));
            return;
          }

          const end = expectRpcString(args, 1, "endDate");
          if (!end.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: end.error }));
            return;
          }

          result = store.listBlocksInRange(start.value, end.value);
          break;
        }
        case "listSlots": {
          const date = expectRpcOptionalString(args, 0, "date");
          if (!date.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: date.error }));
            return;
          }

          result = store.listSlots(date.value);
          break;
        }
        case "listSlotsInRange": {
          const start = expectRpcString(args, 0, "startDate");
          if (!start.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: start.error }));
            return;
          }

          const end = expectRpcString(args, 1, "endDate");
          if (!end.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: end.error }));
            return;
          }

          result = store.listSlotsInRange(start.value, end.value);
          break;
        }
        case "createBlock": {
          const input = expectRpcObject(args, 0, "block input");
          if (!input.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: input.error }));
            return;
          }

          result = await store.createBlock(input.value);
          break;
        }
        case "updateBlock": {
          const id = expectRpcString(args, 0, "blockId");
          if (!id.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: id.error }));
            return;
          }

          const updates = expectRpcObject(args, 1, "block updates");
          if (!updates.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: updates.error }));
            return;
          }

          result = await store.updateBlock(id.value, updates.value);
          break;
        }
        case "deleteBlock": {
          const id = expectRpcString(args, 0, "blockId");
          if (!id.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: id.error }));
            return;
          }

          result = await store.deleteBlock(id.value);
          break;
        }
        case "createSlot": {
          const input = expectRpcObject(args, 0, "slot input");
          if (!input.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: input.error }));
            return;
          }

          result = await store.createSlot(input.value);
          break;
        }
        case "addTaskToSlot": {
          const slotId = expectRpcString(args, 0, "slotId");
          if (!slotId.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: slotId.error }));
            return;
          }

          const taskId = expectRpcString(args, 1, "taskId");
          if (!taskId.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: taskId.error }));
            return;
          }

          result = await store.addTaskToSlot(slotId.value, taskId.value);
          break;
        }
        case "reorderSlotTasks": {
          const slotId = expectRpcString(args, 0, "slotId");
          if (!slotId.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: slotId.error }));
            return;
          }

          const taskIds = expectRpcStringArray(args, 1, "taskIds");
          if (!taskIds.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: taskIds.error }));
            return;
          }

          result = await store.reorderSlotTasks(slotId.value, taskIds.value);
          break;
        }
        case "getSettings": {
          if (!hasSettingsPermission(plugin.manifest.permissions)) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: settingsPermissionError(plugin.manifest.id) }));
            return;
          }

          const key = expectRpcString(args, 0, "settingKey");
          if (!key.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: key.error }));
            return;
          }

          const definitions = plugin.manifest.settings ?? [];
          const val = svc.settingsManager.get(plugin.manifest.id, key.value, definitions);
          result = val;
          break;
        }
        case "setSettings": {
          if (!hasSettingsPermission(plugin.manifest.permissions)) {
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: settingsPermissionError(plugin.manifest.id) }));
            return;
          }

          const sKey = expectRpcString(args, 0, "settingKey");
          if (!sKey.ok) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: sKey.error }));
            return;
          }
          if (args[1] === undefined) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "settingValue (args[1]) is required" }));
            return;
          }

          const sVal = args[1] as unknown;
          const definitions = plugin.manifest.settings ?? [];
          await svc.settingsManager.setSetting(plugin.manifest.id, sKey.value, sVal, definitions);
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
      res.statusCode = statusFromError(message, err);
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

      try {
        validateOutboundNetworkUrl(downloadUrl, {
          context: "plugin install download",
          requireHttps: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid download URL";
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: false, error: message }));
        return;
      }

      const { PluginInstaller } = await import("../src/plugins/installer.js");
      const installer = new PluginInstaller(path.resolve(process.cwd(), "plugins"));

      const result = await installer.install(pluginId, downloadUrl);
      if (result.success) {
        const discovered = await svc.pluginLoader.discoverOne(pluginId);
        if (!discovered) {
          await installer.uninstall(pluginId);
          res.statusCode = 409;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              success: false,
              error: `Plugin "${pluginId}" was installed but rejected during discovery (duplicate or invalid plugin ID)`,
            }),
          );
          return;
        }

        try {
          await svc.pluginLoader.load(pluginId);
        } catch {
          // Plugin may need permission approval — that's fine
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
        res.end(JSON.stringify({ success: false, error: "Cannot uninstall built-in extensions" }));
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

      // Block enabling community plugins when restricted mode is on
      if (!plugin.enabled && !plugin.builtin && !areCommunityPluginsEnabled(svc.storage)) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: COMMUNITY_PLUGINS_DISABLED_ERROR }));
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
