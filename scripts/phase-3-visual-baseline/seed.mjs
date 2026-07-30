/**
 * Synthetic Phase 3 visual-baseline workspace for Junban-legacy.
 *
 * Seeds through supported API paths only. No real tokens, hostnames, personal
 * paths, emails, or credentials. Due dates are floating YYYY-MM-DD keys relative
 * to the frozen capture day 2026-07-23.
 */

export const CAPTURE_NOW = new Date("2026-07-23T10:30:00");
const TODAY_KEY = "2026-07-23";

function dayKey(offset) {
  const [y, m, d] = TODAY_KEY.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function completedAt(dayOffset) {
  return `${dayKey(dayOffset)}T12:00:00.000Z`;
}

async function api(request, method, path, data) {
  const response = await request.fetch(path, {
    method,
    data,
    headers: { "Content-Type": "application/json" },
  });
  const text = await response.text();
  if (!response.ok()) {
    throw new Error(`${method} ${path} failed (${response.status()}): ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

const post = (request, path, data) => api(request, "POST", path, data);
const put = (request, path, data) => api(request, "PUT", path, data);
const patch = (request, path, data) => api(request, "PATCH", path, data);

async function setSetting(request, key, value) {
  await put(request, `/api/settings/${encodeURIComponent(key)}`, { value });
}

async function createProject(request, name, color, viewStyle) {
  const created = await post(request, "/api/projects", { name, color, viewStyle });
  return created.id;
}

async function createSection(request, projectId, name) {
  const created = await post(request, "/api/sections", { projectId, name });
  return created.id;
}

async function createTag(request, name, color) {
  await post(request, "/api/tags", { name, color });
}

async function createTask(request, seed) {
  const created = await post(request, "/api/tasks", {
    title: seed.title,
    projectId: seed.projectId ?? null,
    sectionId: seed.sectionId ?? null,
    priority: seed.priority ?? null,
    dueDate: seed.dueDate ?? null,
    dueTime: seed.dueTime ?? false,
    tags: seed.tags ?? [],
    estimatedMinutes: seed.estimatedMinutes ?? null,
    actualMinutes: seed.actualMinutes ?? null,
    recurrence: seed.recurrence ?? null,
    description: seed.description ?? null,
    parentId: seed.parentId ?? null,
    isSomeday: seed.isSomeday ?? false,
    remindAt: seed.remindAt ?? null,
    deadline: seed.deadline ?? null,
  });
  return created.id;
}

async function completeAt(request, taskId, dayOffset) {
  await patch(request, `/api/tasks/${taskId}`, {
    status: "completed",
    completedAt: completedAt(dayOffset),
  });
}

async function addComment(request, taskId, content) {
  await post(request, `/api/tasks/${taskId}/comments`, { content });
}

async function approvePlugin(request, pluginId) {
  const plugins = await api(request, "GET", "/api/plugins");
  const plugin = plugins.find((candidate) => candidate.id === pluginId);
  if (!plugin) throw new Error(`Built-in plugin ${pluginId} not discovered`);
  await post(request, `/api/plugins/${pluginId}/permissions/approve`, {
    permissions: plugin.permissions,
  });
}

async function timeblockingRpc(request, method, ...args) {
  const body = await post(request, "/api/plugins/timeblocking/rpc", { method, args });
  if (!body || body.ok === false) {
    throw new Error(
      `timeblocking RPC ${method} failed: ${body?.error ?? JSON.stringify(body)}`,
    );
  }
  return body.result;
}

/**
 * Reset disposable DB and seed one coherent Phase 3 authority workspace.
 */
export async function seedWorkspace(request) {
  await post(request, "/api/test-reset");

  await setSetting(request, "onboarding_completed", "true");
  await setSetting(request, "reduce_animations", "true");
  await setSetting(request, "week_start", "monday");
  await setSetting(request, "date_format", "short");
  await setSetting(request, "feature_calendar", "true");
  await setSetting(request, "feature_stats", "true");
  await setSetting(request, "feature_matrix", "true");
  await setSetting(request, "feature_comments", "true");
  await setSetting(request, "calendar_default_mode", "day");
  await setSetting(request, "eat_the_frog_enabled", "false");
  await setSetting(request, "nudge_enabled", "true");
  await setSetting(request, "nudge_overdue_alert", "true");
  await setSetting(request, "nudge_deadline_approaching", "false");
  await setSetting(request, "nudge_stale_tasks", "false");
  await setSetting(request, "nudge_empty_today", "false");
  await setSetting(request, "nudge_overloaded_day", "false");
  await setSetting(request, "daily_capacity_minutes", "480");

  for (const pluginId of ["calendar", "matrix", "stats", "timeblocking"]) {
    await approvePlugin(request, pluginId);
  }

  const website = await createProject(request, "Website Redesign", "#6366f1", "board");
  const docs = await createProject(request, "Documentation", "#10b981", "list");
  const community = await createProject(request, "Community", "#f59e0b", "list");

  await createTag(request, "frontend", "#6366f1");
  await createTag(request, "backend", "#10b981");
  await createTag(request, "docs", "#f59e0b");
  await createTag(request, "design", "#ec4899");
  await createTag(request, "bug", "#ef4444");
  await createTag(request, "review", "#8b5cf6");
  await createTag(request, "community", "#0ea5e9");

  const backlog = await createSection(request, website, "Backlog");
  const inProgress = await createSection(request, website, "In Progress");
  const done = await createSection(request, website, "Done");

  // Today
  await createTask(request, {
    title: "Review accessibility audit findings",
    projectId: website,
    priority: 1,
    dueDate: dayKey(0),
    tags: ["frontend", "review"],
    estimatedMinutes: 45,
  });
  const blockedTaskId = await createTask(request, {
    title: "Draft v1.1 release notes",
    projectId: docs,
    priority: 2,
    dueDate: dayKey(0),
    tags: ["docs"],
    estimatedMinutes: 30,
  });
  await createTask(request, {
    title: "Reply to plugin API discussion",
    projectId: community,
    priority: 3,
    dueDate: dayKey(0),
    tags: ["community"],
    estimatedMinutes: 20,
  });
  await createTask(request, {
    title: "Fix calendar timezone edge case",
    projectId: website,
    priority: 1,
    dueDate: dayKey(0),
    tags: ["backend", "bug"],
    estimatedMinutes: 90,
  });
  await createTask(request, {
    title: "Prepare community call agenda",
    projectId: community,
    priority: 2,
    dueDate: dayKey(0),
    tags: ["community", "docs"],
    estimatedMinutes: 25,
    recurrence: "weekly",
  });
  await createTask(request, {
    title: "Triage incoming issues",
    projectId: community,
    priority: 3,
    dueDate: dayKey(0),
    tags: ["community"],
    estimatedMinutes: 15,
    recurrence: "daily",
  });

  // Overdue (Today overdue section + Smart Nudge overdue_alert)
  await createTask(request, {
    title: "Merge dark mode tokens pull request",
    projectId: website,
    priority: 2,
    dueDate: dayKey(-1),
    tags: ["frontend", "review"],
    sectionId: inProgress,
  });
  await createTask(request, {
    title: "Update onboarding copy",
    projectId: docs,
    priority: 3,
    dueDate: dayKey(-2),
    tags: ["docs"],
  });

  // Upcoming / calendar week
  await createTask(request, {
    title: "Publish plugin author guide",
    projectId: docs,
    priority: 2,
    dueDate: dayKey(1),
    tags: ["docs"],
    estimatedMinutes: 60,
  });
  await createTask(request, {
    title: "Host weekly community call",
    projectId: community,
    priority: 2,
    dueDate: dayKey(1),
    tags: ["community"],
    recurrence: "weekly",
  });
  await createTask(request, {
    title: "Record product demo video",
    projectId: community,
    priority: 2,
    dueDate: dayKey(2),
    tags: ["community"],
    estimatedMinutes: 90,
  });
  await createTask(request, {
    title: "Design Stats empty state",
    projectId: website,
    priority: 2,
    dueDate: dayKey(2),
    tags: ["design", "frontend"],
    estimatedMinutes: 45,
  });
  await createTask(request, {
    title: "Ship matrix keyboard moves",
    projectId: website,
    priority: 1,
    dueDate: dayKey(3),
    tags: ["frontend"],
    estimatedMinutes: 60,
  });
  await createTask(request, {
    title: "Write capacity planning notes",
    projectId: docs,
    priority: 3,
    dueDate: dayKey(4),
    tags: ["docs"],
    estimatedMinutes: 30,
  });

  // Rich task with reminder + recurrence for task-detail authority
  const richTaskId = await createTask(request, {
    title: "Ship v1.1 release documentation",
    projectId: docs,
    priority: 1,
    dueDate: dayKey(0),
    dueTime: true,
    tags: ["docs", "review"],
    estimatedMinutes: 120,
    recurrence: "weekly",
    // Must stay strictly after real server wall-clock during capture. Legacy
    // delivery clears task.remindAt once the occurrence is marked delivered, and
    // the server clock is not frozen — only the browser clock is.
    remindAt: "2026-12-15T15:00:00.000Z",
    description: [
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
    ].join("\n"),
  });
  const subDone = await createTask(request, {
    title: "Document the completion API contract",
    parentId: richTaskId,
    priority: 2,
  });
  await completeAt(request, subDone, 0);
  await createTask(request, { title: "Refresh README screenshot gallery", parentId: richTaskId });
  await createTask(request, { title: "Add plugin migration notes", parentId: richTaskId });
  await addComment(
    request,
    richTaskId,
    "Screenshots should lead with the dark theme in the gallery.",
  );
  await addComment(
    request,
    richTaskId,
    "Make sure the API examples match the actual response shapes.",
  );
  await post(request, `/api/tasks/${richTaskId}/relations`, {
    relatedTaskId: blockedTaskId,
    type: "blocks",
  });

  // Board filler
  await createTask(request, {
    title: "Add quick-capture keyboard shortcut",
    projectId: website,
    sectionId: backlog,
    priority: 3,
    tags: ["frontend"],
  });
  await createTask(request, {
    title: "Redesign empty states",
    projectId: website,
    sectionId: inProgress,
    priority: 2,
    tags: ["design", "frontend"],
    estimatedMinutes: 60,
  });
  const boardDone = await createTask(request, {
    title: "Ship dark mode token system",
    projectId: website,
    sectionId: done,
    priority: 2,
    tags: ["frontend", "design"],
    estimatedMinutes: 120,
    actualMinutes: 135,
  });
  await completeAt(request, boardDone, -4);

  // Matrix priorities
  await createTask(request, {
    title: "Urgent important matrix sample",
    projectId: website,
    priority: 1,
    dueDate: dayKey(0),
    tags: ["frontend"],
    estimatedMinutes: 40,
  });
  await createTask(request, {
    title: "Schedule strategic roadmap review",
    projectId: docs,
    priority: 2,
    dueDate: dayKey(5),
    tags: ["docs"],
    estimatedMinutes: 50,
  });

  // Completed history for Stats + Weekly Review
  const history = [
    { title: "Set up CI release workflow", est: 60, actual: 75, day: -6 },
    { title: "Write plugin sandbox docs", est: 90, actual: 80, day: -6 },
    { title: "Add Markdown storage backend", est: 180, actual: 150, day: -5 },
    { title: "Implement task completion receipts", est: 120, actual: 140, day: -4 },
    { title: "Design Today view header", est: 45, actual: 40, day: -4 },
    { title: "Add voice activity detection", est: 90, actual: 110, day: -3 },
    { title: "Migrate to Drizzle ORM", est: 240, actual: 220, day: -2 },
    { title: "Build command palette", est: 60, actual: 55, day: -2 },
    { title: "Write setup guide", est: 90, actual: 100, day: -2 },
    { title: "Add MCP server bridge", est: 120, actual: 130, day: -1 },
    { title: "Implement bulk task operations", est: 150, actual: 140, day: -1 },
    { title: "Create plugin example gallery", est: 45, actual: 50, day: 0 },
    { title: "Document idempotency contract", est: 90, actual: 85, day: 0 },
  ];
  for (const item of history) {
    const id = await createTask(request, {
      title: item.title,
      estimatedMinutes: item.est,
      actualMinutes: item.actual,
    });
    await completeAt(request, id, item.day);
  }

  // Timeblocking day blocks + a multi-task slot
  const deepWorkTask = await createTask(request, {
    title: "Deep work: calendar day polish",
    projectId: website,
    priority: 1,
    dueDate: dayKey(0),
    tags: ["frontend"],
    estimatedMinutes: 90,
  });
  const slotTaskA = await createTask(request, {
    title: "Review pull request comments",
    projectId: website,
    priority: 2,
    dueDate: dayKey(0),
    tags: ["review"],
    estimatedMinutes: 30,
  });
  const slotTaskB = await createTask(request, {
    title: "Sync with design on tokens",
    projectId: website,
    priority: 2,
    dueDate: dayKey(0),
    tags: ["design"],
    estimatedMinutes: 30,
  });

  await timeblockingRpc(request, "createBlock", {
    title: "Deep work: calendar day polish",
    taskId: deepWorkTask,
    date: dayKey(0),
    startTime: "09:00",
    endTime: "10:30",
    color: "#6366f1",
    locked: false,
  });
  await timeblockingRpc(request, "createBlock", {
    title: "Ship v1.1 release documentation",
    taskId: richTaskId,
    date: dayKey(0),
    startTime: "11:00",
    endTime: "12:30",
    color: "#10b981",
    locked: false,
  });
  await timeblockingRpc(request, "createBlock", {
    title: "Community office hours",
    date: dayKey(0),
    startTime: "15:00",
    endTime: "16:00",
    color: "#f59e0b",
    locked: true,
  });
  // Nearby week blocks so Week mode is non-empty
  await timeblockingRpc(request, "createBlock", {
    title: "Publish plugin author guide",
    date: dayKey(1),
    startTime: "10:00",
    endTime: "11:00",
    color: "#10b981",
    locked: false,
  });
  await timeblockingRpc(request, "createBlock", {
    title: "Host weekly community call",
    date: dayKey(1),
    startTime: "14:00",
    endTime: "15:00",
    color: "#f59e0b",
    locked: false,
  });
  await timeblockingRpc(request, "createBlock", {
    title: "Record product demo video",
    date: dayKey(2),
    startTime: "09:30",
    endTime: "11:00",
    color: "#8b5cf6",
    locked: false,
  });

  const slot = await timeblockingRpc(request, "createSlot", {
    title: "Collaboration block",
    projectId: website,
    date: dayKey(0),
    startTime: "13:00",
    endTime: "14:00",
    color: "#ec4899",
    taskIds: [],
  });
  await timeblockingRpc(request, "addTaskToSlot", slot.id, slotTaskA);
  await timeblockingRpc(request, "addTaskToSlot", slot.id, slotTaskB);

  return {
    projects: { website, docs, community },
    sections: { backlog, inProgress, done },
    richTaskId,
    blockedTaskId,
  };
}
