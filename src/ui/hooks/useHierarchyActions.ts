/**
 * Indent/outdent actions for a bounded visible task list.
 * Uses moveTask with explicit parent/order anchors; never infers server-side.
 */
import { useCallback } from "react";
import type { TaskDto } from "../api/client";
import { getTask } from "../api/client";
import {
  completeOutdentPlan,
  planOutdent,
  resolveIndentMove,
  outdentMoveRequest,
} from "../lib/taskHierarchy";
import { useTaskMutations } from "./useTaskMutations";

export function useHierarchyActions(tasks: readonly TaskDto[]) {
  const { moveTask } = useTaskMutations();

  const indent = useCallback(
    async (taskId: string): Promise<boolean> => {
      const body = resolveIndentMove(tasks, taskId);
      if (!body) return false;
      const result = await moveTask(taskId, body);
      return result !== null;
    },
    [tasks, moveTask],
  );

  const outdent = useCallback(
    async (taskId: string): Promise<boolean> => {
      let plan = planOutdent(tasks, taskId);
      if (!plan) return false;

      if (plan.needsParentFetch) {
        try {
          const parent = await getTask(plan.afterTaskId);
          plan = completeOutdentPlan(plan, parent);
          if (!plan) return false;
        } catch {
          return false;
        }
      }

      const result = await moveTask(taskId, outdentMoveRequest(plan));
      return result !== null;
    },
    [tasks, moveTask],
  );

  return { indent, outdent };
}
