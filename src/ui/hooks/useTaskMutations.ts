/**
 * Task mutation helpers bound to the workspace context.
 * Each helper mints one operation ID, runs the mutation, and tracks undo.
 *
 * Quick-entry tag/project names are resolved against the live catalog here.
 * Domain parsing stays on the Rust side; this hook only maps names → IDs.
 */
import { useCallback } from "react";
import type {
  AddRelationRequest,
  CreateTaskRequest,
  PatchTaskRequest,
  MoveTaskRequest,
  ReorderTasksRequest,
  BulkTasksRequest,
  MutationResponse,
  QuickEntryDto,
  TagDto,
} from "../api/client";
import {
  createTask as createTaskApi,
  createTag as createTagApi,
  getCatalog,
  patchTask as patchTaskApi,
  deleteTask as deleteTaskApi,
  completeTask as completeTaskApi,
  uncompleteTask as uncompleteTaskApi,
  cancelTask as cancelTaskApi,
  reopenTask as reopenTaskApi,
  moveTask as moveTaskApi,
  reorderTasks as reorderTasksApi,
  bulkTasks as bulkTasksApi,
  parseQuickEntry as parseQuickEntryApi,
  applyTemplate as applyTemplateApi,
  addRelation as addRelationApi,
  removeRelation as removeRelationApi,
  rescheduleReminder as rescheduleReminderApi,
  dismissReminder as dismissReminderApi,
} from "../api/client";
import { useWorkspace } from "../context/WorkspaceContext";
import {
  formatCatalogResolveError,
  resolveCatalogEntity,
  trimCatalogName,
} from "../lib/catalogResolve";

/** Default color for tags auto-created from quick-entry `#tag` tokens. */
const QUICK_ENTRY_TAG_COLOR = "#8a2be2";

function tagIdFromMutation(result: MutationResponse): string | null {
  const snapshot = result.event.snapshot;
  if (snapshot && snapshot.resource_type === "tag") {
    return snapshot.tag.id;
  }
  return null;
}

