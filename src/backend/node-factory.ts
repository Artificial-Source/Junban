import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { loadEnv, type Env } from "../config/env.js";
import { ChatManager } from "../ai/chat.js";
import { createDefaultRegistry } from "../ai/provider-node.js";
import { createDefaultToolRegistry } from "../ai/tool-registry.js";
import { PluginLoader, type PluginServices } from "../plugins/loader.js";
import { MarkdownBackend } from "../storage/markdown-backend.js";
import { SQLiteBackend } from "../storage/sqlite-backend.js";
import type { IStorage } from "../storage/interface.js";
import { createLogger } from "../utils/logger.js";
import { createBackendKernel, type AppServices, type BackendKernelAIRuntime } from "./kernel.js";

const logger = createLogger("bootstrap");

function createNodeStorage(env: Env): IStorage {
  logger.info("Initializing storage", { mode: env.STORAGE_MODE });

  if (env.STORAGE_MODE === "markdown") {
    const markdownPath = path.resolve(env.MARKDOWN_PATH);
    fs.mkdirSync(markdownPath, { recursive: true });

    const backend = new MarkdownBackend(markdownPath);
    backend.initialize();

    logger.info("Markdown backend initialized", { path: markdownPath });
    return backend;
  }

  const resolvedPath = env.DB_PATH;
  const dir = path.dirname(resolvedPath);

  if (dir !== "." && dir !== ":memory:") {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = getDb(resolvedPath);
  runMigrations(db);

  logger.info("SQLite backend initialized", { path: resolvedPath });
  return new SQLiteBackend(db);
}

function resolveBuiltinPluginDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../plugins/builtin");
}

function createNodeAIRuntime(): BackendKernelAIRuntime {
  return {
    chatManager: new ChatManager(),
    aiProviderRegistry: createDefaultRegistry(),
    toolRegistry: createDefaultToolRegistry(),
  };
}

function createNodePluginLoader(env: Env, services: PluginServices): PluginLoader {
  return new PluginLoader(path.resolve(env.PLUGIN_DIR), services, resolveBuiltinPluginDir());
}

export interface NodeBackendFactoryOptions {
  env?: Env;
}

export function createNodeBackendServices(options: NodeBackendFactoryOptions = {}): AppServices {
  const env = options.env ?? loadEnv();

  return createBackendKernel({
    storage: createNodeStorage(env),
    aiRuntime: createNodeAIRuntime(),
    createPluginLoader: (pluginServices) => createNodePluginLoader(env, pluginServices),
  });
}

export function bootstrap(): AppServices {
  return createNodeBackendServices();
}
