import { useCallback, useEffect } from "react";
import { useTaskContext } from "../context/TaskContext.js";
import { useVoiceContext } from "../context/VoiceContext.js";
import { api } from "../api/index.js";
import type { View } from "../hooks/useRouting.js";
import type { SoundEvent } from "../../utils/sounds.js";
import type { Task, UpdateTaskInput } from "../../core/types.js";
import { isTauri } from "../../utils/tauri.js";
import type { ParsedTaskInput } from "./ViewRenderer.js";

interface UseAppHandlersParams {
  currentView: View;
  selectedProjectId: string | null;
  handleNavigate: (view: View | string, id?: string) => void;
  handleUpdateTask: (id: string, data: UpdateTaskInput) => void;
  handleCreateTask: (data: ParsedTaskInput) => void;
  handleSelectTask: (id: string) => void;
  selectedTask: Task | null | undefined;
  showToast: (
    message: string,
    action?: { label: string; onClick: () => void },
  ) => void;
  playSound: (sound: SoundEvent) => void;
  fetchProjects: () => void;
  fetchSections: (projectId: string) => void;
  fetchCommentsAndActivity: (taskId: string) => void;
  refreshTasks: () => void;
  setAddTaskTrigger: React.Dispatch<React.SetStateAction<number>>;
  setTaskComments: React.Dispatch<React.SetStateAction<import("../../core/types.js").TaskComment[]>>;
  setTaskActivity: React.Dispatch<React.SetStateAction<import("../../core/types.js").TaskActivity[]>>;
  setFocusedTaskId: (id: string | null) => void;
  selectedTaskId: string | null;
  tasks: Task[];
}

/**
 * Encapsulates all app-level action handlers: project CRUD, section CRUD,
 * comment CRUD, task duplication, voice, quick capture (Tauri), etc.
 */
