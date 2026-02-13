import { z } from "zod";
import { parseTask } from "../parser/task-parser.js";

export interface ImportedTask {
  title: string;
  description: string | null;
  status: "pending" | "completed";
  priority: number | null;
  dueDate: string | null;
  dueTime: boolean;
  projectName: string | null;
  tagNames: string[];
  recurrence: string | null;
}

export interface ImportPreview {
  tasks: ImportedTask[];
  projects: string[];
  tags: string[];
  warnings: string[];
  format: "docket-json" | "todoist-json" | "markdown";
}

export interface ImportResult {
  imported: number;
  errors: string[];
}

export type ImportFormat = ImportPreview["format"];

/** Auto-detect the format of an import file. */
export function detectFormat(content: string): ImportFormat {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      if ("tasks" in parsed && "version" in parsed) return "docket-json";
      if ("items" in parsed) return "todoist-json";
    }
  } catch {
    // Not JSON — treat as markdown/text
  }
  return "markdown";
}

// Zod schema matching ExportData from export.ts
const DocketTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
});

const DocketProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  icon: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
  archived: z.boolean().optional(),
  createdAt: z.string().optional(),
});

const DocketTaskSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  description: z.string().nullable().optional(),
  status: z.enum(["pending", "completed", "cancelled"]).optional(),
  priority: z.number().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  dueTime: z.boolean().optional(),
  completedAt: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  recurrence: z.string().nullable().optional(),
  tags: z.array(DocketTagSchema).optional(),
  sortOrder: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const DocketExportSchema = z.object({
  tasks: z.array(DocketTaskSchema),
  projects: z.array(DocketProjectSchema).optional(),
  tags: z.array(DocketTagSchema).optional(),
  exportedAt: z.string().optional(),
  version: z.string(),
});

/** Parse a Docket JSON export file. */
export function parseDocketJSON(json: string): ImportPreview {
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { tasks: [], projects: [], tags: [], warnings: ["Invalid JSON"], format: "docket-json" };
  }

  const result = DocketExportSchema.safeParse(raw);
  if (!result.success) {
    return {
      tasks: [],
      projects: [],
      tags: [],
      warnings: [
        `Invalid Docket export format: ${result.error.issues[0]?.message ?? "unknown error"}`,
      ],
      format: "docket-json",
    };
  }

  const data = result.data;
  const projectMap = new Map<string, string>();
  for (const p of data.projects ?? []) {
    projectMap.set(p.id, p.name);
  }

  const tasks: ImportedTask[] = data.tasks.map((t) => {
    const status = t.status === "completed" ? "completed" : "pending";
    const projectName = t.projectId ? (projectMap.get(t.projectId) ?? null) : null;
    if (t.projectId && !projectName) {
      warnings.push(`Task "${t.title}" references unknown project ID "${t.projectId}"`);
    }

    return {
      title: t.title,
      description: t.description ?? null,
      status,
      priority: t.priority ?? null,
      dueDate: t.dueDate ?? null,
      dueTime: t.dueTime ?? false,
      projectName,
      tagNames: (t.tags ?? []).map((tag) => tag.name),
      recurrence: t.recurrence ?? null,
    };
  });

  const projects = [
    ...new Set(tasks.map((t) => t.projectName).filter((n): n is string => n !== null)),
  ];
  const tags = [...new Set(tasks.flatMap((t) => t.tagNames))];

  return { tasks, projects, tags, warnings, format: "docket-json" };
}

/** Map Todoist priority (4=urgent, 1=none) to Docket priority (1=urgent, 4=low). */
function mapTodoistPriority(todoistPriority: number): number | null {
  const map: Record<number, number | null> = { 4: 1, 3: 2, 2: 3, 1: null };
  return map[todoistPriority] ?? null;
}

