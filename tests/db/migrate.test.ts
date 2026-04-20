import { afterEach, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../../src/db/schema.js";
import { runMigrations } from "../../src/db/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../src/db/migrations");
const MIGRATIONS_TABLE = "__drizzle_migrations";

const openSqliteHandles: Database.Database[] = [];

let migrationMeta: MigrationMeta[];

beforeAll(() => {
  migrationMeta = readMigrationFiles({ migrationsFolder });
});

afterEach(() => {
  for (const sqlite of openSqliteHandles.splice(0)) {
    sqlite.close();
  }
});

function createDatabase(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  openSqliteHandles.push(sqlite);
  return sqlite;
}

function applyMigrationPrefixWithoutLedger(sqlite: Database.Database, count: number): void {
  for (const migration of migrationMeta.slice(0, count)) {
    for (const statement of migration.sql.map((entry) => entry.trim()).filter(Boolean)) {
      sqlite.exec(statement);
    }
  }
}

function insertLegacyTaskData(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT INTO projects (id, name, color, icon, sort_order, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("project-1", "Legacy Project", "#3b82f6", null, 0, 0, "2026-01-01T00:00:00.000Z");

  sqlite
    .prepare(
      `INSERT INTO tasks (
        id, title, description, status, priority, due_date, due_time, completed_at,
        project_id, recurrence, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "task-1",
      "Legacy task",
      "Preserve me",
      "pending",
      2,
      null,
      0,
      null,
      "project-1",
      null,
      0,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
}

function readMigrationRows(sqlite: Database.Database): Array<{ hash: string; createdAt: number }> {
  if (!hasTable(sqlite, MIGRATIONS_TABLE)) {
    return [];
  }

  return sqlite
    .prepare(
      `SELECT hash, created_at AS createdAt FROM "${MIGRATIONS_TABLE}" ORDER BY created_at ASC`,
    )
    .all() as Array<{ hash: string; createdAt: number }>;
}

function readTaskColumnNames(sqlite: Database.Database): string[] {
  return (sqlite.prepare('PRAGMA table_info("tasks")').all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function hasTable(sqlite: Database.Database, tableName: string): boolean {
  return (
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) !== undefined
  );
}

describe("runMigrations legacy ledger compatibility", () => {
  it("backfills a schemaful legacy database before Drizzle migrations run", () => {
    const sqlite = createDatabase();

    applyMigrationPrefixWithoutLedger(sqlite, migrationMeta.length);
    insertLegacyTaskData(sqlite);

    const db = drizzle(sqlite, { schema });
    runMigrations(db);

    expect(readMigrationRows(sqlite)).toEqual(
      migrationMeta.map((migration) => ({
        hash: migration.hash,
        createdAt: migration.folderMillis,
      })),
    );
    expect(
      sqlite.prepare("SELECT title, description FROM tasks WHERE id = ?").get("task-1"),
    ).toEqual({
      title: "Legacy task",
      description: "Preserve me",
    });
  });

  it("seeds the legacy prefix and then applies still-pending migrations", () => {
    const sqlite = createDatabase();
    const legacyPrefixCount = Math.max(1, migrationMeta.length - 2);

    applyMigrationPrefixWithoutLedger(sqlite, legacyPrefixCount);
    insertLegacyTaskData(sqlite);

    const db = drizzle(sqlite, { schema });
    runMigrations(db);

    expect(readMigrationRows(sqlite)).toEqual(
      migrationMeta.map((migration) => ({
        hash: migration.hash,
        createdAt: migration.folderMillis,
      })),
    );
    expect(readTaskColumnNames(sqlite)).toContain("dread_level");
    expect(hasTable(sqlite, "ai_memories")).toBe(true);
    expect(sqlite.prepare("SELECT project_id FROM tasks WHERE id = ?").get("task-1")).toEqual({
      project_id: "project-1",
    });
  });

  it("refuses to backfill an inconsistent schemaful database", () => {
    const sqlite = createDatabase();

    applyMigrationPrefixWithoutLedger(sqlite, 1);
    sqlite.exec("ALTER TABLE tasks ADD COLUMN dread_level integer");

    const db = drizzle(sqlite, { schema });

    expect(() => runMigrations(db)).toThrow(/known legacy migration prefix/i);
    expect(hasTable(sqlite, MIGRATIONS_TABLE)).toBe(false);
  });
});
