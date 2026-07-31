/**
 * Phase 3 visual-authority seed.
 *
 * Seeds one coherent synthetic workspace through the real authenticated Rust
 * release-server `/api/v1` API — never UI shortcuts, direct DB, or behavior mocks.
 * Civil due dates are relative to the server's real as-of day so server-side
 * selection stays truthful; the visual suite normalizes display dates back to
 * the frozen capture day 2026-07-23 after selection.
 */
import { randomUUID } from "node:crypto";

/** Fixed capture "today": Thursday 2026-07-23. */
export const PHASE3_TODAY = "2026-07-23";

/** Future wall instant so live delivery cannot clear remind_at against real time. */
export const RICH_REMIND_AT = "2026-12-15T15:00:00.000Z";

export interface SeededPhase3Workspace {
  projects: { website: string; docs: string; community: string };
  sections: { backlog: string; inProgress: string; done: string };
  richTaskId: string;
  blockedTaskId: string;
  deepWorkTaskId: string;
  slotTaskAId: string;
  slotTaskBId: string;
  collaborationSlotId: string;
  deepWorkBlockId: string;
  /** Civil epoch used for visual date normalization (frozen capture day). */
  serverToday: string;
  /** Actual server as_of_date sampled at seed time. */
  realServerToday: string;
}

