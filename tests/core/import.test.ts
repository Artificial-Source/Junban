import { describe, it, expect } from "vitest";
import {
  detectFormat,
  parseDocketJSON,
  parseTodoistJSON,
  parseTextImport,
  parseImport,
} from "../../src/core/import.js";

describe("detectFormat", () => {
  it("detects Docket JSON by tasks + version fields", () => {
    const content = JSON.stringify({ tasks: [], version: "1.0", exportedAt: "2025-01-01" });
    expect(detectFormat(content)).toBe("docket-json");
  });

  it("detects Todoist JSON by items field", () => {
    const content = JSON.stringify({ items: [], projects: [] });
    expect(detectFormat(content)).toBe("todoist-json");
  });

  it("falls back to markdown for plain text", () => {
    expect(detectFormat("- [ ] Buy milk\n- [x] Walk dog")).toBe("markdown");
  });

  it("falls back to markdown for invalid JSON", () => {
    expect(detectFormat("{broken json")).toBe("markdown");
  });

  it("falls back to markdown for empty string", () => {
    expect(detectFormat("")).toBe("markdown");
  });
});

describe("parseDocketJSON", () => {
  it("parses a valid Docket export", () => {
    const data = {
      tasks: [
        {
          id: "t1",
          title: "Buy groceries",
          description: "Milk and eggs",
          status: "pending",
          priority: 1,
          dueDate: "2025-12-25T00:00:00.000Z",
          dueTime: false,
          completedAt: null,
          projectId: "p1",
          recurrence: null,
          tags: [{ id: "tag1", name: "shopping", color: "#000" }],
          sortOrder: 0,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
      projects: [{ id: "p1", name: "Home", color: "#3b82f6" }],
      tags: [{ id: "tag1", name: "shopping", color: "#000" }],
      exportedAt: "2025-06-01T00:00:00.000Z",
      version: "1.0",
    };

    const preview = parseDocketJSON(JSON.stringify(data));

    expect(preview.format).toBe("docket-json");
    expect(preview.tasks).toHaveLength(1);
    expect(preview.tasks[0].title).toBe("Buy groceries");
    expect(preview.tasks[0].description).toBe("Milk and eggs");
    expect(preview.tasks[0].status).toBe("pending");
    expect(preview.tasks[0].priority).toBe(1);
    expect(preview.tasks[0].projectName).toBe("Home");
    expect(preview.tasks[0].tagNames).toEqual(["shopping"]);
    expect(preview.projects).toEqual(["Home"]);
    expect(preview.tags).toEqual(["shopping"]);
    expect(preview.warnings).toHaveLength(0);
  });

  it("handles missing optional fields", () => {
    const data = {
      tasks: [{ title: "Simple task" }],
      version: "1.0",
    };

    const preview = parseDocketJSON(JSON.stringify(data));

    expect(preview.tasks).toHaveLength(1);
    expect(preview.tasks[0].title).toBe("Simple task");
    expect(preview.tasks[0].status).toBe("pending");
    expect(preview.tasks[0].priority).toBeNull();
    expect(preview.tasks[0].projectName).toBeNull();
    expect(preview.tasks[0].tagNames).toEqual([]);
  });

  it("warns on tasks with unknown project IDs", () => {
    const data = {
      tasks: [{ title: "Task", projectId: "unknown-project", tags: [] }],
      projects: [],
      version: "1.0",
    };

    const preview = parseDocketJSON(JSON.stringify(data));

    expect(preview.warnings.length).toBeGreaterThan(0);
    expect(preview.warnings[0]).toContain("unknown project ID");
  });

  it("returns warnings for invalid JSON", () => {
    const preview = parseDocketJSON("not json");
    expect(preview.tasks).toHaveLength(0);
    expect(preview.warnings).toHaveLength(1);
    expect(preview.warnings[0]).toContain("Invalid JSON");
  });

  it("returns warnings for invalid schema", () => {
    const preview = parseDocketJSON(JSON.stringify({ notTasks: true }));
    expect(preview.tasks).toHaveLength(0);
    expect(preview.warnings).toHaveLength(1);
    expect(preview.warnings[0]).toContain("Invalid Docket export format");
  });

  it("maps completed status correctly", () => {
    const data = {
      tasks: [{ title: "Done task", status: "completed", tags: [] }],
      version: "1.0",
    };

    const preview = parseDocketJSON(JSON.stringify(data));
    expect(preview.tasks[0].status).toBe("completed");
  });

  it("maps cancelled status to pending", () => {
    const data = {
      tasks: [{ title: "Cancelled task", status: "cancelled", tags: [] }],
      version: "1.0",
    };

    const preview = parseDocketJSON(JSON.stringify(data));
    expect(preview.tasks[0].status).toBe("pending");
  });
});

describe("parseTodoistJSON", () => {
  it("parses Todoist export with priority mapping", () => {
    const data = {
      items: [
        { content: "Urgent task", priority: 4, checked: false },
        { content: "High task", priority: 3, checked: false },
        { content: "Medium task", priority: 2, checked: false },
        { content: "No priority task", priority: 1, checked: false },
      ],
      projects: [],
    };

    const preview = parseTodoistJSON(JSON.stringify(data));

    expect(preview.format).toBe("todoist-json");
    expect(preview.tasks).toHaveLength(4);
    expect(preview.tasks[0].priority).toBe(1); // Todoist 4 → Docket 1
    expect(preview.tasks[1].priority).toBe(2); // Todoist 3 → Docket 2
    expect(preview.tasks[2].priority).toBe(3); // Todoist 2 → Docket 3
    expect(preview.tasks[3].priority).toBeNull(); // Todoist 1 → null
  });

  it("resolves project names from project_id", () => {
    const data = {
      items: [{ content: "Task", project_id: 123, priority: 1, checked: false }],
      projects: [{ id: 123, name: "Work" }],
    };

    const preview = parseTodoistJSON(JSON.stringify(data));

    expect(preview.tasks[0].projectName).toBe("Work");
    expect(preview.projects).toEqual(["Work"]);
  });

  it("maps labels to tagNames", () => {
    const data = {
      items: [{ content: "Task", labels: ["urgent", "work"], priority: 1, checked: false }],
    };

    const preview = parseTodoistJSON(JSON.stringify(data));

    expect(preview.tasks[0].tagNames).toEqual(["urgent", "work"]);
    expect(preview.tags).toEqual(["urgent", "work"]);
  });

  it("maps checked to completed status", () => {
    const data = {
      items: [
        { content: "Pending", checked: false, priority: 1 },
        { content: "Done", checked: true, priority: 1 },
      ],
    };

    const preview = parseTodoistJSON(JSON.stringify(data));

    expect(preview.tasks[0].status).toBe("pending");
    expect(preview.tasks[1].status).toBe("completed");
  });

  it("parses due dates", () => {
    const data = {
      items: [
        {
          content: "Task with date",
          priority: 1,
          checked: false,
          due: { date: "2025-12-25" },
        },
        {
          content: "Task with datetime",
          priority: 1,
          checked: false,
          due: { date: "2025-12-25T15:30:00" },
        },
      ],
    };

    const preview = parseTodoistJSON(JSON.stringify(data));

    expect(preview.tasks[0].dueDate).not.toBeNull();
    expect(preview.tasks[0].dueTime).toBe(false);
    expect(preview.tasks[1].dueDate).not.toBeNull();
    expect(preview.tasks[1].dueTime).toBe(true);
  });

  it("returns warnings for invalid JSON", () => {
    const preview = parseTodoistJSON("not json");
    expect(preview.tasks).toHaveLength(0);
    expect(preview.warnings[0]).toContain("Invalid JSON");
  });

  it("returns warnings for non-Todoist format", () => {
    const preview = parseTodoistJSON(JSON.stringify({ notItems: true }));
    expect(preview.tasks).toHaveLength(0);
    expect(preview.warnings[0]).toContain("Not a valid Todoist export");
  });
});

describe("parseTextImport", () => {
  it("parses checkbox format with [ ] and [x]", () => {
    const text = "- [ ] Pending task\n- [x] Completed task";
    const preview = parseTextImport(text);

    expect(preview.format).toBe("markdown");
    expect(preview.tasks).toHaveLength(2);
    expect(preview.tasks[0].title).toBe("Pending task");
    expect(preview.tasks[0].status).toBe("pending");
    expect(preview.tasks[1].title).toBe("Completed task");
    expect(preview.tasks[1].status).toBe("completed");
  });

  it("handles uppercase X in checkbox", () => {
    const text = "- [X] Done task";
    const preview = parseTextImport(text);

    expect(preview.tasks[0].status).toBe("completed");
  });

  it("parses bullet format without checkbox", () => {
    const text = "- Buy milk\n* Walk dog";
    const preview = parseTextImport(text);

    expect(preview.tasks).toHaveLength(2);
    expect(preview.tasks[0].title).toBe("Buy milk");
    expect(preview.tasks[0].status).toBe("pending");
    expect(preview.tasks[1].title).toBe("Walk dog");
    expect(preview.tasks[1].status).toBe("pending");
  });

  it("parses plain lines", () => {
    const text = "Buy milk\nWalk dog";
    const preview = parseTextImport(text);

    expect(preview.tasks).toHaveLength(2);
    expect(preview.tasks[0].title).toBe("Buy milk");
    expect(preview.tasks[1].title).toBe("Walk dog");
  });

  it("extracts priority, tags, and dates via parseTask", () => {
    const text = "- [ ] Buy milk p1 #groceries";
    const preview = parseTextImport(text);

    expect(preview.tasks[0].priority).toBe(1);
    expect(preview.tasks[0].tagNames).toEqual(["groceries"]);
    expect(preview.tags).toEqual(["groceries"]);
  });

  it("skips empty lines", () => {
    const text = "- Task 1\n\n\n- Task 2\n";
    const preview = parseTextImport(text);

    expect(preview.tasks).toHaveLength(2);
  });

  it("extracts project from +project syntax", () => {
    const text = "- Review PR +work";
    const preview = parseTextImport(text);

    expect(preview.tasks[0].projectName).toBe("work");
    expect(preview.projects).toEqual(["work"]);
  });
});

describe("parseImport", () => {
  it("auto-detects and parses Docket JSON", () => {
    const data = { tasks: [{ title: "Test" }], version: "1.0" };
    const preview = parseImport(JSON.stringify(data));
    expect(preview.format).toBe("docket-json");
    expect(preview.tasks).toHaveLength(1);
  });

  it("auto-detects and parses Todoist JSON", () => {
    const data = { items: [{ content: "Test", priority: 1, checked: false }] };
    const preview = parseImport(JSON.stringify(data));
    expect(preview.format).toBe("todoist-json");
    expect(preview.tasks).toHaveLength(1);
  });

  it("auto-detects and parses text", () => {
    const preview = parseImport("- [ ] Test task");
    expect(preview.format).toBe("markdown");
    expect(preview.tasks).toHaveLength(1);
  });

  it("uses explicit format override", () => {
    const preview = parseImport("some text", "markdown");
    expect(preview.format).toBe("markdown");
  });
});
