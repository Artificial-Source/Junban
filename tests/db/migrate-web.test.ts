import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs, { type Database } from "sql.js";
import { runWebMigrations } from "../../src/db/migrate-web.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../../src/db/migrations");
const migrateWebPath = path.resolve(__dirname, "../../src/db/migrate-web.ts");
const migrationsJournalPath = path.resolve(__dirname, "../../src/db/migrations/meta/_journal.json");
const sqlWasmPath = path.resolve(__dirname, "../../node_modules/sql.js/dist/sql-wasm.wasm");
const MIGRATIONS_TABLE = "__drizzle_migrations";
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

interface MigrationJournalEntry {
  idx: number;
  tag: string;
  when: number;
}

interface MigrationJournal {
  entries: MigrationJournalEntry[];
}

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
let migrationJournal: MigrationJournal;
let migrationSqlByTag: Map<string, string>;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: () => sqlWasmPath });
  migrationJournal = JSON.parse(
    await fs.readFile(migrationsJournalPath, "utf8"),
  ) as MigrationJournal;

  migrationSqlByTag = new Map(
    await Promise.all(
      migrationJournal.entries.map(async (entry) => [
        entry.tag,
        await fs.readFile(path.join(migrationsDir, `${entry.tag}.sql`), "utf8"),
      ]),
    ),
  );
});

function createDatabase(): Database {
  const sqlite = new SQL.Database();
  sqlite.run("PRAGMA foreign_keys = ON");
  return sqlite;
}

function ensureMigrationsTable(sqlite: Database): void {
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
}

function splitMigrationStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function readMigrationRows(sqlite: Database): Array<{ hash: string; createdAt: number }> {
  const result = sqlite.exec(
    `SELECT hash, created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at ASC`,
  );

  return (result[0]?.values ?? []).map(([hash, createdAt]) => ({
    hash: String(hash),
    createdAt: Number(createdAt),
  }));
}

function readTaskColumnNames(sqlite: Database): string[] {
  const result = sqlite.exec('PRAGMA table_info("tasks")');
  return (result[0]?.values ?? []).map((row) => String(row[1]));
}

async function applyMigrationPrefix(sqlite: Database, count: number): Promise<void> {
  ensureMigrationsTable(sqlite);

  for (const entry of migrationJournal.entries.slice(0, count)) {
    const sql = migrationSqlByTag.get(entry.tag);
    if (!sql) {
      throw new Error(`Missing migration SQL for ${entry.tag}`);
    }

    for (const statement of splitMigrationStatements(sql)) {
      sqlite.run(statement);
    }

    sqlite.run(`INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES (?, ?)`, [
      createHash("sha256").update(sql).digest("hex"),
      entry.when,
    ]);
  }
}

async function applyMigrationPrefixWithoutLedger(sqlite: Database, count: number): Promise<void> {
  for (const entry of migrationJournal.entries.slice(0, count)) {
    const sql = migrationSqlByTag.get(entry.tag);
    if (!sql) {
      throw new Error(`Missing migration SQL for ${entry.tag}`);
    }

    for (const statement of splitMigrationStatements(sql)) {
      sqlite.run(statement);
    }
  }
}

describe("migrate-web", () => {
  it("imports every SQL migration in journal order", async () => {
    const [source, migrationEntries] = await Promise.all([
      fs.readFile(migrateWebPath, "utf8"),
      fs.readdir(migrationsDir),
    ]);

    const importedMigrationFiles = Array.from(
      source.matchAll(/"\.\/migrations\/([^"]+\.sql)\?raw"/g),
      ([, fileName]) => fileName,
    );
    const expectedMigrationFiles = migrationJournal.entries.map(({ tag }) => `${tag}.sql`);
    const diskMigrationFiles = migrationEntries.filter((entry) => entry.endsWith(".sql")).sort();

    expect(importedMigrationFiles).toEqual(expectedMigrationFiles);
    expect(importedMigrationFiles).toEqual(diskMigrationFiles);
  });

  it("applies all pending migrations and records native-style ledger rows", async () => {
    const sqlite = createDatabase();

    await runWebMigrations(sqlite);

    const migrationRows = readMigrationRows(sqlite);

    expect(migrationRows).toEqual(
      migrationJournal.entries.map((entry) => ({
        hash: createHash("sha256")
          .update(migrationSqlByTag.get(entry.tag) ?? "")
          .digest("hex"),
        createdAt: entry.when,
      })),
    );
    expect(readTaskColumnNames(sqlite)).toContain("dread_level");
  });

  it("backfills ledger for a schemaful legacy database missing __drizzle_migrations", async () => {
    const sqlite = createDatabase();

    await applyMigrationPrefixWithoutLedger(sqlite, migrationJournal.entries.length);

    await runWebMigrations(sqlite);

    expect(readMigrationRows(sqlite)).toEqual(
      migrationJournal.entries.map((entry) => ({
        hash: createHash("sha256")
          .update(migrationSqlByTag.get(entry.tag) ?? "")
          .digest("hex"),
        createdAt: entry.when,
      })),
    );
    expect(readTaskColumnNames(sqlite)).toContain("dread_level");
  });

  it("applies only migrations that are still pending", async () => {
    const sqlite = createDatabase();

    await applyMigrationPrefix(sqlite, 4);

    await runWebMigrations(sqlite);

    const migrationRows = readMigrationRows(sqlite);
    expect(migrationRows).toHaveLength(migrationJournal.entries.length);
    expect(migrationRows.map((row) => row.createdAt)).toEqual(
      migrationJournal.entries.map((entry) => entry.when),
    );
    expect(readTaskColumnNames(sqlite)).toContain("dread_level");
  });

  it("is safe to rerun without duplicating migration rows", async () => {
    const sqlite = createDatabase();

    await runWebMigrations(sqlite);
    const firstRunRows = readMigrationRows(sqlite);

    await runWebMigrations(sqlite);

    expect(readMigrationRows(sqlite)).toEqual(firstRunRows);
  });
});
