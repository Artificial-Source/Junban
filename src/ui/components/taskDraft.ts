import type { PatchTaskRequest, TaskDto } from "../api/client";

export interface TaskDraft {
  title: string;
  description: string;
  priority: number | null;
  due_date: string;
  deadline: string;
  someday: boolean;
  estimated_minutes: string;
  actual_minutes: string;
  dread: number | null;
  project_id: string;
  section_id: string;
  parent_id: string;
  tag_ids: string[];
  recurrence_rule: string;
}

export function draftFromTask(task: TaskDto): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority ?? null,
    due_date: task.due_date ?? "",
    deadline: task.deadline ? task.deadline.slice(0, 16) : "",
    someday: task.someday,
    estimated_minutes:
      task.estimated_minutes !== null && task.estimated_minutes !== undefined
        ? String(task.estimated_minutes)
        : "",
    actual_minutes:
      task.actual_minutes !== null && task.actual_minutes !== undefined
        ? String(task.actual_minutes)
        : "",
    dread: task.dread ?? null,
    project_id: task.project_id ?? "",
    section_id: task.section_id ?? "",
    parent_id: task.parent_id ?? "",
    tag_ids: [...task.tag_ids],
    recurrence_rule: task.recurrence_rule ?? "",
  };
}

function parseOptionalInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Build a sparse PATCH from draft vs committed task. Returns null when unchanged. */
export function buildTaskPatch(task: TaskDto, draft: TaskDraft): PatchTaskRequest | null {
  const patch: PatchTaskRequest = {};
  const trimmedTitle = draft.title.trim();
  if (trimmedTitle !== task.title) patch.title = trimmedTitle;

  if (draft.description !== task.description) patch.description = draft.description;

  const nextPriority = draft.priority;
  if (nextPriority !== (task.priority ?? null)) patch.priority = nextPriority;

  const nextDue = draft.due_date.trim() || null;
  if (nextDue !== (task.due_date ?? null)) patch.due_date = nextDue;

  const nextDeadline = draft.deadline.trim() ? new Date(draft.deadline).toISOString() : null;
  const prevDeadline = task.deadline ?? null;
  // Compare by minute precision used by the datetime-local input.
  const prevDeadlineLocal = prevDeadline ? prevDeadline.slice(0, 16) : "";
  const nextDeadlineLocal = draft.deadline.trim();
  if (nextDeadlineLocal !== prevDeadlineLocal) patch.deadline = nextDeadline;

  if (draft.someday !== task.someday) patch.someday = draft.someday;

  const nextEstimate = parseOptionalInt(draft.estimated_minutes);
  if (nextEstimate !== (task.estimated_minutes ?? null)) patch.estimated_minutes = nextEstimate;

  const nextActual = parseOptionalInt(draft.actual_minutes);
  if (nextActual !== (task.actual_minutes ?? null)) patch.actual_minutes = nextActual;

  if (draft.dread !== (task.dread ?? null)) patch.dread = draft.dread;

  const nextProject = draft.project_id || null;
  if (nextProject !== (task.project_id ?? null)) patch.project_id = nextProject;

  const nextSection = draft.section_id || null;
  if (nextSection !== (task.section_id ?? null)) patch.section_id = nextSection;

  const nextParent = draft.parent_id || null;
  if (nextParent !== (task.parent_id ?? null)) patch.parent_id = nextParent;

  const prevTags = task.tag_ids;
  const tagsChanged =
    draft.tag_ids.length !== prevTags.length ||
    draft.tag_ids.some((id, index) => id !== prevTags[index]);
  if (tagsChanged) patch.tag_ids = draft.tag_ids;

  const nextRecurrence = draft.recurrence_rule.trim() || null;
  if (nextRecurrence !== (task.recurrence_rule ?? null)) patch.recurrence_rule = nextRecurrence;

  return Object.keys(patch).length > 0 ? patch : null;
}