/** Parse a Todoist JSON export file. */
export function parseTodoistJSON(json: string): ImportPreview {
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {
      tasks: [],
      projects: [],
      tags: [],
      warnings: ["Invalid JSON"],
      format: "todoist-json",
    };
  }

  if (typeof raw !== "object" || raw === null || !("items" in raw)) {
    return {
      tasks: [],
      projects: [],
      tags: [],
      warnings: ["Not a valid Todoist export (missing items)"],
      format: "todoist-json",
    };
  }

  const data = raw as {
    items?: unknown[];
    projects?: unknown[];
    labels?: unknown[];
  };

  // Build project lookup
  const projectMap = new Map<string | number, string>();
  if (Array.isArray(data.projects)) {
    for (const p of data.projects) {
      if (typeof p === "object" && p !== null && "id" in p && "name" in p) {
        projectMap.set((p as { id: string | number }).id, String((p as { name: string }).name));
      }
    }
  }

  const items = Array.isArray(data.items) ? data.items : [];

  const tasks: ImportedTask[] = items.map((item: unknown) => {
    const i = item as Record<string, unknown>;

    const title = String(i.content ?? "Untitled");
    const description = i.description ? String(i.description) : null;
    const priority = typeof i.priority === "number" ? mapTodoistPriority(i.priority) : null;
    const checked = Boolean(i.checked);
    const status = checked ? "completed" : "pending";

    let dueDate: string | null = null;
    let dueTime = false;
    if (i.due && typeof i.due === "object" && (i.due as Record<string, unknown>).date) {
      const dueObj = i.due as Record<string, unknown>;
      const dateStr = String(dueObj.date);
      // Todoist dates can be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
      if (dateStr.includes("T")) {
        dueDate = new Date(dateStr).toISOString();
        dueTime = true;
      } else {
        dueDate = new Date(dateStr + "T00:00:00.000Z").toISOString();
      }
    }

    const projectId = i.project_id;
    const projectName =
      projectId !== undefined && projectId !== null
        ? (projectMap.get(projectId as string | number) ?? null)
        : null;

    const labels = Array.isArray(i.labels) ? i.labels.map(String) : [];

    return {
      title,
      description,
      status,
      priority,
      dueDate,
      dueTime,
      projectName,
      tagNames: labels,
      recurrence: null,
    };
  });

  if (tasks.length === 0 && items.length > 0) {
    warnings.push("Items were found but could not be parsed");
  }

  const projects = [
    ...new Set(tasks.map((t) => t.projectName).filter((n): n is string => n !== null)),
  ];
  const tags = [...new Set(tasks.flatMap((t) => t.tagNames))];

  return { tasks, projects, tags, warnings, format: "todoist-json" };
}

/** Parse plain text / Markdown import. */
export function parseTextImport(text: string): ImportPreview {
  const warnings: string[] = [];
  const lines = text.split("\n");
  const tasks: ImportedTask[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let status: "pending" | "completed" = "pending";
    let content: string;

    // Try checkbox format: - [x] or - [ ] or * [x] etc
    const checkboxMatch = trimmed.match(/^[-*]\s*\[([ xX])\]\s*(.+)/);
    if (checkboxMatch) {
      status = checkboxMatch[1] !== " " ? "completed" : "pending";
      content = checkboxMatch[2];
    } else {
      // Try bullet format: - item or * item
      const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
      if (bulletMatch) {
        content = bulletMatch[1];
      } else {
        // Plain line
        content = trimmed;
      }
    }

    // Parse content through the task parser for priority, tags, dates
    const parsed = parseTask(content);

    tasks.push({
      title: parsed.title,
      description: null,
      status,
      priority: parsed.priority,
      dueDate: parsed.dueDate ? parsed.dueDate.toISOString() : null,
      dueTime: parsed.dueTime,
      projectName: parsed.project,
      tagNames: parsed.tags,
      recurrence: null,
    });
  }

  const projects = [
    ...new Set(tasks.map((t) => t.projectName).filter((n): n is string => n !== null)),
  ];
  const tags = [...new Set(tasks.flatMap((t) => t.tagNames))];

  return { tasks, projects, tags, warnings, format: "markdown" };
}

/** Parse import content using auto-detected or specified format. */
export function parseImport(content: string, format?: ImportFormat): ImportPreview {
  const detected = format ?? detectFormat(content);
  switch (detected) {
    case "docket-json":
      return parseDocketJSON(content);
    case "todoist-json":
      return parseTodoistJSON(content);
    case "markdown":
      return parseTextImport(content);
  }
}