export function useAppHandlers({
  currentView,
  selectedProjectId,
  handleNavigate,
  handleUpdateTask,
  handleCreateTask,
  handleSelectTask,
  selectedTask,
  showToast,
  playSound,
  fetchProjects,
  fetchSections,
  fetchCommentsAndActivity,
  refreshTasks,
  setAddTaskTrigger,
  setTaskComments,
  setTaskActivity,
  setFocusedTaskId,
  selectedTaskId,
  tasks,
}: UseAppHandlersParams) {
  const { createTask } = useTaskContext();
  const voice = useVoiceContext();

  // ── Sync focused task for AI context ──
  useEffect(() => {
    setFocusedTaskId(selectedTaskId);
  }, [selectedTaskId, setFocusedTaskId]);

  // ── Project handlers ──
  const handleCreateProject = useCallback(
    async (
      name: string,
      color: string,
      icon: string,
      parentId: string | null,
      isFavorite: boolean,
      viewStyle: "list" | "board" | "calendar",
    ) => {
      try {
        await api.createProject(
          name,
          color || undefined,
          icon || undefined,
          parentId,
          isFavorite,
          viewStyle,
        );
        fetchProjects();
      } catch {
        /* Non-critical */
      }
    },
    [fetchProjects],
  );

  // ── Navigation handlers ──
  const handleOpenVoice = useCallback(() => {
    handleNavigate("ai-chat");
    if (voice.settings.voiceMode === "off") voice.updateSettings({ voiceMode: "push-to-talk" });
  }, [voice, handleNavigate]);

  const handleAddTask = useCallback(() => {
    const taskViews: View[] = ["inbox", "today", "upcoming", "project"];
    if (!taskViews.includes(currentView)) handleNavigate("inbox");
    setAddTaskTrigger((n) => n + 1);
  }, [currentView, handleNavigate, setAddTaskTrigger]);

  const handleRestoreTask = useCallback(
    async (id: string) => {
      await handleUpdateTask(id, { status: "pending", completedAt: null });
    },
    [handleUpdateTask],
  );

  const handleActivateTask = useCallback(
    async (id: string) => {
      await handleUpdateTask(id, { isSomeday: false });
    },
    [handleUpdateTask],
  );

  const handleDuplicateTask = useCallback(
    async (taskId: string) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      await createTask({
        title: `${task.title} (copy)`,
        description: task.description,
        priority: task.priority,
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        projectId: task.projectId,
        recurrence: task.recurrence,
        remindAt: task.remindAt,
        tags: task.tags.map((t) => t.name),
        estimatedMinutes: task.estimatedMinutes,
        deadline: task.deadline,
        isSomeday: task.isSomeday,
        sectionId: task.sectionId,
      });
      playSound("create");
    },
    [tasks, createTask, playSound],
  );

  const handleExtractedTasksCreate = useCallback(
    async (
      extractedTasks: Array<{
        title: string;
        priority: number | null;
        dueDate: string | null;
        description: string | null;
      }>,
      projectId: string | null,
    ) => {
      for (const t of extractedTasks) {
        await createTask({
          title: t.title,
          priority: t.priority,
          dueDate: t.dueDate,
          dueTime: false,
          description: t.description,
          projectId,
          tags: [],
        });
      }
      playSound("create");
    },
    [createTask, playSound],
  );

  const handleCopyTaskLink = useCallback(
    async (taskId: string) => {
      const url = `${window.location.origin}${window.location.pathname}#/task/${taskId}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast("Link copied to clipboard");
      } catch {
        showToast("Could not copy link");
      }
    },
    [showToast],
  );

  // ── Section handlers ──
  const handleCreateSection = useCallback(
    async (name: string) => {
      if (!selectedProjectId) return;
      await api.createSection(selectedProjectId, name);
      fetchSections(selectedProjectId);
    },
    [selectedProjectId, fetchSections],
  );
  const handleUpdateSection = useCallback(
    async (id: string, data: { name?: string; isCollapsed?: boolean }) => {
      await api.updateSection(id, data);
      if (selectedProjectId) fetchSections(selectedProjectId);
    },
    [selectedProjectId, fetchSections],
  );
  const handleDeleteSection = useCallback(
    async (id: string) => {
      await api.deleteSection(id);
      if (selectedProjectId) fetchSections(selectedProjectId);
      refreshTasks();
    },
    [selectedProjectId, fetchSections, refreshTasks],
  );
  const handleMoveTask = useCallback(
    async (taskId: string, sectionId: string | null) => {
      await handleUpdateTask(taskId, { sectionId });
    },
    [handleUpdateTask],
  );

  // ── Comments & Activity ──
  useEffect(() => {
    if (selectedTask) fetchCommentsAndActivity(selectedTask.id);
    else {
      setTaskComments([]);
      setTaskActivity([]);
    }
  }, [selectedTask, fetchCommentsAndActivity, setTaskComments, setTaskActivity]);

  const handleAddComment = useCallback(
    async (taskId: string, content: string) => {
      await api.addTaskComment(taskId, content);
      fetchCommentsAndActivity(taskId);
    },
    [fetchCommentsAndActivity],
  );
  const handleUpdateComment = useCallback(
    async (commentId: string, content: string) => {
      await api.updateTaskComment(commentId, content);
      if (selectedTask) fetchCommentsAndActivity(selectedTask.id);
    },
    [selectedTask, fetchCommentsAndActivity],
  );
  const handleDeleteComment = useCallback(
    async (commentId: string) => {
      await api.deleteTaskComment(commentId);
      if (selectedTask) fetchCommentsAndActivity(selectedTask.id);
    },
    [selectedTask, fetchCommentsAndActivity],
  );

  // ── Listen for plugin task detail open requests ──
  useEffect(() => {
    const handler = (e: Event) => {
      const taskId = (e as CustomEvent).detail?.taskId;
      if (taskId) handleSelectTask(taskId);
    };
    window.addEventListener("saydo:open-task-detail", handler);
    return () => window.removeEventListener("saydo:open-task-detail", handler);
  }, [handleSelectTask]);

  // ── Listen for quick-capture-submit events from the capture window (Tauri) ──
  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | null = null;

    async function setup() {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{
          title: string;
          priority: number | null;
          tags: string[];
          project: string | null;
          dueDate: string | null;
          dueTime: boolean;
          recurrence: string | null;
          estimatedMinutes: number | null;
          deadline: string | null;
          isSomeday: boolean;
        }>("quick-capture-submit", (event) => {
          const data = event.payload;
          handleCreateTask({
            title: data.title,
            priority: data.priority,
            tags: data.tags,
            project: data.project,
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            dueTime: data.dueTime,
            recurrence: data.recurrence,
            estimatedMinutes: data.estimatedMinutes,
            deadline: data.deadline ? new Date(data.deadline) : null,
            isSomeday: data.isSomeday,
          });
        });
      } catch {
        // Degrade gracefully
      }
    }

    setup();
    return () => {
      unlisten?.();
    };
  }, [handleCreateTask]);

  return {
    handleCreateProject,
    handleOpenVoice,
    handleAddTask,
    handleRestoreTask,
    handleActivateTask,
    handleDuplicateTask,
    handleExtractedTasksCreate,
    handleCopyTaskLink,
    handleCreateSection,
    handleUpdateSection,
    handleDeleteSection,
    handleMoveTask,
    handleAddComment,
    handleUpdateComment,
    handleDeleteComment,
  };
}

