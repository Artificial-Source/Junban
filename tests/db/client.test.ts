import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, resetDbConnectionForTests } from "../../src/db/client.js";

const tempDirs: string[] = [];

function makeTempDbPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junban-db-client-test-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  resetDbConnectionForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("db client singleton path handling", () => {
  it("reuses the same connection for the same path", () => {
    const dbPath = makeTempDbPath("same.sqlite");

    const first = getDb(dbPath);
    const second = getDb(dbPath);

    expect(second).toBe(first);
  });

  it("switches connection when DB path changes", () => {
    const firstPath = makeTempDbPath("first.sqlite");
    const secondPath = makeTempDbPath("second.sqlite");

    const first = getDb(firstPath);
    const second = getDb(secondPath);

    expect(second).not.toBe(first);
  });

  it("does not keep stale instance when switching back", () => {
    const firstPath = makeTempDbPath("first.sqlite");
    const secondPath = makeTempDbPath("second.sqlite");

    const first = getDb(firstPath);
    getDb(secondPath);
    const reopenedFirst = getDb(firstPath);

    expect(reopenedFirst).not.toBe(first);
  });
});
