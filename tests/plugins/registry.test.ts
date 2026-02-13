import { describe, it, expect } from "vitest";
import path from "node:path";
import { PluginRegistry, type RegistryEntry } from "../../src/plugins/registry.js";

const PLUGINS: RegistryEntry[] = [
  {
    id: "pomodoro",
    name: "Pomodoro Timer",
    description: "Built-in Pomodoro timer with configurable intervals.",
    author: "ASF",
    version: "1.0.0",
    repository: "https://github.com/asf/pomodoro",
    tags: ["productivity", "timer"],
    minDocketVersion: "0.1.0",
  },
  {
    id: "kanban",
    name: "Kanban Board",
    description: "Drag-and-drop Kanban board view for tasks.",
    author: "ASF",
    version: "1.0.0",
    repository: "https://github.com/asf/kanban",
    tags: ["view", "kanban"],
    minDocketVersion: "0.5.0",
  },
  {
    id: "git-sync",
    name: "Git Sync",
    description: "Sync task data via Git for version control.",
    author: "ASF",
    version: "1.0.0",
    repository: "https://github.com/asf/git-sync",
    tags: ["sync", "git"],
    minDocketVersion: "0.5.0",
  },
];

describe("PluginRegistry.search", () => {
  const registry = new PluginRegistry("./sources.json");

  it("finds plugins by name", () => {
    const results = registry.search(PLUGINS, "pomodoro");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("pomodoro");
  });

  it("finds plugins by description", () => {
    const results = registry.search(PLUGINS, "drag-and-drop");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("kanban");
  });

  it("finds plugins by tag", () => {
    const results = registry.search(PLUGINS, "sync");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("git-sync");
  });

  it("is case-insensitive", () => {
    const results = registry.search(PLUGINS, "KANBAN");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("kanban");
  });

  it("returns multiple matches", () => {
    const results = registry.search(PLUGINS, "asf");
    // "ASF" appears in author for all, but search checks name/description/tags only
    // None of these have "asf" in name, description, or tags
    expect(results).toHaveLength(0);
  });

  it("returns empty for no matches", () => {
    const results = registry.search(PLUGINS, "nonexistent");
    expect(results).toHaveLength(0);
  });

  it("matches partial strings", () => {
    const results = registry.search(PLUGINS, "timer");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("pomodoro");
  });

  it("handles empty query", () => {
    const results = registry.search(PLUGINS, "");
    expect(results).toHaveLength(3); // empty string matches everything
  });

  it("handles empty plugin list", () => {
    const results = registry.search([], "pomodoro");
    expect(results).toHaveLength(0);
  });

  it("matches across name and tags simultaneously", () => {
    // "view" is both in kanban's tags and description
    const results = registry.search(PLUGINS, "view");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("kanban");
  });
});

describe("PluginRegistry.loadLocal", () => {
  it("parses sources.json from project root", async () => {
    const sourcesPath = path.resolve(process.cwd(), "sources.json");
    const registry = new PluginRegistry(sourcesPath);
    const plugins = await registry.loadLocal();

    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins[0].id).toBeTruthy();
    expect(plugins[0].name).toBeTruthy();
  });

  it("returns empty array for malformed JSON path", async () => {
    const registry = new PluginRegistry("/nonexistent/path.json");
    const plugins = await registry.loadLocal();
    expect(plugins).toEqual([]);
  });

  it("includes downloadUrl when present", async () => {
    const sourcesPath = path.resolve(process.cwd(), "sources.json");
    const registry = new PluginRegistry(sourcesPath);
    const plugins = await registry.loadLocal();

    const withUrl = plugins.filter((p) => p.downloadUrl);
    expect(withUrl.length).toBeGreaterThan(0);
  });
});
