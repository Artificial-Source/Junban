import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("migrate");
const MIGRATIONS_TABLE = "__drizzle_migrations";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "migrations");

type SQLiteClient = InstanceType<typeof Database>;
type BetterSQLite3DatabaseWithClient = BetterSQLite3Database<Record<string, unknown>> & {
  $client: SQLiteClient;
};

interface TableInfoRow {
  name: string;
}

const legacyMigrationProbes = [
  (sqlite: SQLiteClient) =>
    hasColumns(sqlite, "app_settings", ["key", "value", "updated_at"]) &&
    hasColumns(sqlite, "plugin_settings", ["plugin_id", "settings", "updated_at"]) &&
    hasColumns(sqlite, "projects", [
      "id",
      "name",
      "color",
      "icon",
      "sort_order",
      "archived",
      "created_at",
    ]) &&
    hasColumns(sqlite, "tags", ["id", "name", "color"]) &&
    hasColumns(sqlite, "task_tags", ["task_id", "tag_id"]) &&
    hasColumns(sqlite, "tasks", [
      "id",
      "title",
      "description",
      "status",
      "priority",
      "due_date",
      "due_time",
      "completed_at",
      "project_id",
      "recurrence",
      "sort_order",
      "created_at",
      "updated_at",
    ]),
  (sqlite: SQLiteClient) => hasColumns(sqlite, "chat_messages", ["id", "session_id", "role"]),
  (sqlite: SQLiteClient) => hasColumn(sqlite, "tasks", "parent_id"),
  (sqlite: SQLiteClient) => hasColumns(sqlite, "task_templates", ["id", "name", "title"]),
  (sqlite: SQLiteClient) => hasColumn(sqlite, "tasks", "remind_at"),
  (sqlite: SQLiteClient) =>
    hasColumn(sqlite, "projects", "parent_id") &&
    hasColumn(sqlite, "projects", "is_favorite") &&
    hasColumn(sqlite, "projects", "view_style"),
  (sqlite: SQLiteClient) =>
    hasColumns(sqlite, "daily_stats", ["id", "date", "tasks_completed"]) &&
    hasColumns(sqlite, "sections", ["id", "project_id", "name"]) &&
    hasColumns(sqlite, "task_activity", ["id", "task_id", "action"]) &&
    hasColumns(sqlite, "task_comments", ["id", "task_id", "content"]) &&
    hasColumn(sqlite, "tasks", "estimated_minutes") &&
    hasColumn(sqlite, "tasks", "deadline") &&
    hasColumn(sqlite, "tasks", "is_someday") &&
    hasColumn(sqlite, "tasks", "section_id"),
  (sqlite: SQLiteClient) =>
    hasColumns(sqlite, "task_relations", ["task_id", "related_task_id", "type"]) &&
    hasColumn(sqlite, "tasks", "actual_minutes"),
  (sqlite: SQLiteClient) => hasColumns(sqlite, "ai_memories", ["id", "content", "category"]),
  (sqlite: SQLiteClient) => hasColumn(sqlite, "tasks", "dread_level"),
] as const;

const knownAppTables = [
  "app_settings",
  "plugin_settings",
  "projects",
  "tags",
  "task_tags",
  "tasks",
  "chat_messages",
  "task_templates",
  "daily_stats",
  "sections",
  "task_activity",
  "task_comments",
  "task_relations",
  "ai_memories",
] as const;

function hasTable(sqlite: SQLiteClient, tableName: string): boolean {
  return (
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) !== undefined
  );
}

function getColumnNames(sqlite: SQLiteClient, tableName: string): Set<string> {
  if (!hasTable(sqlite, tableName)) {
    return new Set();
  }

  const rows = sqlite.prepare(`PRAGMA table_info("${tableName}")`).all() as TableInfoRow[];
  return new Set(rows.map((row) => row.name));
}

function hasColumn(sqlite: SQLiteClient, tableName: string, columnName: string): boolean {
  return getColumnNames(sqlite, tableName).has(columnName);
}

function hasColumns(sqlite: SQLiteClient, tableName: string, columnNames: string[]): boolean {
  const existingColumns = getColumnNames(sqlite, tableName);
  return columnNames.every((columnName) => existingColumns.has(columnName));
}

function hasKnownAppSchema(sqlite: SQLiteClient): boolean {
  return knownAppTables.some((tableName) => hasTable(sqlite, tableName));
}

function getExistingMigrationLedgerRowCount(sqlite: SQLiteClient): number {
  if (!hasTable(sqlite, MIGRATIONS_TABLE)) {
    return 0;
  }

  const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM "${MIGRATIONS_TABLE}"`).get() as {
    count: number;
  };
  return Number(row.count);
}

function detectLegacyAppliedMigrationCount(sqlite: SQLiteClient): number | null {
  const probeResults = legacyMigrationProbes.map((probe) => probe(sqlite));
  const firstMissingIndex = probeResults.findIndex((result) => !result);

  if (firstMissingIndex === -1) {
    return legacyMigrationProbes.length;
  }

  if (probeResults.slice(firstMissingIndex + 1).some(Boolean)) {
    return hasKnownAppSchema(sqlite) ? null : 0;
  }

  if (firstMissingIndex === 0) {
    return hasKnownAppSchema(sqlite) ? null : 0;
  }

  return firstMissingIndex;
}

function backfillLegacyMigrationLedger(
  db: BetterSQLite3Database<Record<string, unknown>>,
  migrations: MigrationMeta[],
): void {
  const sqlite = (db as BetterSQLite3DatabaseWithClient).$client;

  if (getExistingMigrationLedgerRowCount(sqlite) > 0) {
    return;
  }

  const appliedMigrationCount = detectLegacyAppliedMigrationCount(sqlite);

  if (appliedMigrationCount === 0) {
    return;
  }

  if (appliedMigrationCount === null) {
    throw new Error(
      `Detected a schemaful SQLite database without a usable ${MIGRATIONS_TABLE} ledger, but its structure does not match a known legacy migration prefix. Refusing automatic ledger backfill to avoid corrupting the database.`,
    );
  }

  const migrationsToSeed = migrations.slice(0, appliedMigrationCount);

  sqlite.transaction((entries: MigrationMeta[]) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `);

    const insertMigration = sqlite.prepare(
      `INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES (?, ?)`,
    );

    for (const migration of entries) {
      insertMigration.run(migration.hash, migration.folderMillis);
    }
  })(migrationsToSeed);

  logger.info("Backfilled legacy migration ledger before Drizzle migrate", {
    seededMigrations: appliedMigrationCount,
  });
}

export function runMigrations(db: BetterSQLite3Database<Record<string, unknown>>) {
  logger.info("Running database migrations");
  const migrations = readMigrationFiles({ migrationsFolder });

  backfillLegacyMigrationLedger(db, migrations);
  migrate(db, { migrationsFolder });

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
