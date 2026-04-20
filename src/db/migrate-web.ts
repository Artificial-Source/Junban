import m0000 from "./migrations/0000_cool_spencer_smythe.sql?raw";
import m0001 from "./migrations/0001_cool_rictor.sql?raw";
import m0002 from "./migrations/0002_add_parent_id.sql?raw";
import m0003 from "./migrations/0003_add_task_templates.sql?raw";
import m0004 from "./migrations/0004_silky_karnak.sql?raw";
import m0005 from "./migrations/0005_aberrant_blur.sql?raw";
import m0006 from "./migrations/0006_solid_mephisto.sql?raw";
import m0007 from "./migrations/0007_cold_living_mummy.sql?raw";
import m0008 from "./migrations/0008_sparkling_micromacro.sql?raw";
import m0009 from "./migrations/0009_damp_retro_girl.sql?raw";
import migrationsJournalRaw from "./migrations/meta/_journal.json?raw";
import type { Database } from "sql.js";

interface WebMigrationJournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface WebMigrationJournal {
  entries: WebMigrationJournalEntry[];
}

interface WebMigration {
  tag: string;
  sql: string;
  folderMillis: number;
}

type LegacyMigrationProbe = (sqlite: Database) => boolean;

const MIGRATIONS_TABLE = "__drizzle_migrations";
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

const migrationSources: Record<string, string> = {
  "0000_cool_spencer_smythe": m0000,
  "0001_cool_rictor": m0001,
  "0002_add_parent_id": m0002,
  "0003_add_task_templates": m0003,
  "0004_silky_karnak": m0004,
  "0005_aberrant_blur": m0005,
  "0006_solid_mephisto": m0006,
  "0007_cold_living_mummy": m0007,
  "0008_sparkling_micromacro": m0008,
  "0009_damp_retro_girl": m0009,
};

const migrations = (JSON.parse(migrationsJournalRaw) as WebMigrationJournal).entries.map(
  (entry): WebMigration => {
    const sql = migrationSources[entry.tag];
    if (!sql) {
      throw new Error(`Missing web migration source for ${entry.tag}`);
    }

    return {
      tag: entry.tag,
      sql,
      folderMillis: entry.when,
    };
  },
);

const legacyMigrationProbes: readonly LegacyMigrationProbe[] = [
  (sqlite) =>
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
  (sqlite) => hasColumns(sqlite, "chat_messages", ["id", "session_id", "role"]),
  (sqlite) => hasColumn(sqlite, "tasks", "parent_id"),
  (sqlite) => hasColumns(sqlite, "task_templates", ["id", "name", "title"]),
  (sqlite) => hasColumn(sqlite, "tasks", "remind_at"),
  (sqlite) =>
    hasColumn(sqlite, "projects", "parent_id") &&
    hasColumn(sqlite, "projects", "is_favorite") &&
    hasColumn(sqlite, "projects", "view_style"),
  (sqlite) =>
    hasColumns(sqlite, "daily_stats", ["id", "date", "tasks_completed"]) &&
    hasColumns(sqlite, "sections", ["id", "project_id", "name"]) &&
    hasColumns(sqlite, "task_activity", ["id", "task_id", "action"]) &&
    hasColumns(sqlite, "task_comments", ["id", "task_id", "content"]) &&
    hasColumn(sqlite, "tasks", "estimated_minutes") &&
    hasColumn(sqlite, "tasks", "deadline") &&
    hasColumn(sqlite, "tasks", "is_someday") &&
    hasColumn(sqlite, "tasks", "section_id"),
  (sqlite) =>
    hasColumns(sqlite, "task_relations", ["task_id", "related_task_id", "type"]) &&
    hasColumn(sqlite, "tasks", "actual_minutes"),
  (sqlite) => hasColumns(sqlite, "ai_memories", ["id", "content", "category"]),
  (sqlite) => hasColumn(sqlite, "tasks", "dread_level"),
];

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

function hasTable(sqlite: Database, tableName: string): boolean {
  const result = sqlite.exec(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    [tableName],
  );
  return (result[0]?.values.length ?? 0) > 0;
}

function getColumnNames(sqlite: Database, tableName: string): Set<string> {
  if (!hasTable(sqlite, tableName)) {
    return new Set();
  }

  const result = sqlite.exec(`PRAGMA table_info("${tableName}")`);
  return new Set((result[0]?.values ?? []).map((row) => String(row[1])));
}

function hasColumn(sqlite: Database, tableName: string, columnName: string): boolean {
  return getColumnNames(sqlite, tableName).has(columnName);
}

function hasColumns(sqlite: Database, tableName: string, columnNames: readonly string[]): boolean {
  const existingColumns = getColumnNames(sqlite, tableName);
  return columnNames.every((columnName) => existingColumns.has(columnName));
}

function hasKnownAppSchema(sqlite: Database): boolean {
  return knownAppTables.some((tableName) => hasTable(sqlite, tableName));
}

function getExistingMigrationLedgerRowCount(sqlite: Database): number {
  if (!hasTable(sqlite, MIGRATIONS_TABLE)) {
    return 0;
  }

  const result = sqlite.exec(`SELECT COUNT(*) FROM "${MIGRATIONS_TABLE}"`);
  const count = result[0]?.values[0]?.[0];
  return count == null ? 0 : Number(count);
}

function detectLegacyAppliedMigrationCount(sqlite: Database): number | null {
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

function ensureMigrationsTable(sqlite: Database): void {
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
}

function getLastAppliedMigrationMillis(sqlite: Database): number | null {
  const result = sqlite.exec(
    `SELECT created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at DESC LIMIT 1`,
  );
  const createdAt = result[0]?.values[0]?.[0];
  return createdAt == null ? null : Number(createdAt);
}

function getMigrationStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function sha256Hex(value: string): Promise<string> {
  const hashBuffer = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hashBuffer), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function backfillLegacyMigrationLedger(sqlite: Database): Promise<void> {
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

  sqlite.run("BEGIN");

  try {
    ensureMigrationsTable(sqlite);

    for (const migration of migrationsToSeed) {
      sqlite.run(`INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES (?, ?)`, [
        await sha256Hex(migration.sql),
        migration.folderMillis,
      ]);
    }

    sqlite.run("COMMIT");
  } catch (error) {
    sqlite.run("ROLLBACK");
    throw error;
  }
}

export async function runWebMigrations(sqlite: Database): Promise<void> {
  await backfillLegacyMigrationLedger(sqlite);
  ensureMigrationsTable(sqlite);

  const lastAppliedMigrationMillis = getLastAppliedMigrationMillis(sqlite);
  const pendingMigrations = migrations.filter(
    (migration) =>
      lastAppliedMigrationMillis === null || lastAppliedMigrationMillis < migration.folderMillis,
  );

  if (pendingMigrations.length === 0) {
    return;
  }

  sqlite.run("BEGIN");

  try {
    for (const migration of pendingMigrations) {
      for (const statement of getMigrationStatements(migration.sql)) {
        sqlite.run(statement);
      }

      sqlite.run(`INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES (?, ?)`, [
        await sha256Hex(migration.sql),
        migration.folderMillis,
      ]);
    }

    sqlite.run("COMMIT");
  } catch (error) {
    sqlite.run("ROLLBACK");
    throw error;
  }
}
