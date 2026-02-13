import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../../src/db/schema.js";
import { SQLiteBackend } from "../../src/storage/sqlite-backend.js";
import type { IStorage } from "../../src/storage/interface.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../../src/db/migrations");

describe("Plugin Permissions (DB)", () => {
  let storage: IStorage;

  beforeEach(() => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    storage = new SQLiteBackend(db);
  });

  it("returns null for unapproved plugins", () => {
    const perms = storage.getPluginPermissions("unknown-plugin");
    expect(perms).toBeNull();
  });

  it("stores and retrieves permissions", () => {
    storage.setPluginPermissions("my-plugin", ["task:read", "task:write"]);

    const perms = storage.getPluginPermissions("my-plugin");
    expect(perms).toEqual(["task:read", "task:write"]);
  });

  it("updates permissions on re-set", () => {
    storage.setPluginPermissions("my-plugin", ["task:read"]);
    storage.setPluginPermissions("my-plugin", ["task:read", "storage"]);

    const perms = storage.getPluginPermissions("my-plugin");
    expect(perms).toEqual(["task:read", "storage"]);
  });

  it("deletes permissions", () => {
    storage.setPluginPermissions("my-plugin", ["task:read"]);
    storage.deletePluginPermissions("my-plugin");

    const perms = storage.getPluginPermissions("my-plugin");
    expect(perms).toBeNull();
  });

  it("isolates permissions between plugins", () => {
    storage.setPluginPermissions("plugin-a", ["task:read"]);
    storage.setPluginPermissions("plugin-b", ["storage", "network"]);

    expect(storage.getPluginPermissions("plugin-a")).toEqual(["task:read"]);
    expect(storage.getPluginPermissions("plugin-b")).toEqual(["storage", "network"]);
  });
});
