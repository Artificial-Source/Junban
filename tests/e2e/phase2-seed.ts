/**
 * Phase 2 visual-authority seed.
 *
 * Seeds one coherent synthetic workspace through the real authenticated Rust
 * release-server API — never through UI shortcuts — so every visual scene
 * starts from deterministic organization state.  The data set is bounded to
 * the 12-scene matrix in `goals/rust-rewrite/evidence/phase-2-context-map.md`.
 */
import { randomUUID } from "node:crypto";

/** Fixed capture "today": Thursday 2026-07-23. */
export const PHASE2_TODAY = "2026-07-23";

/** Title → normalized completion/cancellation instant used by the visual spec's
 *  response interception so cancelled/completed history is deterministic. */
export const VISUAL_TIMESTAMP_OVERRIDES: Record<string, string> = {
  "Completed setup checklist": "2026-07-23T09:00:00.000Z",
  "Duplicate issue report": "2026-07-23T09:15:00.000Z",
  "Outdated spec review": "2026-07-22T14:30:00.000Z",
  "Deprecated API cleanup": "2026-07-21T11:00:00.000Z",
  "Document the completion API contract": "2026-07-23T08:30:00.000Z",
  "Ship dark mode token system": "2026-07-19T16:00:00.000Z",
};

export interface SeededWorkspace {
  projects: { website: string; docs: string; community: string };
  richTaskId: string;
  blockedTaskId: string;
  serverToday: string;
}

interface ApiHelper {
  post: (path: string, body?: unknown) => Promise<Record<string, unknown>>;
}

function snapshotId(body: Record<string, unknown>, key: string): string {
  const snapshot = (body as { event?: { snapshot?: Record<string, { id?: string }> } }).event
    ?.snapshot;
  const id = snapshot?.[key]?.id;
  if (!id)
    throw new Error(
      `Expected ${key} id in mutation response: ${JSON.stringify(body).slice(0, 200)}`,
    );
  return id;
}

