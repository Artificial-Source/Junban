import { Hono } from "hono";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import type { AppServices } from "../bootstrap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function pluginRoutes(services: AppServices): Hono {
  const app = new Hono();

  // Promise lock to prevent double plugin init
  let pluginInitPromise: Promise<void> | null = null;
  async function ensurePlugins() {
    if (!pluginInitPromise) {
      pluginInitPromise = (async () => {
        await services.pluginLoader.loadAll();
      })();
    }
    await pluginInitPromise;
  }

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

  // GET /plugins/ui/panels
  app.get("/ui/panels", async (c) => {
    await ensurePlugins();
    const panels = services.uiRegistry.getPanels().map((panel) => ({
      id: panel.id,
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

    // Validate download URL — must be HTTPS and not targeting internal/private networks
    try {
      const url = new URL(downloadUrl);
      if (url.protocol !== "https:") {
        return c.json({ success: false, error: "Download URL must use HTTPS" }, 400);
      }
      const hostname = url.hostname.toLowerCase();
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]" ||
        hostname.startsWith("10.") ||
        hostname.startsWith("192.168.") ||
        hostname.startsWith("172.") ||
        hostname === "169.254.169.254" ||
        hostname.endsWith(".local")
      ) {
        return c.json(
          { success: false, error: "Download URL must not target internal networks" },
          400,
        );
      }
    } catch {
      return c.json({ success: false, error: "Invalid download URL" }, 400);
    }

    const { PluginInstaller } = await import("../plugins/installer.js");
    const installer = new PluginInstaller(path.resolve(process.cwd(), "plugins"));

    const result = await installer.install(pluginId, downloadUrl);
    if (result.success) {
      const discovered = await services.pluginLoader.discoverOne(pluginId);
      if (discovered) {
        try {
          await services.pluginLoader.load(pluginId);
        } catch {
          // Plugin may need permission approval
        }
      }
    }
    return c.json(result);
  });

  // POST /plugins/timeblocking/rpc — RPC bridge for timeblocking plugin store
  app.post("/timeblocking/rpc", async (c) => {
    await ensurePlugins();
    const body = await c.req.json();
    const { method, args } = body as { method: string; args: unknown[] };

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
        const val = services.settingsManager.get("timeblocking", key, definitions);
        result = val;
        break;
      }
      case "setSettings": {
        const sKey = args[0] as string;
        const sVal = args[1] as string;
        await services.settingsManager.set("timeblocking", sKey, sVal);
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
    if (plugin && !plugin.builtin) {
      const setting = services.storage.getAppSetting("community_plugins_enabled");
      if (setting?.value !== "true") {
        return c.json(
          { error: "Community plugins are disabled. Enable them in Settings > Plugins." },
          403,
        );
      }
    }

    const body = await c.req.json();
    const { permissions } = body as { permissions: string[] };
    await services.pluginLoader.approveAndLoad(pluginId, permissions);
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
    const body = await c.req.json();
    const { key, value } = body as { key: string; value: unknown };
    await services.settingsManager.set(pluginId, key, value);
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
    const installer = new PluginInstaller(path.resolve(process.cwd(), "plugins"));

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
    if (!plugin.enabled && !plugin.builtin) {
      const setting = services.storage.getAppSetting("community_plugins_enabled");
      if (setting?.value !== "true") {
        return c.json(
          { error: "Community plugins are disabled. Enable them in Settings > Plugins." },
          403,
        );
      }
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
