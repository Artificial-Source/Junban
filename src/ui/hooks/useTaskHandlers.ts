import { useState, useCallback } from "react";
import { useTaskContext } from "../context/TaskContext.js";
import { useSoundEffect } from "./useSoundEffect.js";
import { api } from "../api/index.js";

export function useTaskHandlers(
  selectedProjectId: string | null,
  projects?: { id: string; name: string }[],
) {
  const { state, createTask, updateTask, completeTask, deleteTask } = useTaskContext();
  const playSound = useSoundEffect();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const handleCreateTask = async (parsed: {
    title: string;
    priority: number | null;
    tags: string[];
    project: string | null;
    dueDate: Date | null;
    dueTime: boolean;
    recurrence?: string | null;
  }) => {
    if (!parsed.title.trim()) return;
    let projectId = selectedProjectId;
    if (parsed.project && projects) {
      const match = projects.find((p) => p.name.toLowerCase() === parsed.project!.toLowerCase());
      if (match) projectId = match.id;
    }
    await createTask({
      title: parsed.title,
      priority: parsed.priority,
      dueDate: parsed.dueDate?.toISOString() ?? null,
      dueTime: parsed.dueTime,
      tags: parsed.tags,
      projectId,
      ...(parsed.recurrence ? { recurrence: parsed.recurrence } : {}),
    } as any);
    playSound("create");
  };

  const handleToggleTask = async (id: string) => {
    const task = state.tasks.find((t) => t.id === id);
    if (task?.status === "completed") {
      await updateTask(id, { status: "pending", completedAt: null } as any);
    } else {
      await completeTask(id);
      playSound("complete");
    }
  };

  const handleSelectTask = (id: string) => {
    setSelectedTaskId(id);
  };

  const handleCloseDetail = () => {
    setSelectedTaskId(null);
  };

  const handleUpdateTask = async (id: string, input: Parameters<typeof updateTask>[1]) => {
    await updateTask(id, input);
  };

  const handleDeleteTask = async (id: string) => {
    await deleteTask(id);
    playSound("delete");
    setSelectedTaskId(null);
  };

  const handleUpdateDueDate = useCallback(
    async (taskId: string, dueDate: string | null) => {
      if (dueDate) {
        await updateTask(taskId, { dueDate: new Date(dueDate).toISOString(), dueTime: false });
      } else {
        await updateTask(taskId, { dueDate: null, dueTime: false });
      }
    },
    [updateTask],
  );

  const handleAddSubtask = useCallback(
    async (parentId: string, title: string) => {
      await createTask({
        title,
        priority: null,
        dueDate: null,
        dueTime: false,
        tags: [],
        projectId: selectedProjectId,
        parentId,
      } as any);
    },
    [createTask, selectedProjectId],
  );

  const handleIndent = useCallback(async (id: string) => {
    try {
      await api.indentTask(id);
    } catch {
      // Non-critical
    }
  }, []);

  const handleOutdent = useCallback(async (id: string) => {
    try {
      await api.outdentTask(id);
    } catch {
      // Non-critical
    }
  }, []);

  const handleReorder = useCallback(async (orderedIds: string[]) => {
    try {
      await api.reorderTasks(orderedIds);
    } catch {
      // Non-critical — visual order already reflects the change
    }
  }, []);

  const selectedTask = selectedTaskId ? state.tasks.find((t) => t.id === selectedTaskId) : null;

  return {
    selectedTaskId,
    setSelectedTaskId,
    selectedTask,
    handleCreateTask,
    handleToggleTask,
    handleSelectTask,
    handleCloseDetail,
    handleUpdateTask,
    handleDeleteTask,
    handleUpdateDueDate,
    handleAddSubtask,
    handleIndent,
    handleOutdent,
    handleReorder,
  };
}