export function useTaskMutations() {
  const { runMutation, catalog, refreshCatalog, showToast } = useWorkspace();

  const createTask = useCallback(
    async (body: CreateTaskRequest, undoLabel?: string) =>
      runMutation((opId) => createTaskApi(body, opId), {
        undoLabel: undoLabel ?? "Create task",
        successToast: "Task created",
      }),
    [runMutation],
  );

  const resolveOrCreateTagId = useCallback(
    async (name: string, workingTags: TagDto[]): Promise<string> => {
      const existing = resolveCatalogEntity(workingTags, name);
      if (existing.kind === "found") return existing.id;
      if (existing.kind === "ambiguous") {
        throw new Error(formatCatalogResolveError("tag", name, existing));
      }

      const created = await runMutation(
        (opId) =>
          createTagApi(
            {
              name: trimCatalogName(name),
              color: QUICK_ENTRY_TAG_COLOR,
            },
            opId,
          ),
        {
          // Receipt is still tracked for undo; avoid a separate toast before the task lands.
          undoLabel: "Create tag",
        },
      );
      const createdId = created ? tagIdFromMutation(created) : null;
      if (createdId) {
        const snapshot = created!.event.snapshot;
        if (snapshot && snapshot.resource_type === "tag") {
          workingTags.push(snapshot.tag);
        }
        return createdId;
      }

      // Concurrent create or other failure: reload authoritative catalog and re-resolve.
      const fresh = await getCatalog();
      refreshCatalog();
      workingTags.splice(0, workingTags.length, ...fresh.tags);
      const retry = resolveCatalogEntity(fresh.tags, name);
      if (retry.kind === "found") return retry.id;
      if (retry.kind === "ambiguous") {
        throw new Error(formatCatalogResolveError("tag", name, retry));
      }
      throw new Error(`Could not create or find tag "${trimCatalogName(name)}".`);
    },
    [runMutation, refreshCatalog],
  );

  const createFromQuickEntry = useCallback(
    async (parsed: QuickEntryDto, defaults?: Partial<CreateTaskRequest>) => {
      const workingTags = [...(catalog?.tags ?? [])];
      const projects = catalog?.projects ?? [];

      let projectId: string | null | undefined = defaults?.project_id;
      if (parsed.project_name) {
        const resolved = resolveCatalogEntity(projects, parsed.project_name);
        if (resolved.kind !== "found") {
          throw new Error(formatCatalogResolveError("project", parsed.project_name, resolved));
        }
        projectId = resolved.id;
      }

      const tagIds: string[] = [];
      for (const tagName of parsed.tag_names) {
        const tagId = await resolveOrCreateTagId(tagName, workingTags);
        if (!tagIds.includes(tagId)) tagIds.push(tagId);
      }

      const body: CreateTaskRequest = {
        title: parsed.title,
        priority: parsed.priority ?? null,
        due_date: parsed.due_date ?? null,
        deadline: parsed.deadline ?? null,
        someday: parsed.someday,
        estimated_minutes: parsed.estimated_minutes ?? null,
        dread: parsed.dread ?? null,
        recurrence_rule: parsed.recurrence_rule ?? null,
        ...defaults,
        // Resolved IDs always win over view defaults so `#tag` / `@project` are not dropped.
        tag_ids: tagIds,
        ...(projectId !== undefined ? { project_id: projectId } : {}),
      };
      return runMutation((opId) => createTaskApi(body, opId), {
        undoLabel: "Create task",
        successToast: "Task created",
      });
    },
    [runMutation, catalog, resolveOrCreateTagId],
  );

  const patchTask = useCallback(
    async (taskId: string, body: PatchTaskRequest, undoLabel?: string) =>
      runMutation((opId) => patchTaskApi(taskId, body, opId), {
        undoLabel: undoLabel ?? "Edit task",
        successToast: "Task updated",
      }),
    [runMutation],
  );

  const deleteTask = useCallback(
    async (taskId: string) =>
      runMutation((opId) => deleteTaskApi(taskId, opId), {
        undoLabel: "Delete task",
        successToast: "Task deleted",
      }),
    [runMutation],
  );

  const completeTask = useCallback(
    async (taskId: string) =>
      runMutation((opId) => completeTaskApi(taskId, opId), {
        undoLabel: "Complete task",
        successToast: "Task completed",
      }),
    [runMutation],
  );

  const uncompleteTask = useCallback(
    async (taskId: string) => {
      const result = await runMutation((opId) => uncompleteTaskApi(taskId, opId), {
        undoLabel: "Uncomplete task",
      });
      if (result) {
        const sourceOnly = result.uncomplete_outcome === "source_only";
        showToast(
          sourceOnly ? "info" : "success",
          sourceOnly ? "Task reopened. Recurring changes were kept." : "Task reopened",
        );
      }
      return result;
    },
    [runMutation, showToast],
  );

  const cancelTask = useCallback(
    async (taskId: string) =>
      runMutation((opId) => cancelTaskApi(taskId, opId), {
        undoLabel: "Cancel task",
        successToast: "Task cancelled",
      }),
    [runMutation],
  );

  const reopenTask = useCallback(
    async (taskId: string) =>
      runMutation((opId) => reopenTaskApi(taskId, opId), {
        undoLabel: "Reopen task",
        successToast: "Task reopened",
      }),
    [runMutation],
  );

  const moveTask = useCallback(
    async (taskId: string, body: MoveTaskRequest) =>
      runMutation((opId) => moveTaskApi(taskId, body, opId), {
        undoLabel: "Move task",
        successToast: "Task moved",
      }),
    [runMutation],
  );

  const reorderTasks = useCallback(
    async (body: ReorderTasksRequest) =>
      runMutation((opId) => reorderTasksApi(body, opId), {
        undoLabel: "Reorder tasks",
      }),
    [runMutation],
  );

  const bulkTasks = useCallback(
    async (body: BulkTasksRequest, undoLabel?: string) =>
      runMutation((opId) => bulkTasksApi(body, opId), {
        undoLabel: undoLabel ?? "Bulk action",
        successToast: `${body.task_ids.length} tasks updated`,
      }),
    [runMutation],
  );

  const parseQuickEntry = useCallback((input: string) => parseQuickEntryApi({ input }), []);

  const applyTemplate = useCallback(
    async (templateId: string, variables?: Array<{ name: string; value: string }>) =>
      runMutation((opId) => applyTemplateApi({ template_id: templateId, variables }, opId), {
        undoLabel: "Apply template",
        successToast: "Task created from template",
      }),
    [runMutation],
  );

  const addRelation = useCallback(
    async (taskId: string, body: AddRelationRequest) =>
      runMutation((opId) => addRelationApi(taskId, body, opId), {
        undoLabel: "Add relation",
        successToast: "Relation added",
      }),
    [runMutation],
  );

  const removeRelation = useCallback(
    async (taskId: string, toTaskId: string) =>
      runMutation((opId) => removeRelationApi(taskId, toTaskId, opId), {
        undoLabel: "Remove relation",
        successToast: "Relation removed",
      }),
    [runMutation],
  );

  const rescheduleReminder = useCallback(
    async (taskId: string, remindAt: string, undoLabel?: string) =>
      runMutation((opId) => rescheduleReminderApi(taskId, { remind_at: remindAt }, opId), {
        undoLabel: undoLabel ?? "Schedule reminder",
        successToast: "Reminder scheduled",
      }),
    [runMutation],
  );

  const dismissReminder = useCallback(
    async (taskId: string) =>
      runMutation((opId) => dismissReminderApi(taskId, opId), {
        undoLabel: "Clear reminder",
        successToast: "Reminder cleared",
      }),
    [runMutation],
  );

  return {
    createTask,
    createFromQuickEntry,
    patchTask,
    deleteTask,
    completeTask,
    uncompleteTask,
    cancelTask,
    reopenTask,
    rescheduleReminder,
    dismissReminder,
    moveTask,
    reorderTasks,
    bulkTasks,
    parseQuickEntry,
    applyTemplate,
    addRelation,
    removeRelation,
  };
}
