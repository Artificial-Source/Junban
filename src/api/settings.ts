import { Hono } from "hono";
import type { AppServices } from "../bootstrap.js";
import { loadEnv } from "../config/env.js";
import {
  isWritableSettingKey,
  listSettingsForClient,
  readSettingForClient,
} from "../core/settings-policy.js";

export function settingsRoutes(services: AppServices): Hono {
  const app = new Hono();

  // GET /settings — return all settings as a key-value object (sensitive keys excluded)
  app.get("/", async (c) => {
    return c.json(listSettingsForClient(services.storage.listAllAppSettings()));
  });

  // GET /settings/storage — storage mode info
  app.get("/storage", async (c) => {
    const env = loadEnv();
    return c.json({
      mode: env.STORAGE_MODE,
      path: env.STORAGE_MODE === "markdown" ? env.MARKDOWN_PATH : env.DB_PATH,
    });
  });

  // GET /settings/:key
  app.get("/:key", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const row = services.storage.getAppSetting(key);
    return c.json({ value: readSettingForClient(key, row?.value) });
  });

  // PUT /settings/:key
  app.put("/:key", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    if (!isWritableSettingKey(key)) {
      return c.json({ error: `Setting key "${key}" is not allowed` }, 400);
    }
    const body = await c.req.json();
    if (typeof body.value !== "string") {
      return c.json({ error: "value must be a string" }, 400);
    }
    services.storage.setAppSetting(key, body.value);
    return c.json({ ok: true });
  });

  return app;
}
