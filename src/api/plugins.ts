import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import type { AppServices } from "../bootstrap.js";
import { loadEnv } from "../config/env.js";
import { validateOutboundNetworkUrl } from "../plugins/network-policy.js";
import {
  areCommunityPluginsEnabled,
  COMMUNITY_PLUGINS_DISABLED_ERROR,
  hasSettingsPermission,
  settingsPermissionError,
  validateApprovalPermissions,
} from "../plugins/route-policy.js";
import {
  expectRpcObject,
  expectRpcOptionalString,
  expectRpcString,
  expectRpcStringArray,
  validateTimeblockingRpcPayload,
} from "../plugins/timeblocking-rpc-validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PluginRoutesOptions {
  ensurePluginsLoaded?: () => Promise<void>;
}

export function pluginRoutes(services: AppServices, options: PluginRoutesOptions = {}): Hono {
  const app = new Hono();
  const pluginInstallDir = path.resolve(loadEnv().PLUGIN_DIR);

  // Promise lock to prevent double plugin init
  let pluginInitPromise: Promise<void> | null = null;
  async function ensurePluginsViaLoader() {
    if (!pluginInitPromise) {
      pluginInitPromise = services.pluginLoader.loadAll().catch((err) => {
        pluginInitPromise = null;
        throw err;
      });
    }
    await pluginInitPromise;
  }

  const ensurePlugins = options.ensurePluginsLoaded ?? ensurePluginsViaLoader;

  // GET /plugins/commands — list all registered commands
  app.get("/commands", async (c) => {
    await ensurePlugins();
    const commands = services.commandRegistry.getAll().map((cmd) => ({
      id: cmd.id,
      name: cmd.name,
      hotkey: cmd.hotkey,
    }));
    return c.json(commands);
  });

  // POST /plugins/commands/:id — execute a command
  app.post("/commands/:id", async (c) => {
    await ensurePlugins();
    const id = decodeURIComponent(c.req.param("id"));
    services.commandRegistry.execute(id);
    return c.json({ ok: true });
  });

  // GET /plugins/ui/status-bar
  app.get("/ui/status-bar", async (c) => {
    await ensurePlugins();
    const items = services.uiRegistry.getStatusBarItems().map((item) => ({
      id: item.id,
      text: item.text,
      icon: item.icon,
    }));
    return c.json(items);
  });

  // POST /plugins/ui/status-bar/:id/click
  app.post("/ui/status-bar/:id/click", async (c) => {
    await ensurePlugins();
    const id = decodeURIComponent(c.req.param("id"));
    const items = services.uiRegistry.getStatusBarItems();
    const item = items.find((i) => i.id === id);
    if (!item) {
      return c.json({ error: "Status bar item not found" }, 404);
    }
    if (item.onClick) {
      item.onClick();
    }
    return c.json({ ok: true });
  });

  // GET /plugins/ui/panels
  app.get("/ui/panels", async (c) => {
    await ensurePlugins();
    const panels = services.uiRegistry.getPanels().map((panel) => ({
      id: panel.id,
      pluginId: panel.pluginId,
      title: panel.title,
      icon: panel.icon,
      content: services.uiRegistry.getPanelContent(panel.id) ?? "",
    }));
    return c.json(panels);
  });

  // GET /plugins/ui/views/:id/content
  app.get("/ui/views/:id/content", async (c) => {
    await ensurePlugins();
    const viewId = decodeURIComponent(c.req.param("id"));
    const content = services.uiRegistry.getViewContent(viewId) ?? "";
    return c.json({ content });
  });

  // GET /plugins/ui/views
  app.get("/ui/views", async (c) => {
    await ensurePlugins();
    const views = services.uiRegistry.getViews().map((view) => ({
      id: view.id,
      name: view.name,
      icon: view.icon,
      slot: view.slot,
      contentType: view.contentType,
      pluginId: view.pluginId,
    }));
    return c.json(views);
  });

  // GET /plugins/store — read sources.json
  app.get("/store", async (c) => {
    try {
      const sourcesPath = path.resolve(__dirname, "../../sources.json");
      const data = fs.readFileSync(sourcesPath, "utf-8");
      return c.json(JSON.parse(data));
    } catch {
      return c.json({ plugins: [] });
    }
  });

  // POST /plugins/install
  app.post("/install", async (c) => {
    await ensurePlugins();
    const body = await c.req.json();
    const { pluginId, downloadUrl } = body as { pluginId: string; downloadUrl: string };

    try {
      validateOutboundNetworkUrl(downloadUrl, {
        context: "plugin install download",
        requireHttps: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid download URL";
      return c.json({ success: false, error: message }, 400);
    }

    const { PluginInstaller } = await import("../plugins/installer.js");
    const installer = new PluginInstaller(pluginInstallDir);

    const result = await installer.install(pluginId, downloadUrl);
    if (result.success) {
      const discovered = await services.pluginLoader.discoverOne(pluginId);
      if (!discovered) {
        await installer.uninstall(pluginId);
        return c.json(
          {
            success: false,
            error: `Plugin "${pluginId}" was installed but rejected during discovery (duplicate or invalid plugin ID)`,
          },
          409,
        );
      }

      try {
        await services.pluginLoader.load(pluginId);
      } catch {
        // Plugin may need permission approval
      }
    }
    return c.json(result);
  });

  // POST /plugins/timeblocking/rpc — RPC bridge for timeblocking plugin store
  app.post("/timeblocking/rpc", async (c) => {
    await ensurePlugins();
    const payloadValidation = validateTimeblockingRpcPayload(await c.req.json());
    if (!payloadValidation.ok) {
      return c.json({ error: payloadValidation.error }, 400);
    }
    const { method, args } = payloadValidation.value;

    const plugin = services.pluginLoader.getAll().find((p) => p.manifest.id === "timeblocking");
    if (!plugin || !plugin.enabled) {
      return c.json({ error: "Timeblocking plugin not loaded" }, 404);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance = plugin.instance as any;
    const store = instance?.store;
    if (!store) {
      return c.json({ error: "Timeblocking store not available" }, 500);
    }

    let result: unknown;
    switch (method) {
      case "listBlocks": {
        const date = expectRpcOptionalString(args, 0, "date");
        if (!date.ok) return c.json({ error: date.error }, 400);
        result = store.listBlocks(date.value);
        break;
      }
      case "listBlocksInRange": {
        const start = expectRpcString(args, 0, "startDate");
        if (!start.ok) return c.json({ error: start.error }, 400);
        const end = expectRpcString(args, 1, "endDate");
        if (!end.ok) return c.json({ error: end.error }, 400);
        result = store.listBlocksInRange(start.value, end.value);
        break;
      }
      case "listSlots": {
        const date = expectRpcOptionalString(args, 0, "date");
        if (!date.ok) return c.json({ error: date.error }, 400);
        result = store.listSlots(date.value);
        break;
      }
      case "listSlotsInRange": {
        const start = expectRpcString(args, 0, "startDate");
        if (!start.ok) return c.json({ error: start.error }, 400);
        const end = expectRpcString(args, 1, "endDate");
        if (!end.ok) return c.json({ error: end.error }, 400);
        result = store.listSlotsInRange(start.value, end.value);
        break;
      }
      case "createBlock": {
        const input = expectRpcObject(args, 0, "block input");
        if (!input.ok) return c.json({ error: input.error }, 400);
        result = await store.createBlock(input.value);
        break;
      }
      case "updateBlock": {
        const id = expectRpcString(args, 0, "blockId");
        if (!id.ok) return c.json({ error: id.error }, 400);
        const updates = expectRpcObject(args, 1, "block updates");
        if (!updates.ok) return c.json({ error: updates.error }, 400);
        result = await store.updateBlock(id.value, updates.value);
        break;
      }
      case "deleteBlock": {
        const id = expectRpcString(args, 0, "blockId");
        if (!id.ok) return c.json({ error: id.error }, 400);
        result = await store.deleteBlock(id.value);
        break;
      }
      case "createSlot": {
        const input = expectRpcObject(args, 0, "slot input");
        if (!input.ok) return c.json({ error: input.error }, 400);
        result = await store.createSlot(input.value);
        break;
      }
      case "addTaskToSlot": {
        const slotId = expectRpcString(args, 0, "slotId");
        if (!slotId.ok) return c.json({ error: slotId.error }, 400);
        const taskId = expectRpcString(args, 1, "taskId");
        if (!taskId.ok) return c.json({ error: taskId.error }, 400);
        result = await store.addTaskToSlot(slotId.value, taskId.value);
        break;
      }
      case "reorderSlotTasks": {
        const slotId = expectRpcString(args, 0, "slotId");
        if (!slotId.ok) return c.json({ error: slotId.error }, 400);
        const taskIds = expectRpcStringArray(args, 1, "taskIds");
        if (!taskIds.ok) return c.json({ error: taskIds.error }, 400);
        result = await store.reorderSlotTasks(slotId.value, taskIds.value);
        break;
      }
      case "getSettings": {
        if (!hasSettingsPermission(plugin.manifest.permissions)) {
          return c.json(
            {
              error: settingsPermissionError(plugin.manifest.id),
            },
            403,
          );
        }
        const key = expectRpcString(args, 0, "settingKey");
        if (!key.ok) return c.json({ error: key.error }, 400);
        const definitions = plugin.manifest.settings ?? [];
        const val = services.settingsManager.get(plugin.manifest.id, key.value, definitions);
        result = val;
        break;
      }
      case "setSettings": {
        if (!hasSettingsPermission(plugin.manifest.permissions)) {
          return c.json(
            {
              error: settingsPermissionError(plugin.manifest.id),
            },
            403,
          );
        }
        const sKey = expectRpcString(args, 0, "settingKey");
        if (!sKey.ok) return c.json({ error: sKey.error }, 400);
        if (args[1] === undefined) {
          return c.json({ error: "settingValue (args[1]) is required" }, 400);
        }
        const definitions = plugin.manifest.settings ?? [];
        await services.settingsManager.setSetting(
          plugin.manifest.id,
          sKey.value,
          args[1],
          definitions,
        );
        result = { ok: true };
        break;
      }
      case "listTasks": {
        const tasks = await services.taskService.list();
        result = tasks;
        break;
      }
      default:
        return c.json({ error: `Unknown method: ${method}` }, 400);
    }

    return c.json({ result: result ?? null });
  });

  // GET /plugins — list all discovered plugins
  app.get("/", async (c) => {
    await ensurePlugins();
    const plugins = services.pluginLoader.getAll().map((p) => ({
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
    return c.json(plugins);
  });

  // POST /plugins/:id/permissions/approve
  app.post("/:id/permissions/approve", async (c) => {
    await ensurePlugins();
    const pluginId = c.req.param("id");

    // Block approving community plugins when restricted mode is on
    const plugin = services.pluginLoader.get(pluginId);
    if (plugin && !plugin.builtin && !areCommunityPluginsEnabled(services.storage)) {
      return c.json({ error: COMMUNITY_PLUGINS_DISABLED_ERROR }, 403);
    }

    const body = await c.req.json();
    const { permissions } = body as { permissions: string[] };
    const validation = validateApprovalPermissions(permissions);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }
    await services.pluginLoader.approveAndLoad(pluginId, validation.permissions);
    return c.json({ ok: true });
  });

  // POST /plugins/:id/permissions/revoke
  app.post("/:id/permissions/revoke", async (c) => {
    await ensurePlugins();
    const pluginId = c.req.param("id");
    await services.pluginLoader.revokePermissions(pluginId);
    return c.json({ ok: true });
  });

  // GET /plugins/:id/permissions
  app.get("/:id/permissions", async (c) => {
    const pluginId = c.req.param("id");
    const permissions = services.storage.getPluginPermissions(pluginId);
    return c.json({ permissions });
  });

  // GET /plugins/:id/settings
  app.get("/:id/settings", async (c) => {
    await ensurePlugins();
    const pluginId = c.req.param("id");
    const plugin = services.pluginLoader.get(pluginId);
    if (!plugin) {
      return c.json({ error: "Plugin not found" }, 404);
    }
    if (!hasSettingsPermission(plugin.manifest.permissions)) {
      return c.json({ error: settingsPermissionError(pluginId) }, 403);
    }
    const stored = services.settingsManager.getAll(pluginId);
    const definitions = plugin.manifest.settings ?? [];
    const values: Record<string, unknown> = {};
    for (const def of definitions) {
      values[def.id] = def.id in stored ? stored[def.id] : def.default;
    }
    return c.json(values);
  });

  // PUT /plugins/:id/settings
  app.put("/:id/settings", async (c) => {
    await ensurePlugins();
    const pluginId = c.req.param("id");
    const plugin = services.pluginLoader.get(pluginId);
    if (!plugin) {
      return c.json({ error: "Plugin not found" }, 404);
    }
    if (!hasSettingsPermission(plugin.manifest.permissions)) {
      return c.json({ error: settingsPermissionError(pluginId) }, 403);
    }
    const body = await c.req.json();
    const { key, value } = body as { key: string; value: unknown };
    const definitions = plugin.manifest.settings ?? [];
    await services.settingsManager.setSetting(pluginId, key, value, definitions);
    return c.json({ ok: true });
  });

  // POST /plugins/:id/uninstall
  app.post("/:id/uninstall", async (c) => {
    await ensurePlugins();
    const pluginId = c.req.param("id");

    const plugin = services.pluginLoader.get(pluginId);
    if (plugin?.builtin) {
      return c.json({ success: false, error: "Cannot uninstall built-in extensions" }, 400);
    }

    try {
      await services.pluginLoader.unload(pluginId);
    } catch {
      // May not be loaded
    }

    const { PluginInstaller } = await import("../plugins/installer.js");
    const installer = new PluginInstaller(pluginInstallDir);

    const result = await installer.uninstall(pluginId);
    if (result.success) {
      services.storage.deletePluginPermissions(pluginId);
      services.pluginLoader.remove(pluginId);
    }
    return c.json(result);
  });

  // POST /plugins/:id/toggle
  app.post("/:id/toggle", async (c) => {
    await ensurePlugins();
    const pluginId = c.req.param("id");
    const plugin = services.pluginLoader.get(pluginId);
    if (!plugin) {
      return c.json({ error: "Plugin not found" }, 404);
    }

    // Block enabling community plugins when restricted mode is on
    if (!plugin.enabled && !plugin.builtin && !areCommunityPluginsEnabled(services.storage)) {
      return c.json({ error: COMMUNITY_PLUGINS_DISABLED_ERROR }, 403);
    }

    if (plugin.enabled) {
      await services.pluginLoader.unload(pluginId);
      services.storage.deletePluginPermissions(pluginId);
    } else {
      const permissions = (plugin.manifest.permissions ?? []) as string[];
      await services.pluginLoader.approveAndLoad(pluginId, permissions);
    }

    return c.json({ ok: true, enabled: plugin.enabled });
  });

  return app;
}
