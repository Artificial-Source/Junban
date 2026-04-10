import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("db");

let db: BetterSQLite3Database<typeof schema> | null = null;
let sqlite: InstanceType<typeof Database> | null = null;
let activeDbKey: string | null = null;

function normalizeDbPath(dbPath: string): string {
  if (dbPath === ":memory:") return dbPath;
  return path.resolve(dbPath);
}

function closeCurrentConnection(): void {
  if (!sqlite) return;
  try {
    sqlite.close();
  } finally {
    sqlite = null;
    db = null;
    activeDbKey = null;
  }
}

export function getDb(dbPath: string): BetterSQLite3Database<typeof schema> {
  const dbKey = normalizeDbPath(dbPath);

  if (db && activeDbKey === dbKey) {
    return db;
  }

  if (db && activeDbKey !== dbKey) {
    logger.warn("Switching SQLite connection to a new path", {
      from: activeDbKey,
      to: dbKey,
    });
    closeCurrentConnection();
  }

  logger.debug("Opening SQLite database", { path: dbPath });
  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite, { schema });
  activeDbKey = dbKey;
  logger.debug("Database pragmas configured (WAL, FK)");

  return db;
}

/** Test-only helper to clear the module-level DB singleton safely. */
export function resetDbConnectionForTests(): void {
  closeCurrentConnection();
}
