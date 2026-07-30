import { describe, expect, it } from "vitest";
import {
  catalogNameKey,
  formatCatalogResolveError,
  resolveCatalogEntity,
  trimCatalogName,
} from "./catalogResolve";

describe("catalogResolve", () => {
  it("trims Unicode whitespace before matching", () => {
    expect(trimCatalogName("  work\t")).toBe("work");
    expect(catalogNameKey("\u00A0Work\u00A0")).toBe("work");
  });

  it("resolves existing names case-insensitively", () => {
    const tags = [
      { id: "t1", name: "Infra" },
      { id: "t2", name: "Home" },
    ];
    expect(resolveCatalogEntity(tags, "infra")).toEqual({ kind: "found", id: "t1" });
    expect(resolveCatalogEntity(tags, " HOME ")).toEqual({ kind: "found", id: "t2" });
  });

  it("reports missing names", () => {
    expect(resolveCatalogEntity([{ id: "t1", name: "a" }], "missing")).toEqual({
      kind: "not_found",
    });
    expect(resolveCatalogEntity([], "  ")).toEqual({ kind: "not_found" });
  });

  it("reports ambiguous case-insensitive collisions", () => {
    const projects = [
      { id: "p1", name: "Work" },
      { id: "p2", name: "work" },
    ];
    expect(resolveCatalogEntity(projects, "WORK")).toEqual({ kind: "ambiguous" });
    expect(formatCatalogResolveError("project", "WORK", { kind: "ambiguous" })).toContain(
      "Ambiguous project",
    );
  });

  it("treats duplicate rows of the same id as a single match", () => {
    const tags = [
      { id: "t1", name: "dup" },
      { id: "t1", name: "DUP" },
    ];
    expect(resolveCatalogEntity(tags, "dup")).toEqual({ kind: "found", id: "t1" });
  });
});
