import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";
import { bootstrap } from "./bootstrap.js";
import { loadEnv } from "./config/env.js";
import { NotFoundError, ValidationError } from "./core/errors.js";
import { createLogger, setDefaultLogLevel } from "./utils/logger.js";
import { taskRoutes } from "./api/tasks.js";
import { projectRoutes } from "./api/projects.js";
import { tagRoutes } from "./api/tags.js";
import { sectionRoutes } from "./api/sections.js";
import { commentRoutes } from "./api/comments.js";
import { templateRoutes } from "./api/templates.js";
import { settingsRoutes } from "./api/settings.js";
import { statsRoutes } from "./api/stats.js";
import { pluginRoutes } from "./api/plugins.js";
import { aiRoutes } from "./api/ai.js";
import { voiceRoutes } from "./api/voice.js";

const env = loadEnv();
setDefaultLogLevel(env.LOG_LEVEL);
const logger = createLogger("server");

const API_PORT = parseInt(process.env.API_PORT ?? "4822", 10);

logger.info("Bootstrapping services...");
const services = bootstrap();

// Load plugins (failures don't crash the server)
try {
  await services.pluginLoader.loadAll();
  const loaded = services.pluginLoader.getAll().filter((p) => p.enabled);
  logger.info(`Plugins loaded: ${loaded.length}`);
} catch (err) {
  logger.error(`Plugin loading failed: ${err instanceof Error ? err.message : err}`);
}

// Build Hono app
const app = new Hono();

// Security headers
app.use("*", secureHeaders());

// CORS middleware — restrict to localhost origins only
const ALLOWED_ORIGINS = [
  `http://localhost:${API_PORT}`,
  "http://localhost:5173", // Vite dev server
  "http://127.0.0.1:5173",
  "http://localhost:4173", // Vite preview
  "http://127.0.0.1:4173",
  "tauri://localhost", // Tauri webview
  "https://tauri.localhost", // Tauri webview (Windows)
];
app.use(
  "*",
  cors({
    origin: ALLOWED_ORIGINS,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-api-key", "Authorization"],
  }),
);

// Global error handler
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  let status: 400 | 404 | 500 = 500;
  if (err instanceof NotFoundError) {
    status = 404;
  } else if (err instanceof ValidationError) {
    status = 400;
  } else if (message.includes("Invalid JSON") || message.includes("cycle")) {
    status = 400;
  }
  logger.error(`API error: ${message}`);
  return c.json({ error: message }, status);
});

// POST /api/test-reset — delete all data (for E2E tests only)
if (process.env.NODE_ENV === "test" || process.env.E2E_MODE === "true") {
  app.post("/api/test-reset", async (c) => {
    const tasks = await services.taskService.list();
    if (tasks.length > 0) {
      await services.taskService.deleteMany(tasks.map((t) => t.id));
    }
    const projects = await services.projectService.list();
    for (const p of projects) {
      await services.projectService.delete(p.id);
    }
    const tags = await services.tagService.list();
    for (const t of tags) {
      await services.tagService.delete(t.id);
    }
    return c.json({ ok: true });
  });
}

// Mount route modules
app.route("/api/tasks", taskRoutes(services));
app.route("/api/projects", projectRoutes(services));
app.route("/api/tags", tagRoutes(services));
app.route("/api/sections", sectionRoutes(services));
app.route("/api/comments", commentRoutes(services));
app.route("/api/templates", templateRoutes(services));
app.route("/api/settings", settingsRoutes(services));
app.route("/api/stats", statsRoutes(services));
app.route("/api/plugins", pluginRoutes(services));
app.route("/api/ai", aiRoutes(services));
app.route("/api/voice", voiceRoutes());

// Health check
app.get("/api/health", (c) => c.json({ ok: true }));

// Start the server
serve(
  {
    fetch: app.fetch,
    port: API_PORT,
  },
  (info) => {
    logger.info(`API server listening on port ${info.port}`);
    console.log(`API server listening on port ${info.port}`);
  },
);

export { app, services };