interface TaskSeed {
  title: string;
  projectId?: string;
  sectionId?: string;
  parentId?: string;
  priority?: number;
  dueDate?: string | null;
  dueTime?: { time: string; time_zone: string };
  tagIds?: string[];
  estimatedMinutes?: number;
  actualMinutes?: number;
  description?: string;
  recurrenceRule?: string;
  someday?: boolean;
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

function snapshotId(body: Record<string, unknown>, key: string): string {
  const snapshot = (body as { event?: { snapshot?: Record<string, { id?: string }> } }).event
    ?.snapshot;
  const id = snapshot?.[key]?.id;
  if (!id) {
    throw new Error(
      `Expected ${key} id in mutation response: ${JSON.stringify(body).slice(0, 240)}`,
    );
  }
  return id;
}

function offsetDay(baseDate: string, offset: number): string {
  const [y, m, d] = baseDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** Seed the full Phase 3 workspace via the authenticated API. */
export async function seedPhase3Workspace(
  baseUrl: string,
  token: string,
): Promise<SeededPhase3Workspace> {
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
  // Prefer frozen capture-day civil keys so browser-driven Calendar/Timeblocking
  // range reads (frozen clock) hit the same dates the seed wrote. Server-side
  // today/overdue selection for planning still works because the frozen day is
  // earlier than real serverToday in normal runs, so capture-day tasks remain
  // overdue/visible under server classification, and visual intercept can still
  // normalize any serverToday-relative fields when present.
  const dayOffset = (offset: number) => offsetDay(PHASE3_TODAY, offset);

  // Prefer the server-reported zone for timed due values when available.
  let timeZone = "UTC";
  try {
    const settingsRes = await fetch(`${baseUrl}/api/v1/settings/temporal`, {
      headers: { Authorization: `Bearer ${token}`, Origin: baseUrl },
    });
    if (settingsRes.ok) {
      const settings = (await settingsRes.json()) as { time_zone?: string };
      if (settings.time_zone) timeZone = settings.time_zone;
    }
  } catch {
    // Fall back to UTC; timed tasks still classify as scheduled.
  }

  const post = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`POST ${path} failed (${response.status}): ${await response.text()}`);
    }
    if (response.status === 204) return {};
    const text = await response.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
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
    ["community", "#0ea5e9"],
  ] as const) {
    tagNames[name] = snapshotId(await post("/api/v1/tags", { name, color }), "tag");
  }
  const tag = (...names: string[]) => names.map((n) => tagNames[n]);

  // ── Projects ──────────────────────────────────────────────────────────────
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

  // ── Sections ──────────────────────────────────────────────────────────────
  const backlog = snapshotId(
    await post("/api/v1/sections", { name: "Backlog", project_id: website }),
    "section",
  );
  const inProgress = snapshotId(
    await post("/api/v1/sections", { name: "In Progress", project_id: website }),
    "section",
  );
  const done = snapshotId(
    await post("/api/v1/sections", { name: "Done", project_id: website }),
    "section",
  );

  const createTask = async (seed: TaskSeed): Promise<string> => {
    const body: Record<string, unknown> = { title: seed.title };
    if (seed.dueDate !== undefined) body.due_date = seed.dueDate;
    if (seed.projectId) body.project_id = seed.projectId;
    if (seed.sectionId) body.section_id = seed.sectionId;
    if (seed.parentId) body.parent_id = seed.parentId;
    if (seed.priority) body.priority = seed.priority;
    if (seed.tagIds) body.tag_ids = seed.tagIds;
    if (seed.estimatedMinutes) body.estimated_minutes = seed.estimatedMinutes;
    if (seed.actualMinutes) body.actual_minutes = seed.actualMinutes;
    if (seed.description) body.description = seed.description;
    if (seed.recurrenceRule) body.recurrence_rule = seed.recurrenceRule;
    if (seed.dueTime) body.due_time = seed.dueTime;
    if (seed.someday) body.someday = true;
    return snapshotId(await post("/api/v1/tasks", body), "task");
  };

  const setReminder = async (taskId: string, remindAt: string) => {
    await post(`/api/v1/tasks/${taskId}/reminders/reschedule`, { remind_at: remindAt });
  };

  // ── Today ─────────────────────────────────────────────────────────────────
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
    title: "Reply to plugin API discussion",
    projectId: community,
    priority: 3,
    dueDate: dayOffset(0),
    tagIds: tag("community"),
    estimatedMinutes: 20,
  });
  await createTask({
    title: "Fix calendar timezone edge case",
    projectId: website,
    priority: 1,
    dueDate: dayOffset(0),
    tagIds: tag("backend", "bug"),
    estimatedMinutes: 90,
  });
  await createTask({
    title: "Prepare community call agenda",
    projectId: community,
    priority: 2,
    dueDate: dayOffset(0),
    tagIds: tag("community", "docs"),
    estimatedMinutes: 25,
    recurrenceRule: "weekly",
  });
  await createTask({
    title: "Triage incoming issues",
    projectId: community,
    priority: 3,
    dueDate: dayOffset(0),
    tagIds: tag("community"),
    estimatedMinutes: 15,
    recurrenceRule: "daily",
  });

  // ── Overdue ───────────────────────────────────────────────────────────────
  await createTask({
    title: "Merge dark mode tokens pull request",
    projectId: website,
    sectionId: inProgress,
    priority: 2,
    dueDate: dayOffset(-1),
    tagIds: tag("frontend", "review"),
  });
  await createTask({
    title: "Update onboarding copy",
    projectId: docs,
    priority: 3,
    dueDate: dayOffset(-2),
    tagIds: tag("docs"),
  });

  // ── Upcoming / calendar week ──────────────────────────────────────────────
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
    tagIds: tag("community"),
    recurrenceRule: "weekly",
  });
  await createTask({
    title: "Record product demo video",
    projectId: community,
    priority: 2,
    dueDate: dayOffset(2),
    tagIds: tag("community"),
    estimatedMinutes: 90,
  });
  await createTask({
    title: "Design Stats empty state",
    projectId: website,
    priority: 2,
    dueDate: dayOffset(2),
    tagIds: tag("design", "frontend"),
    estimatedMinutes: 45,
  });
  await createTask({
    title: "Ship matrix keyboard moves",
    projectId: website,
    priority: 1,
    dueDate: dayOffset(3),
    tagIds: tag("frontend"),
    estimatedMinutes: 60,
  });
  await createTask({
    title: "Write capacity planning notes",
    projectId: docs,
    priority: 3,
    dueDate: dayOffset(4),
    tagIds: tag("docs"),
    estimatedMinutes: 30,
  });

  // ── Rich task with reminder + recurrence ─────────────────────────────────
  const richTaskId = await createTask({
    title: "Ship v1.1 release documentation",
    projectId: docs,
    priority: 1,
    dueDate: dayOffset(0),
    dueTime: { time: "10:30:00", time_zone: timeZone },
    tagIds: tag("docs", "review"),
    estimatedMinutes: 120,
    recurrenceRule: "weekly",
    description: RICH_DESCRIPTION,
  });
  await setReminder(richTaskId, RICH_REMIND_AT);

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

  // ── Board filler ──────────────────────────────────────────────────────────
  await createTask({
    title: "Add quick-capture keyboard shortcut",
    projectId: website,
    sectionId: backlog,
    priority: 3,
    tagIds: tag("frontend"),
  });
  await createTask({
    title: "Redesign empty states",
    projectId: website,
    sectionId: inProgress,
    priority: 2,
    tagIds: tag("design", "frontend"),
    estimatedMinutes: 60,
  });
  const boardDone = await createTask({
    title: "Ship dark mode token system",
    projectId: website,
    sectionId: done,
    priority: 2,
    tagIds: tag("frontend", "design"),
    estimatedMinutes: 120,
    actualMinutes: 135,
  });
  await postStatus(`/api/v1/tasks/${boardDone}/complete`);

  // ── Matrix priorities ─────────────────────────────────────────────────────
  await createTask({
    title: "Urgent important matrix sample",
    projectId: website,
    priority: 1,
    dueDate: dayOffset(0),
    tagIds: tag("frontend"),
    estimatedMinutes: 40,
  });
  await createTask({
    title: "Schedule strategic roadmap review",
    projectId: docs,
    priority: 2,
    dueDate: dayOffset(5),
    tagIds: tag("docs"),
    estimatedMinutes: 50,
  });

  // ── Completed history for Stats / Weekly Review / End of Day ──────────────
  // Completions stamp the real server instant (no completed_at write API). Visual
  // interception can only normalize civil labels, not invent prior-day buckets.
  const history = [
    { title: "Set up CI release workflow", est: 60, actual: 75 },
    { title: "Write plugin sandbox docs", est: 90, actual: 80 },
    { title: "Add Markdown storage backend", est: 180, actual: 150 },
    { title: "Implement task completion receipts", est: 120, actual: 140 },
    { title: "Design Today view header", est: 45, actual: 40 },
    { title: "Add voice activity detection", est: 90, actual: 110 },
    { title: "Migrate to Drizzle ORM", est: 240, actual: 220 },
    { title: "Build command palette", est: 60, actual: 55 },
    { title: "Write setup guide", est: 90, actual: 100 },
    { title: "Add MCP server bridge", est: 120, actual: 130 },
    { title: "Implement bulk task operations", est: 150, actual: 140 },
    { title: "Create plugin example gallery", est: 45, actual: 50 },
    { title: "Document idempotency contract", est: 90, actual: 85 },
  ];
  for (const item of history) {
    const id = await createTask({
      title: item.title,
      estimatedMinutes: item.est,
      actualMinutes: item.actual,
    });
    await postStatus(`/api/v1/tasks/${id}/complete`);
  }

  // ── Timeblocking day blocks + multi-task slot ─────────────────────────────
  const deepWorkTaskId = await createTask({
    title: "Deep work: calendar day polish",
    projectId: website,
    priority: 1,
    dueDate: dayOffset(0),
    tagIds: tag("frontend"),
    estimatedMinutes: 90,
  });
  const slotTaskAId = await createTask({
    title: "Review pull request comments",
    projectId: website,
    priority: 2,
    dueDate: dayOffset(0),
    tagIds: tag("review"),
    estimatedMinutes: 30,
  });
  const slotTaskBId = await createTask({
    title: "Sync with design on tokens",
    projectId: website,
    priority: 2,
    dueDate: dayOffset(0),
    tagIds: tag("design"),
    estimatedMinutes: 30,
  });

  const deepWorkBlockId = snapshotId(
    await post("/api/v1/time-blocks", {
      title: "Deep work: calendar day polish",
      task_id: deepWorkTaskId,
      date: dayOffset(0),
      start: "09:00",
      end: "10:30",
      color: "#6366f1",
      locked: false,
    }),
    "time_block",
  );
  await post("/api/v1/time-blocks", {
    title: "Ship v1.1 release documentation",
    task_id: richTaskId,
    date: dayOffset(0),
    start: "11:00",
    end: "12:30",
    color: "#10b981",
    locked: false,
  });
  await post("/api/v1/time-blocks", {
    title: "Community office hours",
    date: dayOffset(0),
    start: "15:00",
    end: "16:00",
    color: "#f59e0b",
    locked: true,
  });
  await post("/api/v1/time-blocks", {
    title: "Publish plugin author guide",
    date: dayOffset(1),
    start: "10:00",
    end: "11:00",
    color: "#10b981",
    locked: false,
  });
  await post("/api/v1/time-blocks", {
    title: "Host weekly community call",
    date: dayOffset(1),
    start: "14:00",
    end: "15:00",
    color: "#f59e0b",
    locked: false,
  });
  await post("/api/v1/time-blocks", {
    title: "Record product demo video",
    date: dayOffset(2),
    start: "09:30",
    end: "11:00",
    color: "#8b5cf6",
    locked: false,
  });

  const collaborationSlotId = snapshotId(
    await post("/api/v1/time-slots", {
      title: "Collaboration block",
      project_id: website,
      date: dayOffset(0),
      start: "13:00",
      end: "14:00",
      color: "#ec4899",
    }),
    "time_slot",
  );
  await post(`/api/v1/time-slots/${collaborationSlotId}/tasks`, { task_id: slotTaskAId });
  await post(`/api/v1/time-slots/${collaborationSlotId}/tasks`, { task_id: slotTaskBId });

  return {
    projects: { website, docs, community },
    sections: { backlog, inProgress, done },
    richTaskId,
    blockedTaskId,
    deepWorkTaskId,
    slotTaskAId,
    slotTaskBId,
    collaborationSlotId,
    deepWorkBlockId,
    // Seed civil keys are frozen capture-day relative; report PHASE3_TODAY so
    // visual response normalization is a no-op for those dates.
    serverToday: PHASE3_TODAY,
    realServerToday: serverToday,
  };
}

/**
 * Shift a civil YYYY-MM-DD (optionally with a suffix) by the delta between
 * `sourceEpochDate` and `targetEpochDate`.
 * Defaults target to the frozen capture day so response normalization can call
 * `shiftCivilDate(value, serverToday)`.
 */
export function shiftCivilDate(
  value: string,
  sourceEpochDate: string,
  targetEpochDate: string = PHASE3_TODAY,
): string {
  const parse = (date: string) => {
    const [year, month, day] = date.slice(0, 10).split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  const delta = parse(targetEpochDate) - parse(sourceEpochDate);
  const shifted = new Date(parse(value) + delta).toISOString().slice(0, 10);
  return `${shifted}${value.slice(10)}`;
}
