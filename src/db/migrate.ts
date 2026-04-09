import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("migrate");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runMigrations(db: BetterSQLite3Database<Record<string, unknown>>) {
  logger.info("Running database migrations");
  migrate(db, { migrationsFolder: path.resolve(__dirname, "migrations") });
  logger.info("Migrations applied successfully");
}

// Standalone execution: pnpm db:migrate
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { loadEnv } = await import("../config/env.js");
  const { getDb } = await import("./client.js");
  const env = loadEnv();
  const dbDir = path.dirname(env.DB_PATH);

  if (dbDir !== "." && dbDir !== ":memory:") {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = getDb(env.DB_PATH);
  runMigrations(db);
}
