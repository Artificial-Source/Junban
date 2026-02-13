import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  serializeFrontmatter,
  parseTaskFile,
  serializeTaskFile,
  taskFilename,
  slugify,
} from "../../src/storage/markdown-utils.js";

describe("parseFrontmatter", () => {
  it("extracts YAML frontmatter and body", () => {
    const content = `---
title: Hello
count: 42
---
This is the body.
`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.title).toBe("Hello");
    expect(result.frontmatter.count).toBe(42);
    expect(result.body).toContain("This is the body.");
  });

  it("returns empty frontmatter when none exists", () => {
    const result = parseFrontmatter("Just a body.");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("Just a body.");
  });

  it("handles empty body", () => {
    const content = `---
key: value
---
`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter.key).toBe("value");
    expect(result.body.trim()).toBe("");
  });
});

describe("serializeFrontmatter", () => {
  it("produces valid frontmatter + body", () => {
    const result = serializeFrontmatter({ b: 2, a: 1 }, "# Hello\n");
    expect(result).toMatch(/^---\n/);
    expect(result).toContain("a: 1");
    expect(result).toContain("b: 2");
    expect(result).toContain("---\n# Hello\n");
  });

  it("sorts keys alphabetically", () => {
    const result = serializeFrontmatter({ zebra: 1, alpha: 2, middle: 3 }, "body\n");
    const lines = result.split("\n");
    const yamlLines = lines.slice(1, lines.indexOf("---", 1));
    const keys = yamlLines.map((l) => l.split(":")[0]);
    expect(keys).toEqual(["alpha", "middle", "zebra"]);
  });

  it("adds trailing newline", () => {
    const result = serializeFrontmatter({ key: "val" }, "no newline");
    expect(result.endsWith("\n")).toBe(true);
  });

  it("roundtrips with parseFrontmatter", () => {
    const original = { alpha: 1, beta: "two", gamma: true };
    const body = "# Test\n\nBody text.\n";
    const serialized = serializeFrontmatter(original, body);
    const { frontmatter, body: parsedBody } = parseFrontmatter(serialized);
    expect(frontmatter.alpha).toBe(1);
    expect(frontmatter.beta).toBe("two");
    expect(frontmatter.gamma).toBe(true);
    expect(parsedBody).toContain("# Test");
    expect(parsedBody).toContain("Body text.");
  });
});

describe("slugify", () => {
  it("lowercases and replaces spaces with dashes", () => {
    expect(slugify("Buy Groceries")).toBe("buy-groceries");
  });

  it("handles special characters", () => {
    expect(slugify("Task @#$ with!!! symbols")).toBe("task-with-symbols");
  });

  it("handles unicode/diacritics", () => {
    expect(slugify("café résumé")).toBe("cafe-resume");
  });

  it("collapses consecutive dashes", () => {
    expect(slugify("a---b---c")).toBe("a-b-c");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles string with only special chars", () => {
    expect(slugify("@#$%")).toBe("");
  });
});

describe("taskFilename", () => {
  it("generates slug + last 6 of ID", () => {
    expect(taskFilename("Buy groceries", "abc123def456")).toBe("buy-groceries-def456.md");
  });

  it("handles short IDs", () => {
    expect(taskFilename("Test", "abc")).toBe("test-abc.md");
  });

  it("uses 'untitled' for empty title", () => {
    expect(taskFilename("", "abc123")).toBe("untitled-abc123.md");
  });

  it("handles special chars in title", () => {
    expect(taskFilename("Fix bug #42!", "abc123")).toBe("fix-bug-42-abc123.md");
  });
});

describe("parseTaskFile", () => {
  it("parses a complete task file", () => {
    const content = `---
completedAt: null
createdAt: "2025-01-01T00:00:00.000Z"
dueDate: "2025-12-25T00:00:00.000Z"
dueTime: false
id: "a1b2c3def456"
priority: 1
recurrence: null
sortOrder: 0
status: pending
tags:
  - groceries
  - errands
updatedAt: "2025-06-01T00:00:00.000Z"
---
# Buy groceries

Milk, eggs, bread, and butter from the store.
`;
    const { task, tagNames } = parseTaskFile(content, null);

    expect(task.id).toBe("a1b2c3def456");
    expect(task.title).toBe("Buy groceries");
    expect(task.description).toBe("Milk, eggs, bread, and butter from the store.");
    expect(task.status).toBe("pending");
    expect(task.priority).toBe(1);
    expect(task.dueDate).toBe("2025-12-25T00:00:00.000Z");
    expect(task.dueTime).toBe(false);
    expect(task.projectId).toBeNull();
    expect(task.sortOrder).toBe(0);
    expect(tagNames).toEqual(["groceries", "errands"]);
  });

  it("handles task with no description", () => {
    const content = `---
id: "task1"
status: pending
---
# Simple task
`;
    const { task } = parseTaskFile(content, null);
    expect(task.title).toBe("Simple task");
    expect(task.description).toBeNull();
  });

  it("uses projectId from argument", () => {
    const content = `---
id: "task1"
status: pending
---
# Work task
`;
    const { task } = parseTaskFile(content, "proj-1");
    expect(task.projectId).toBe("proj-1");
  });

  it("handles no tags in frontmatter", () => {
    const content = `---
id: "task1"
status: pending
---
# No tags
`;
    const { tagNames } = parseTaskFile(content, null);
    expect(tagNames).toEqual([]);
  });
});

describe("serializeTaskFile", () => {
  it("produces valid markdown with frontmatter", () => {
    const content = serializeTaskFile(
      {
        id: "abc123",
        status: "pending",
        priority: 1,
        dueDate: "2025-12-25T00:00:00.000Z",
        dueTime: false,
        completedAt: null,
        recurrence: null,
        sortOrder: 0,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      "Buy groceries",
      "Milk and eggs",
      ["groceries"],
    );

    expect(content).toMatch(/^---\n/);
    expect(content).toContain("id: abc123");
    expect(content).toContain("status: pending");
    expect(content).toContain("priority: 1");
    expect(content).toContain("# Buy groceries");
    expect(content).toContain("Milk and eggs");
    expect(content).toContain("tags:");
    expect(content).toContain("- groceries");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("omits tags array when empty", () => {
    const content = serializeTaskFile(
      {
        id: "abc123",
        status: "pending",
        priority: null,
        dueDate: null,
        dueTime: false,
        completedAt: null,
        recurrence: null,
        sortOrder: 0,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      "No tags task",
      null,
      [],
    );

    expect(content).not.toContain("tags:");
  });

  it("sorts frontmatter keys alphabetically", () => {
    const content = serializeTaskFile(
      {
        id: "abc123",
        status: "pending",
        priority: null,
        dueDate: null,
        dueTime: false,
        completedAt: null,
        recurrence: null,
        sortOrder: 0,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      "Test",
      null,
      [],
    );

    // Extract keys from YAML section
    const lines = content.split("\n");
    const start = lines.indexOf("---") + 1;
    const end = lines.indexOf("---", start);
    const yamlKeys = lines
      .slice(start, end)
      .filter((l) => /^\w/.test(l))
      .map((l) => l.split(":")[0]);

    const sorted = [...yamlKeys].sort();
    expect(yamlKeys).toEqual(sorted);
  });
});
