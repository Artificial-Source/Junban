import YAML from "yaml";

/** Parse YAML frontmatter + body from a markdown string. */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  const frontmatter = YAML.parse(match[1]) ?? {};
  return { frontmatter, body: match[2] };
}

/** Serialize frontmatter + body back to a markdown string. Keys are sorted alphabetically. */
export function serializeFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  // Sort keys alphabetically for minimal git diffs
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(frontmatter).sort()) {
    sorted[key] = frontmatter[key];
  }
  const yaml = YAML.stringify(sorted, { lineWidth: 0 }).trimEnd();
  const trailing = body.endsWith("\n") ? "" : "\n";
  return `---\n${yaml}\n---\n${body}${trailing}`;
}

/** Slugify a string for filesystem use. */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric → dash
    .replace(/^-+|-+$/g, "") // trim leading/trailing dashes
    .replace(/-{2,}/g, "-"); // collapse consecutive dashes
}

/** Generate filename: slugified title + last 6 chars of ID + .md */
export function taskFilename(title: string, id: string): string {
  const slug = slugify(title) || "untitled";
  const suffix = id.slice(-6);
  return `${slug}-${suffix}.md`;
}

/**
 * Parse a .md file into a TaskRow-compatible object + extract tag names.
 * The first `# heading` is the title; body after heading is description.
 * `projectId` is passed in (implicit from directory location).
 */
export function parseTaskFile(
  content: string,
  projectId: string | null,
): {
  task: {
    id: string;
    title: string;
    description: string | null;
    status: "pending" | "completed" | "cancelled";
    priority: number | null;
    dueDate: string | null;
    dueTime: boolean;
    completedAt: string | null;
    projectId: string | null;
    recurrence: string | null;
    parentId: string | null;
    remindAt: string | null;
    estimatedMinutes: number | null;
    actualMinutes: number | null;
    deadline: string | null;
    isSomeday: boolean;
    sectionId: string | null;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  };
  tagNames: string[];
} {
  const { frontmatter, body } = parseFrontmatter(content);

  // Extract title from first # heading
  const headingMatch = body.match(/^#\s+(.+)$/m);
  const title = headingMatch ? headingMatch[1].trim() : "Untitled";

  // Description is everything after the heading line
  let description: string | null = null;
  if (headingMatch) {
    const afterHeading = body.slice(body.indexOf(headingMatch[0]) + headingMatch[0].length).trim();
    description = afterHeading || null;
  }

  const tagNames: string[] = Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : [];

  return {
    task: {
      id: String(frontmatter.id ?? ""),
      title,
      description,
      status: (frontmatter.status as "pending" | "completed" | "cancelled") ?? "pending",
      priority: frontmatter.priority != null ? Number(frontmatter.priority) : null,
      dueDate: frontmatter.dueDate != null ? String(frontmatter.dueDate) : null,
      dueTime: Boolean(frontmatter.dueTime ?? false),
      completedAt: frontmatter.completedAt != null ? String(frontmatter.completedAt) : null,
      projectId,
      recurrence: frontmatter.recurrence != null ? String(frontmatter.recurrence) : null,
      parentId: frontmatter.parentId != null ? String(frontmatter.parentId) : null,
      remindAt: frontmatter.remindAt != null ? String(frontmatter.remindAt) : null,
      estimatedMinutes:
        frontmatter.estimatedMinutes != null ? Number(frontmatter.estimatedMinutes) : null,
      actualMinutes:
        frontmatter.actualMinutes != null ? Number(frontmatter.actualMinutes) : null,
      deadline: frontmatter.deadline != null ? String(frontmatter.deadline) : null,
      isSomeday: Boolean(frontmatter.isSomeday ?? false),
      sectionId: frontmatter.sectionId != null ? String(frontmatter.sectionId) : null,
      dreadLevel: frontmatter.dreadLevel != null ? Number(frontmatter.dreadLevel) : null,
      sortOrder: Number(frontmatter.sortOrder ?? 0),
      createdAt: String(frontmatter.createdAt ?? new Date().toISOString()),
      updatedAt: String(frontmatter.updatedAt ?? new Date().toISOString()),
    },
    tagNames,
  };
}

/**
 * Serialize a TaskRow + description + tag names into a .md file content string.
 * Tags are stored as names in frontmatter (not IDs) for readability.
 */
export function serializeTaskFile(
  task: {
    id: string;
    status: "pending" | "completed" | "cancelled";
    priority: number | null;
    dueDate: string | null;
    dueTime: boolean;
    completedAt: string | null;
    recurrence: string | null;
    parentId?: string | null;
    remindAt?: string | null;
    estimatedMinutes?: number | null;
    actualMinutes?: number | null;
    deadline?: string | null;
    isSomeday?: boolean;
    sectionId?: string | null;
    dreadLevel?: number | null;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  },
  title: string,
  description: string | null,
  tagNames: string[],
): string {
  const frontmatter: Record<string, unknown> = {
    id: task.id,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    completedAt: task.completedAt,
    recurrence: task.recurrence,
    parentId: task.parentId ?? null,
    remindAt: task.remindAt ?? null,
    estimatedMinutes: task.estimatedMinutes ?? null,
    actualMinutes: task.actualMinutes ?? null,
    deadline: task.deadline ?? null,
    isSomeday: task.isSomeday ?? false,
    sectionId: task.sectionId ?? null,
    dreadLevel: task.dreadLevel ?? null,
    sortOrder: task.sortOrder,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };

  if (tagNames.length > 0) {
    frontmatter.tags = tagNames;
  }

  // Remove null values — cleaner YAML
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null) {
      frontmatter[key] = null;
    }
  }

  const bodyParts = [`# ${title}`];
  if (description) {
    bodyParts.push("", description);
  }
  const body = bodyParts.join("\n") + "\n";

  return serializeFrontmatter(frontmatter, body);
}
