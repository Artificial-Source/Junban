import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../../src/db/schema.js";
import { TaskService } from "../../src/core/tasks.js";
import { ProjectService } from "../../src/core/projects.js";
import { TagService } from "../../src/core/tags.js";
import { EventBus } from "../../src/core/event-bus.js";
import { SQLiteBackend } from "../../src/storage/sqlite-backend.js";
import type { IStorage } from "../../src/storage/interface.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../src/db/migrations");

export function createTestServices() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  const storage: IStorage = new SQLiteBackend(db);
  const tagService = new TagService(storage);
  const projectService = new ProjectService(storage);
  const eventBus = new EventBus();
  const taskService = new TaskService(storage, tagService, eventBus);

  return { db, storage, taskService, projectService, tagService, eventBus };
}