function offsetDay(baseDate: string, offset: number): string {
  const [y, m, d] = baseDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const RICH_DESCRIPTION = [
  "## Goal",
  "",
  "Publish cohesive v1.1 documentation before the community call on Thursday.",
  "",
  "## Scope",
  "",
  "- Refresh the README screenshot gallery",
  "- Document the completion API contract",
  "- Add migration notes for plugin authors",
  "",
  "> Coordinate with the release lead before publishing anything live.",
].join("\n");

interface TaskSeed {
  title: string;
  projectId?: string;
  sectionId?: string;
  parentId?: string;
  priority?: number;
  dueDate?: string;
  tagIds?: string[];
  estimatedMinutes?: number;
  actualMinutes?: number;
  description?: string;
  someday?: boolean;
}

/** Seed the full Phase 2 workspace via the authenticated API. */
export async function seedPhase2Workspace(
  baseUrl: string,
  token: string,
): Promise<SeededWorkspace> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Origin: baseUrl,
  };

  const clockResponse = await fetch(`${baseUrl}/api/v1/tasks?view=today&limit=1`, {
    headers: { Authorization: `Bearer ${token}`, Origin: baseUrl },
  });
  if (!clockResponse.ok) {
    throw new Error(
      `GET task clock failed (${clockResponse.status}): ${await clockResponse.text()}`,
    );
  }
  const serverToday = ((await clockResponse.json()) as { as_of_date?: string }).as_of_date;
  if (!serverToday) throw new Error("Task clock response omitted as_of_date");
  const dayOffset = (offset: number) => offsetDay(serverToday, offset);

  const post: ApiHelper["post"] = async (path, body) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`POST ${path} failed (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as Record<string, unknown>;
  };

  const postStatus = async (path: string) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
    });
    if (!response.ok) {
      throw new Error(`POST ${path} failed (${response.status}): ${await response.text()}`);
    }
    return response.json();
  };

  // ── Tags ──────────────────────────────────────────────────────────────────
  const tagNames: Record<string, string> = {};
  for (const [name, color] of [
    ["frontend", "#6366f1"],
    ["backend", "#10b981"],
    ["docs", "#f59e0b"],
    ["design", "#ec4899"],
    ["bug", "#ef4444"],
    ["review", "#8b5cf6"],
  ]) {
    tagNames[name] = snapshotId(await post("/api/v1/tags", { name, color }), "tag");
  }

  // ── Projects ───────────────────────────────────────────────────────────────
  const website = snapshotId(
    await post("/api/v1/projects", { name: "Website Redesign", color: "#6366f1", view: "board" }),
    "project",
  );
  const docs = snapshotId(
    await post("/api/v1/projects", { name: "Documentation", color: "#10b981", view: "list" }),
    "project",
  );
  const community = snapshotId(
    await post("/api/v1/projects", { name: "Community", color: "#f59e0b", view: "list" }),
    "project",
  );

  // ── Sections ────────────────────────────────────────────────────────────────
  const sections: Record<string, string> = {};
  for (const [name, projectId] of [
    ["Backlog", website],
    ["In Progress", website],
    ["Done", website],
    ["Drafting", docs],
    ["Review", docs],
  ]) {
    sections[name] = snapshotId(
      await post("/api/v1/sections", { name, project_id: projectId }),
      "section",
    );
  }

  const createTask = async (seed: TaskSeed): Promise<string> => {
    const body: Record<string, unknown> = { title: seed.title, due_date: seed.dueDate ?? null };
    if (seed.projectId) body.project_id = seed.projectId;
    if (seed.sectionId) body.section_id = seed.sectionId;
    if (seed.parentId) body.parent_id = seed.parentId;
    if (seed.priority) body.priority = seed.priority;
    if (seed.tagIds) body.tag_ids = seed.tagIds;
    if (seed.estimatedMinutes) body.estimated_minutes = seed.estimatedMinutes;
    if (seed.actualMinutes) body.actual_minutes = seed.actualMinutes;
    if (seed.description) body.description = seed.description;
    if (seed.someday) body.someday = true;
    return snapshotId(await post("/api/v1/tasks", body), "task");
  };

  const tag = (...names: string[]) => names.map((n) => tagNames[n]);

  // ── Today tasks (due 2026-07-23) ───────────────────────────────────────────
  await createTask({
    title: "Review accessibility audit findings",
    projectId: website,
    priority: 1,
    dueDate: dayOffset(0),
    tagIds: tag("frontend", "review"),
    estimatedMinutes: 45,
  });
  const blockedTaskId = await createTask({
    title: "Draft v1.1 release notes",
    projectId: docs,
    priority: 2,
    dueDate: dayOffset(0),
    tagIds: tag("docs"),
    estimatedMinutes: 30,
  });
  await createTask({
    title: "Fix calendar timezone edge case",
    projectId: website,
    priority: 1,
    dueDate: dayOffset(0),
    tagIds: tag("backend", "bug"),
    estimatedMinutes: 90,
  });
  const richTaskId = await createTask({
    title: "Ship v1.1 release documentation",
    projectId: docs,
    priority: 1,
    dueDate: dayOffset(0),
    tagIds: tag("docs", "review"),
    estimatedMinutes: 120,
    description: RICH_DESCRIPTION,
  });
  await createTask({
    title: "Reply to plugin API discussion",
    projectId: community,
    priority: 3,
    dueDate: dayOffset(0),
    tagIds: tag("docs"),
    estimatedMinutes: 20,
  });

  // ── Overdue tasks ──────────────────────────────────────────────────────────
  await createTask({
    title: "Merge dark mode tokens pull request",
    projectId: website,
    sectionId: sections["In Progress"],
    priority: 2,
    dueDate: dayOffset(-1),
    tagIds: tag("frontend", "review"),
  });
  await createTask({
    title: "Update onboarding copy",
    projectId: docs,
    priority: 3,
    dueDate: dayOffset(-1),
    tagIds: tag("docs"),
  });
  await createTask({
    title: "Finalize design system tokens",
    projectId: website,
    priority: 2,
    dueDate: dayOffset(-2),
    tagIds: tag("design", "frontend"),
  });

  // ── Upcoming tasks ──────────────────────────────────────────────────────────
  await createTask({
    title: "Publish plugin author guide",
    projectId: docs,
    priority: 2,
    dueDate: dayOffset(1),
    tagIds: tag("docs"),
    estimatedMinutes: 60,
  });
  await createTask({
    title: "Host weekly community call",
    projectId: community,
    priority: 2,
    dueDate: dayOffset(1),
    tagIds: tag("docs"),
  });
  await createTask({
    title: "Record product demo video",
    projectId: community,
    priority: 2,
    dueDate: dayOffset(2),
    estimatedMinutes: 90,
  });
  await createTask({
    title: "Design Stats empty state",
    projectId: website,
    priority: 2,
    dueDate: dayOffset(3),
    tagIds: tag("design", "frontend"),
    estimatedMinutes: 45,
  });

  // ── Inbox tasks (no project, no due date) ───────────────────────────────────
  await createTask({ title: "Buy milk" });
  await createTask({ title: "Call dentist" });

  // ── Someday task ────────────────────────────────────────────────────────────
  await createTask({ title: "Research vacation destinations", someday: true });

  // ── Recently completed task (for Inbox) ──────────────────────────────────────
  const completedTask = await createTask({ title: "Completed setup checklist" });
  await postStatus(`/api/v1/tasks/${completedTask}/complete`);

  // ── Cancelled tasks (for Cancelled view) ─────────────────────────────────────
  const cancelled: Array<{ title: string; projectId: string }> = [
    { title: "Duplicate issue report", projectId: community },
    { title: "Outdated spec review", projectId: docs },
    { title: "Deprecated API cleanup", projectId: website },
  ];
  for (const c of cancelled) {
    const id = await createTask({ title: c.title, projectId: c.projectId });
    await postStatus(`/api/v1/tasks/${id}/cancel`);
  }

  // ── Rich task subtasks, comments, and relation ───────────────────────────────
  const subDone = await createTask({
    title: "Document the completion API contract",
    parentId: richTaskId,
    priority: 2,
  });
  await postStatus(`/api/v1/tasks/${subDone}/complete`);
  await createTask({ title: "Refresh README screenshot gallery", parentId: richTaskId });
  await createTask({ title: "Add plugin migration notes", parentId: richTaskId });

  await post(`/api/v1/tasks/${richTaskId}/comments`, {
    content: "Screenshots should lead with the dark theme in the gallery.",
  });
  await post(`/api/v1/tasks/${richTaskId}/comments`, {
    content: "Make sure the API examples match the actual response shapes.",
  });
  await post(`/api/v1/tasks/${richTaskId}/relations`, {
    to_task_id: blockedTaskId,
    kind: "blocks",
  });

  // ── Board tasks (Website Redesign sections, no due date) ──────────────────────
  await createTask({
    title: "Add quick-capture keyboard shortcut",
    projectId: website,
    sectionId: sections["Backlog"],
    priority: 3,
    tagIds: tag("frontend"),
  });
  await createTask({
    title: "Research Tauri v2 autostart API",
    projectId: website,
    sectionId: sections["Backlog"],
    priority: 2,
    tagIds: tag("backend"),
  });
  await createTask({
    title: "Redesign empty states",
    projectId: website,
    sectionId: sections["In Progress"],
    priority: 2,
    tagIds: tag("design", "frontend"),
    estimatedMinutes: 60,
  });
  await createTask({
    title: "Migrate to Tailwind v4 tokens",
    projectId: website,
    sectionId: sections["In Progress"],
    priority: 1,
    tagIds: tag("frontend"),
  });
  const boardDone = await createTask({
    title: "Ship dark mode token system",
    projectId: website,
    sectionId: sections["Done"],
    priority: 2,
    tagIds: tag("frontend", "design"),
    estimatedMinutes: 120,
    actualMinutes: 135,
  });
  await postStatus(`/api/v1/tasks/${boardDone}/complete`);

  // ── Documentation project section tasks (for Project list view) ──────────────
  await createTask({
    title: "Write API reference",
    projectId: docs,
    sectionId: sections["Drafting"],
    priority: 2,
  });
  await createTask({
    title: "Create onboarding tutorial",
    projectId: docs,
    sectionId: sections["Drafting"],
    priority: 3,
  });
  await createTask({
    title: "Review README",
    projectId: docs,
    sectionId: sections["Review"],
    priority: 2,
  });

  // ── Template (for Quick Add template selector) ───────────────────────────────
  await post("/api/v1/templates", {
    name: "Ship feature",
    title: "Ship {{feature}}",
    description: "Complete and ship the {{feature}} feature.",
    tag_names: ["frontend"],
  });

  // ── Saved filter (for Filters & Labels) ───────────────────────────────────────
  await post("/api/v1/saved_filters", {
    name: "High Priority",
    query: "p1",
    color: "#ef4444",
  });

  return { projects: { website, docs, community }, richTaskId, blockedTaskId, serverToday };
}
