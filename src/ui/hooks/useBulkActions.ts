import { useMemo } from "react";
import { useTaskContext } from "../context/TaskContext.js";
import { useUndoContext } from "../context/UndoContext.js";
import { useSoundEffect } from "./useSoundEffect.js";
import {
  createBulkCompleteAction,
  createBulkDeleteAction,
  createBulkUpdateAction,
} from "../../core/actions.js";
import type { Task, CreateTaskInput, UpdateTaskInput } from "../../core/types.js";

export function useBulkActions(multiSelectedIds: Set<string>, clearSelection: () => void) {
  const {
    state,
    completeManyTasks,
    deleteManyTasks,
    updateManyTasks,
    updateTask,
    createTask,
    completeTask,
    deleteTask,
    refreshTasks,
  } = useTaskContext();
  const { undoManager } = useUndoContext();
  const playSound = useSoundEffect();

  // Adapter: bridges TaskContext methods to the ActionAPI shape expected by action creators.
  const actionApi = useMemo(
    () => ({
      completeTask: async (id: string) => {
        await completeTask(id);
        return {} as Task;
      },
      deleteTask,
      updateTask: async (id: string, input: UpdateTaskInput) => {
        await updateTask(id, input);
        return {} as Task;
      },
      createTask: async (input: CreateTaskInput) => {
        await createTask(input);
        return {} as Task;
      },
      completeManyTasks,
      deleteManyTasks,
      updateManyTasks: async (ids: string[], changes: UpdateTaskInput) => {
        await updateManyTasks(ids, changes);
        return [] as Task[];
      },
      refreshTasks,
    }),
    [
      completeTask,
      deleteTask,
      updateTask,
      createTask,
      completeManyTasks,
      deleteManyTasks,
      updateManyTasks,
      refreshTasks,
    ],
  );

  const handleBulkComplete = async () => {
    const ids = Array.from(multiSelectedIds);
    const tasks = ids.map((id) => state.tasks.find((t) => t.id === id)).filter(Boolean) as Task[];
    if (tasks.length > 0) {
      await undoManager.perform(createBulkCompleteAction(actionApi, tasks));
    } else {
      await completeManyTasks(ids);
    }
    playSound("complete");
    clearSelection();
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(multiSelectedIds);
    const tasks = ids.map((id) => state.tasks.find((t) => t.id === id)).filter(Boolean) as Task[];
    if (tasks.length > 0) {
      await undoManager.perform(createBulkDeleteAction(actionApi, tasks));
    } else {
      await deleteManyTasks(ids);
    }
    playSound("delete");
    clearSelection();
  };

  const handleBulkMoveToProject = async (projectId: string | null) => {
    const ids = Array.from(multiSelectedIds);
    const tasks = ids.map((id) => state.tasks.find((t) => t.id === id)).filter(Boolean) as Task[];
    if (tasks.length > 0) {
      await undoManager.perform(createBulkUpdateAction(actionApi, tasks, { projectId }));
    } else {
      await updateManyTasks(ids, { projectId });
    }
    clearSelection();
  };

  const handleBulkAddTag = async (tag: string) => {
    // Per-task loop with different tag sets — too complex for a single undo action
    const ids = Array.from(multiSelectedIds);
    for (const id of ids) {
      const task = state.tasks.find((t) => t.id === id);
      if (task) {
        const existingTags = task.tags.map((t) => t.name);
        if (!existingTags.includes(tag)) {
          await updateTask(id, { tags: [...existingTags, tag] });
        }
      }
    }
    clearSelection();
  };

  return {
    handleBulkComplete,
    handleBulkDelete,
    handleBulkMoveToProject,
    handleBulkAddTag,
  };
}
