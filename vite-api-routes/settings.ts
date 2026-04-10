import type { RouteRegistrar } from "./types.js";
import { parseBody } from "./types.js";
import {
  isWritableSettingKey,
  listSettingsForClient,
  readSettingForClient,
} from "../src/core/settings-policy.js";

export const registerSettingsRoutes: RouteRegistrar = (server, getServices) => {
  // GET /api/settings — return all settings as a key-value object (sensitive keys excluded)
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/settings" || req.method !== "GET") return next();

    const svc = await getServices();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(listSettingsForClient(svc.storage.listAllAppSettings())));
  });

  // GET /api/settings/storage — storage mode info
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/settings/storage" || req.method !== "GET") return next();

    const { loadEnv } = await import("../src/config/env.js");
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
        res.end(JSON.stringify({ value: readSettingForClient(key, row?.value) }));
        return;
      }

      if (req.method === "PUT") {
        const body = await parseBody(req);
        if (!isWritableSettingKey(key)) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: `Setting key "${key}" is not allowed` }));
          return;
        }
        if (typeof body.value !== "string") {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "value must be a string" }));
          return;
        }
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
};
