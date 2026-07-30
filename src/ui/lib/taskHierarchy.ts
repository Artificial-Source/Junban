/**
 * Pure hierarchy helpers for list indent/outdent and depth rendering.
 *
 * Indent: make the task a child of the nearest preceding visible sibling
 * (same current parent) that is eligible as a parent.
 * Outdent: promote the task to a sibling immediately after its current parent
 * (new parent = grandparent or null).
 *
 * Operates only on the bounded visible task list; callers fetch a missing
 * parent snapshot when outdent needs the grandparent and it is not loaded.
 */
import type { MoveTaskRequest, TaskDto } from "../api/client";

export type HierarchyTask = Pick<TaskDto, "id" | "parent_id">;

/** Depth within the loaded parent graph. Missing parents contribute one level. */
export function depthsFromParentGraph(tasks: readonly HierarchyTask[]): Map<string, number> {
  const parentById = new Map<string, string | null | undefined>();
  for (const task of tasks) {
    parentById.set(task.id, task.parent_id);
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  function depthOf(id: string): number {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      // Cycle in loaded graph — treat as root to avoid infinite recursion.
      depths.set(id, 0);
      return 0;
    }
    visiting.add(id);
    const parentId = parentById.get(id);
    if (!parentId) {
      depths.set(id, 0);
      visiting.delete(id);
      return 0;
    }
    if (!parentById.has(parentId)) {
      // Parent not in the visible set: at least depth 1.
      depths.set(id, 1);
      visiting.delete(id);
      return 1;
    }
    const d = depthOf(parentId) + 1;
    depths.set(id, d);
    visiting.delete(id);
    return d;
  }

  for (const task of tasks) {
    depthOf(task.id);
  }
  return depths;
}

/**
 * Nearest preceding visible sibling under the same parent.
 * Returns null when indent is not possible in the current view.
 */
export function findIndentParentId(tasks: readonly HierarchyTask[], taskId: string): string | null {
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index <= 0) return null;

  const task = tasks[index]!;
  const currentParent = task.parent_id ?? null;

  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = tasks[i]!;
    if (candidate.id === taskId) continue;
    if ((candidate.parent_id ?? null) === currentParent) {
      // Never parent a task under itself (defensive).
      if (candidate.id === taskId) return null;
      return candidate.id;
    }
  }
  return null;
}

export interface OutdentPlan {
  /** New parent after outdent (grandparent or null). */
  parentId: string | null;
  /** Former parent — the task is placed immediately after this id. */
  afterTaskId: string;
  /** When true, the caller must fetch the former parent to learn the grandparent. */
  needsParentFetch: boolean;
}

/**
 * Plan an outdent. When the parent is not in the visible list, `needsParentFetch`
 * is set and `parentId` is left null until the caller supplies the parent row.
 */
export function planOutdent(tasks: readonly HierarchyTask[], taskId: string): OutdentPlan | null {
  const task = tasks.find((entry) => entry.id === taskId);
  if (!task?.parent_id) return null;

  const parentId = task.parent_id;
  const parent = tasks.find((entry) => entry.id === parentId);
  if (!parent) {
    return {
      parentId: null,
      afterTaskId: parentId,
      needsParentFetch: true,
    };
  }

  return {
    parentId: parent.parent_id ?? null,
    afterTaskId: parentId,
    needsParentFetch: false,
  };
}

/** Complete an outdent plan once a missing parent snapshot is available. */
export function completeOutdentPlan(
  plan: OutdentPlan,
  parent: HierarchyTask | null,
): OutdentPlan | null {
  if (!plan.needsParentFetch) return plan;
  if (!parent || parent.id !== plan.afterTaskId) return null;
  return {
    parentId: parent.parent_id ?? null,
    afterTaskId: plan.afterTaskId,
    needsParentFetch: false,
  };
}

/** True when `candidateParentId` is `taskId` or a descendant of `taskId` in the loaded graph. */
export function wouldCreateParentCycle(
  tasks: readonly HierarchyTask[],
  taskId: string,
  candidateParentId: string,
): boolean {
  if (taskId === candidateParentId) return true;
  const parentById = new Map<string, string | null | undefined>();
  for (const task of tasks) {
    parentById.set(task.id, task.parent_id);
  }
  // Walk up from the candidate: if we hit taskId, candidate is under taskId.
  let cursor: string | null | undefined = candidateParentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === taskId) return true;
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = parentById.get(cursor) ?? null;
    // Parent outside the loaded graph cannot be taskId (taskId is loaded).
    if (cursor && !parentById.has(cursor) && cursor !== taskId) break;
  }
  return false;
}

export function indentMoveRequest(parentId: string): MoveTaskRequest {
  return {
    parent_id: parentId,
    order: "last",
  };
}

export function outdentMoveRequest(plan: OutdentPlan): MoveTaskRequest {
  return {
    parent_id: plan.parentId,
    order: { after: { task_id: plan.afterTaskId } },
  };
}

/** Build the indent move for a task in the visible list, or null if not applicable. */
export function resolveIndentMove(
  tasks: readonly HierarchyTask[],
  taskId: string,
): MoveTaskRequest | null {
  const parentId = findIndentParentId(tasks, taskId);
  if (!parentId) return null;
  if (wouldCreateParentCycle(tasks, taskId, parentId)) return null;
  return indentMoveRequest(parentId);
}
