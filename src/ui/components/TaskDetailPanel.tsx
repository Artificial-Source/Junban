/**
 * Task detail modal — wide desktop shell with Phase 2/3 editable fields.
 *
 * Shell: full-viewport on mobile, max-w-4xl two-column desktop panel,
 * Escape close, focus trap, and focus restoration. No per-field auto-save.
 *
 * Left: title, description, subtasks, relations, comments/activity.
 * Right: due/deadline, priority, labels, reminder, recurrence, duration, delete.
 * Phase 2 fields live in one draft and commit via a single PATCH on Save.
 * Comments / activity / relations stay as separate resource actions.
 * Phase 3 adds recurrence (draft Save) and reminder controls (dedicated API).
 */
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import {
  X,
  Trash2,
  Inbox,
  Plus,
  Tag as TagIcon,
  Link,
  Search,
  Bell,
  Repeat,
  Focus,
  Calendar,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  MessageSquare,
  History,
  Pencil,
} from "lucide-react";
import type { TaskDto, TagDto, CommentDto, TaskActivityDto, RelationDto } from "../api/client";
import {
  getTask,
  listTasks,
  listTaskReminders,
  createComment as createCommentApi,
  patchComment as patchCommentApi,
  deleteComment as deleteCommentApi,
  generateOperationId,
  taskFromCommittedEvent,
  type ReminderOccurrenceDto,
} from "../api/client";
import { calendarDayKey, formatRelativeDate, todayKey } from "../lib/dates";
import { wouldCreateParentCycle } from "../lib/taskHierarchy";
import { useTaskMutations } from "../hooks/useTaskMutations";
import { useComments, useRelations, useTaskActivity } from "../hooks/useTaskDetail";
import { useWorkspace } from "../context/WorkspaceContext";
import { requestNotificationPermissionNonBlocking } from "../hooks/useReminderDelivery";
import { formatRecurrenceLabel } from "../lib/recurrence";
import { TaskMutationFeedback } from "./TaskMutationFeedback";
import { ConfirmDialog } from "./ConfirmDialog";
import { RecurrencePicker } from "./RecurrencePicker";
import { buildTaskPatch, draftFromTask, type TaskDraft } from "./taskDraft";

const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then((m) => ({ default: m.MarkdownPreview })),
);

interface TaskDetailPanelProps {
  task: TaskDto;
  onClose: () => void;
  /** Optional — full-page route can omit navigation chrome. */
  onOpenFullPage?: (taskId: string) => void;
  /** Captured before the async detail load isolates the application shell. */
  returnFocusTo?: HTMLElement | null;
  /** Enter Focus Mode for this task (`?focus=1`). */
  onEnterFocusMode?: (taskId: string) => void;
}

export function TaskDetailPanel({
  task,
  onClose,
  onOpenFullPage,
  returnFocusTo,
  onEnterFocusMode,
}: TaskDetailPanelProps) {
  const { catalog, mutationPhase, mutationError, revision } = useWorkspace();
  const {
    patchTask,
    deleteTask,
    completeTask,
    uncompleteTask,
    cancelTask,
    reopenTask,
    createTask,
    moveTask,
    addRelation,
    removeRelation,
    rescheduleReminder,
    dismissReminder,
  } = useTaskMutations();
  const { comments, loading: commentsLoading, reload: reloadComments } = useComments(task.id);
  const { blocks, blockedBy, reload: reloadRelations } = useRelations(task.id);
  const { activity, reload: reloadActivity } = useTaskActivity(task.id);

  const reloadCommentsAndActivity = useCallback(() => {
    void reloadComments();
    void reloadActivity();
  }, [reloadComments, reloadActivity]);

  // Committed source of truth for the open task. Draft is independent until Save/Reload.
  const [committed, setCommitted] = useState<TaskDto>(task);
  const [draft, setDraft] = useState<TaskDraft>(() => draftFromTask(task));
  const [stale, setStale] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<"comments" | "activity">("comments");
  const [newComment, setNewComment] = useState("");
  const [parent, setParent] = useState<TaskDto | null>(null);
  const [subtasks, setSubtasks] = useState<TaskDto[]>([]);
  const [parentSearch, setParentSearch] = useState("");
  const [parentResults, setParentResults] = useState<TaskDto[]>([]);
  const [parentSearching, setParentSearching] = useState(false);
  const [showParentSearch, setShowParentSearch] = useState(false);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [relSearch, setRelSearch] = useState("");
  const [relResults, setRelResults] = useState<TaskDto[]>([]);
  const [relSearching, setRelSearching] = useState(false);
  const [showRelSearch, setShowRelSearch] = useState(false);
  const [relKind, setRelKind] = useState<"blocks" | "blocked_by">("blocks");
  const [relationTitles, setRelationTitles] = useState<Map<string, string>>(new Map());
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [showRecurrencePicker, setShowRecurrencePicker] = useState(false);
  const [reminderInput, setReminderInput] = useState(() =>
    task.remind_at ? task.remind_at.slice(0, 16) : "",
  );
  const [reminderOccurrences, setReminderOccurrences] = useState<ReminderOccurrenceDto[]>([]);
  const [reminderError, setReminderError] = useState<string | null>(null);
  const [subtasksExpanded, setSubtasksExpanded] = useState(true);
  const [editingReminder, setEditingReminder] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const acceptNextCommittedRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const committedRef = useRef(committed);
  committedRef.current = committed;

  // Full reset only when the opened task identity changes.
  useEffect(() => {
    setCommitted(task);
    setDraft(draftFromTask(task));
    setStale(false);
    setError(null);
    setEditingDescription(false);
    setConfirmDelete(false);
    setNewComment("");
    setParentSearch("");
    setParentResults([]);
    setShowParentSearch(false);
    setSubtaskTitle("");
    setRelSearch("");
    setRelResults([]);
    setShowRelSearch(false);
    setRelationTitles(new Map());
    setResourceError(null);
    setSubtasksExpanded(true);
    setEditingReminder(false);
    acceptNextCommittedRef.current = false;
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps -- identity-only reset

  // When the parent pushes a newer committed snapshot for the same task:
  // - after our own successful Save, accept it and reset the draft
  // - if the draft is dirty, keep it and show a stale notice (no silent merge)
  // - if clean, adopt the remote fields
  useEffect(() => {
    if (task.id !== committedRef.current.id) return;
    if (
      task.revision === committedRef.current.revision &&
      task.updated_at === committedRef.current.updated_at
    ) {
      return;
    }

    if (acceptNextCommittedRef.current) {
      acceptNextCommittedRef.current = false;
      setCommitted(task);
      setDraft(draftFromTask(task));
      setStale(false);
      return;
    }

    const dirty = buildTaskPatch(committedRef.current, draftRef.current) !== null;
    setCommitted(task);
    if (dirty) {
      setStale(true);
    } else {
      setDraft(draftFromTask(task));
      setStale(false);
    }
  }, [task]);

  // Keep keyboard focus within the modal and return it to the control that opened it.
  useEffect(() => {
    openerRef.current =
      returnFocusTo ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    titleRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      // The shell releases `inert` in the same commit; restore afterward so
      // browsers do not reject focus while the opener is still isolated.
      queueMicrotask(() => {
        if (opener?.isConnected) opener.focus();
      });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- opener is captured exactly once at mount

  useEffect(() => {
    titleRef.current?.focus();
  }, [task.id]);

  // Focused hierarchy context — parent via getTask, children via parent_id query.
  useEffect(() => {
    let cancelled = false;

    async function loadHierarchy() {
      if (task.parent_id) {
        try {
          const loaded = await getTask(task.parent_id);
          if (!cancelled) setParent(loaded);
        } catch {
          if (!cancelled) setParent(null);
        }
      } else if (!cancelled) {
        setParent(null);
      }

      try {
        const page = await listTasks({ parent_id: task.id, limit: 100 });
        if (!cancelled) setSubtasks(page.tasks);
      } catch {
        if (!cancelled) setSubtasks([]);
      }
    }

    void loadHierarchy();
    return () => {
      cancelled = true;
    };
  }, [task.id, task.parent_id, revision]);

  // Resolve relation endpoint titles with focused getTask calls (bounded set).
  useEffect(() => {
    let cancelled = false;
    const ids = new Set<string>();
    for (const rel of blocks) ids.add(rel.to_task_id);
    for (const rel of blockedBy) ids.add(rel.from_task_id);
    ids.delete(task.id);

    async function loadTitles() {
      const next = new Map<string, string>();
      await Promise.all(
        [...ids].map(async (id) => {
          try {
            const loaded = await getTask(id);
            next.set(id, loaded.title);
          } catch {
            next.set(id, id);
          }
        }),
      );
      if (!cancelled) setRelationTitles(next);
    }

    if (ids.size === 0) {
      setRelationTitles(new Map());
      return;
    }
    void loadTitles();
    return () => {
      cancelled = true;
    };
  }, [blocks, blockedBy, task.id, revision]);

  useEffect(() => {
    if (!showParentSearch || !parentSearch.trim()) {
      setParentResults([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setParentSearching(true);
      void listTasks({ search: parentSearch.trim(), limit: 8 })
        .then((page) => {
          if (cancelled) return;
          const graph = [
            { id: committed.id, parent_id: committed.parent_id },
            ...subtasks.map((s) => ({ id: s.id, parent_id: s.parent_id })),
            ...(parent ? [{ id: parent.id, parent_id: parent.parent_id }] : []),
          ];
          setParentResults(
            page.tasks.filter(
              (candidate) =>
                candidate.id !== committed.id &&
                !wouldCreateParentCycle(graph, committed.id, candidate.id),
            ),
          );
        })
        .catch(() => {
          if (!cancelled) setParentResults([]);
        })
        .finally(() => {
          if (!cancelled) setParentSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [showParentSearch, parentSearch, committed.id, committed.parent_id, parent, subtasks]);

  useEffect(() => {
    if (!showRelSearch || !relSearch.trim()) {
      setRelResults([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setRelSearching(true);
      void listTasks({ search: relSearch.trim(), limit: 8 })
        .then((page) => {
          if (cancelled) return;
          const blockedIds = new Set([
            ...blocks.map((r) => r.to_task_id),
            ...blockedBy.map((r) => r.from_task_id),
          ]);
          setRelResults(
            page.tasks.filter(
              (candidate) => candidate.id !== committed.id && !blockedIds.has(candidate.id),
            ),
          );
        })
        .catch(() => {
          if (!cancelled) setRelResults([]);
        })
        .finally(() => {
          if (!cancelled) setRelSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [showRelSearch, relSearch, committed.id, blocks, blockedBy]);

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (confirmDelete) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;

    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const updateDraft = useCallback(<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleReloadCommitted = () => {
    setDraft(draftFromTask(committed));
    setStale(false);
    setError(null);
    setEditingDescription(false);
  };

  const handleSave = async () => {
    if (pending) return;
    const trimmedTitle = draft.title.trim();
    if (!trimmedTitle) {
      setError("Title must not be empty.");
      return;
    }
    const patch = buildTaskPatch(committed, { ...draft, title: trimmedTitle });
    if (!patch) {
      setError(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await patchTask(committed.id, patch);
      if (!result) {
        setError("Could not save changes.");
      } else {
        setEditingDescription(false);
        // Accept the next authoritative snapshot for this panel (from response or fan-out).
        acceptNextCommittedRef.current = true;
        const snapshot = taskFromCommittedEvent(result.event);
        if (snapshot) {
          acceptNextCommittedRef.current = false;
          setCommitted(snapshot);
          setDraft(draftFromTask(snapshot));
          setStale(false);
        }
      }
    } catch {
      setError("Could not save changes.");
    } finally {
      setPending(false);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await deleteTask(committed.id);
      if (result) {
        setConfirmDelete(false);
        onClose();
      } else {
        setError("Could not delete the task.");
        setConfirmDelete(false);
      }
    } catch {
      setError("Could not delete the task.");
      setConfirmDelete(false);
    } finally {
      setPending(false);
    }
  };

  const handleToggleComplete = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result =
        committed.status === "completed"
          ? await uncompleteTask(committed.id)
          : await completeTask(committed.id);
      if (!result) setError("Could not update the task.");
    } catch {
      setError("Could not update the task.");
    } finally {
      setPending(false);
    }
  };

  const handleAddComment = async () => {
    if (!newComment.trim() || pending) return;
    setPending(true);
    try {
      const opId = generateOperationId();
      await createCommentApi(committed.id, { content: newComment.trim() }, opId);
      setNewComment("");
      reloadCommentsAndActivity();
    } catch {
      setError("Could not add comment.");
    } finally {
      setPending(false);
    }
  };

  /** Hierarchy/relation resource actions commit immediately and must not touch the draft. */
  const handleSetParent = async (parentId: string | null) => {
    if (pending) return;
    setPending(true);
    setResourceError(null);
    try {
      const result = await moveTask(committed.id, {
        parent_id: parentId,
        order: parentId ? "last" : "keep",
      });
      if (!result) {
        setResourceError("Could not update parent.");
        return;
      }
      setShowParentSearch(false);
      setParentSearch("");
      setParentResults([]);
    } catch {
      setResourceError("Could not update parent.");
    } finally {
      setPending(false);
    }
  };

  const handleAddSubtask = async () => {
    const title = subtaskTitle.trim();
    if (!title || pending) return;
    setPending(true);
    setResourceError(null);
    try {
      const result = await createTask({
        title,
        parent_id: committed.id,
        project_id: committed.project_id ?? null,
        section_id: committed.section_id ?? null,
      });
      if (!result) {
        setResourceError("Could not create subtask.");
        return;
      }
      setSubtaskTitle("");
      // Refresh focused children list; draft is intentionally untouched.
      const page = await listTasks({ parent_id: committed.id, limit: 100 });
      setSubtasks(page.tasks);
    } catch {
      setResourceError("Could not create subtask.");
    } finally {
      setPending(false);
    }
  };

  const handleAddRelation = async (otherId: string) => {
    if (pending || otherId === committed.id) return;
    setPending(true);
    setResourceError(null);
    try {
      const fromId = relKind === "blocks" ? committed.id : otherId;
      const toId = relKind === "blocks" ? otherId : committed.id;
      const result = await addRelation(fromId, { kind: "blocks", to_task_id: toId });
      if (!result) {
        setResourceError("Could not add relation.");
        return;
      }
      setRelSearch("");
      setRelResults([]);
      setShowRelSearch(false);
      void reloadRelations();
      void reloadActivity();
    } catch {
      setResourceError("Could not add relation.");
    } finally {
      setPending(false);
    }
  };

  const handleRemoveRelation = async (rel: RelationDto) => {
    if (pending) return;
    setPending(true);
    setResourceError(null);
    try {
      const result = await removeRelation(rel.from_task_id, rel.to_task_id);
      if (!result) {
        setResourceError("Could not remove relation.");
        return;
      }
      void reloadRelations();
      void reloadActivity();
    } catch {
      setResourceError("Could not remove relation.");
    } finally {
      setPending(false);
    }
  };

  const titleOf = (id: string) => relationTitles.get(id) ?? id;

  useEffect(() => {
    setReminderInput(committed.remind_at ? committed.remind_at.slice(0, 16) : "");
  }, [committed.id, committed.remind_at]);

  useEffect(() => {
    let cancelled = false;
    void listTaskReminders(committed.id)
      .then((response) => {
        if (!cancelled) setReminderOccurrences(response.reminders);
      })
      .catch(() => {
        if (!cancelled) setReminderOccurrences([]);
      });
    return () => {
      cancelled = true;
    };
  }, [committed.id, committed.remind_at, revision]);

  const handleSaveReminder = async () => {
    const trimmed = reminderInput.trim();
    if (!trimmed) return;
    setReminderError(null);
    setPending(true);
    try {
      requestNotificationPermissionNonBlocking();
      const iso = new Date(trimmed).toISOString();
      const result = await rescheduleReminder(committed.id, iso);
      if (result === null) {
        setReminderError("The reminder could not be scheduled.");
        return;
      }
      const next = taskFromCommittedEvent(result.event) ?? (await getTask(committed.id));
      if (next) setCommitted(next);
    } catch (caught) {
      setReminderError(
        caught instanceof Error ? caught.message : "The reminder could not be scheduled.",
      );
    } finally {
      setPending(false);
    }
  };

  const handleClearReminder = async () => {
    setReminderError(null);
    setPending(true);
    try {
      const result = await dismissReminder(committed.id);
      if (result === null) {
        setReminderError("The reminder could not be cleared.");
        return;
      }
      setReminderInput("");
      const next = taskFromCommittedEvent(result.event) ?? (await getTask(committed.id));
      if (next) setCommitted(next);
    } catch (caught) {
      setReminderError(
        caught instanceof Error ? caught.message : "The reminder could not be cleared.",
      );
    } finally {
      setPending(false);
    }
  };

  const handleSnoozeReminder = async (minutes: number) => {
    setReminderError(null);
    setPending(true);
    try {
      const base = committed.remind_at ? new Date(committed.remind_at) : new Date();
      base.setMinutes(base.getMinutes() + minutes);
      const result = await rescheduleReminder(committed.id, base.toISOString(), "Snooze reminder");
      if (result === null) {
        setReminderError("The reminder could not be snoozed.");
        return;
      }
      const next = taskFromCommittedEvent(result.event) ?? (await getTask(committed.id));
      if (next) setCommitted(next);
    } catch (caught) {
      setReminderError(
        caught instanceof Error ? caught.message : "The reminder could not be snoozed.",
      );
    } finally {
      setPending(false);
    }
  };

  const dueDay = committed.due_date ? calendarDayKey(committed.due_date) : null;
  const isOverdue = dueDay !== null && committed.status === "pending" && dueDay < todayKey();
  const isCompleted = committed.status === "completed";
  const isCancelled = committed.status === "cancelled";
  const draftDirty = buildTaskPatch(committed, draft) !== null;

  const project = catalog?.projects.find((p) => p.id === committed.project_id) ?? null;
  const section = catalog?.sections.find((s) => s.id === committed.section_id) ?? null;
  const taskTags = draft.tag_ids
    .map((tagId) => (catalog?.tags ?? []).find((tag) => tag.id === tagId))
    .filter((tag): tag is NonNullable<typeof tag> => Boolean(tag));
  const projectName = project?.name ?? "Inbox";
  const sectionsForProject = (catalog?.sections ?? []).filter(
    (s) => s.project_id === (draft.project_id || null),
  );

  const completedSubtaskCount = subtasks.filter((s) => s.status === "completed").length;
  const subtaskProgress = subtasks.length > 0 ? (completedSubtaskCount / subtasks.length) * 100 : 0;
  const estimatedMinutes = draft.estimated_minutes.trim()
    ? Number.parseInt(draft.estimated_minutes, 10)
    : null;
  const estimatedLabel =
    estimatedMinutes !== null && Number.isFinite(estimatedMinutes) && estimatedMinutes > 0
      ? estimatedMinutes < 60
        ? `${estimatedMinutes}m`
        : `${Math.floor(estimatedMinutes / 60)}h${
            estimatedMinutes % 60 > 0 ? ` ${estimatedMinutes % 60}m` : ""
          }`
      : null;

  const PRIORITIES = [
    { value: 1, label: "P1", activeClass: "bg-priority-1/15 text-priority-1" },
    { value: 2, label: "P2", activeClass: "bg-priority-2/15 text-priority-2" },
    { value: 3, label: "P3", activeClass: "bg-priority-3/15 text-priority-3" },
    { value: 4, label: "P4", activeClass: "bg-priority-4/15 text-priority-4" },
  ] as const;

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-label={`Task: ${committed.title}`}
        onClick={onClose}
        onKeyDown={handleDialogKeyDown}
      >
        <div
          ref={dialogRef}
          data-testid="task-detail-surface"
          className="fixed inset-0 flex h-[100dvh] max-h-[100dvh] w-full min-w-0 flex-col overflow-hidden border border-border bg-surface shadow-xl animate-slide-up-fade md:relative md:inset-auto md:mx-4 md:h-[85dvh] md:max-h-[85dvh] md:max-w-4xl md:rounded-lg md:animate-scale-fade-in"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header — full width */}
          <div className="flex flex-shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2 py-2 min-[240px]:px-3 min-[240px]:py-3 md:px-6">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-on-surface-muted">
              <Inbox size={12} className="shrink-0" />
              <span className="truncate">{project ? projectName : "Inbox"}</span>
              {section && <span className="text-on-surface-muted">/ {section.name}</span>}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              {onEnterFocusMode && committed.status === "pending" && (
                <button
                  type="button"
                  onClick={() => onEnterFocusMode(committed.id)}
                  aria-label="Enter Focus Mode"
                  className="sr-only"
                >
                  <Focus size={14} aria-hidden="true" />
                  Focus
                </button>
              )}
              <button
                type="button"
                disabled
                aria-label="Previous task"
                title="Previous task navigation is unavailable"
                className="min-h-7 min-w-7 rounded-md p-1.5 text-on-surface-muted"
              >
                <ChevronUp size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                disabled
                aria-label="Next task"
                title="Next task navigation is unavailable"
                className="min-h-7 min-w-7 rounded-md p-1.5 text-on-surface-muted"
              >
                <ChevronDown size={16} aria-hidden="true" />
              </button>
              {onOpenFullPage && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenFullPage(committed.id);
                    onClose();
                  }}
                  aria-label="Open task actions"
                  className="min-h-7 min-w-7 rounded-md p-1.5 text-on-surface-muted transition-colors hover:bg-surface-tertiary hover:text-on-surface max-[239px]:hidden"
                  title="Open as full page"
                >
                  <MoreHorizontal size={16} aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close task details"
                className="ml-0.5 min-h-7 min-w-7 rounded-md p-2 text-on-surface-muted transition-colors hover:bg-surface-tertiary hover:text-on-surface min-[240px]:p-2.5 md:p-1.5"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Body — two columns on desktop */}
          <div
            data-testid="task-detail-scroll-region"
            className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden md:flex-row md:overflow-hidden"
          >
            {/* Left column */}
            <div className="flex min-h-0 flex-none flex-col space-y-4 overflow-visible p-3 md:flex-1 md:overflow-auto md:p-6">
              {/* Title */}
              <div className="flex items-start">
                <input
                  ref={titleRef}
                  type="text"
                  value={draft.title}
                  onChange={(e) => updateDraft("title", e.target.value)}
                  disabled={pending}
                  aria-label="Task title"
                  className={`w-full rounded-md border border-transparent bg-transparent text-xl font-semibold text-on-surface focus:border-focus focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${
                    isCompleted || isCancelled ? "line-through text-on-surface-muted" : ""
                  }`}
                />
              </div>

              {/* Description */}
              <div className="relative group/desc">
                {editingDescription ? (
                  <textarea
                    value={draft.description}
                    onChange={(e) => updateDraft("description", e.target.value)}
                    disabled={pending}
                    rows={6}
                    className="block min-h-[88px] w-full resize-y rounded-xl border border-border bg-transparent px-0 py-2 text-sm leading-6 text-on-surface placeholder-on-surface-muted focus:outline-none focus:ring-2 focus:ring-focus"
                    aria-label="Edit description"
                    placeholder="Add a description… (Markdown supported)"
                    autoFocus
                  />
                ) : (
                  <div
                    onClick={() => setEditingDescription(true)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setEditingDescription(true);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label="Description"
                    className="prose-sm min-h-[88px] cursor-text rounded-xl border border-transparent px-0 py-2 text-sm text-on-surface"
                  >
                    {draft.description ? (
                      <Suspense fallback={<span className="text-on-surface-muted">Loading…</span>}>
                        <MarkdownPreview content={draft.description} />
                      </Suspense>
                    ) : (
                      <span className="text-on-surface-muted">Add a description…</span>
                    )}
                  </div>
                )}
                {!editingDescription && draft.description && (
                  <button
                    type="button"
                    onClick={() => setEditingDescription(true)}
                    className="absolute top-0 right-0 rounded-md p-1 text-on-surface-muted opacity-0 transition-opacity hover:bg-surface-tertiary hover:text-on-surface group-hover/desc:opacity-100"
                    title="Edit description"
                    aria-label="Edit description"
                  >
                    <Pencil size={14} />
                  </button>
                )}
              </div>

              {/* Sub-tasks */}
              <div>
                <div className="flex items-center justify-between px-2">
                  <button
                    type="button"
                    onClick={() => setSubtasksExpanded((prev) => !prev)}
                    aria-expanded={subtasksExpanded}
                    className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-on-surface-muted transition-colors hover:text-on-surface"
                  >
                    <ChevronDown
                      size={14}
                      className={`transition-transform duration-200 ${subtasksExpanded ? "" : "-rotate-90"}`}
                      aria-hidden="true"
                    />
                    Sub-tasks
                    {subtasks.length > 0 && (
                      <span className="normal-case tracking-normal text-on-surface-muted">
                        {completedSubtaskCount}/{subtasks.length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="Focus new subtask field"
                    onClick={() => {
                      setSubtasksExpanded(true);
                      requestAnimationFrame(() => {
                        document.getElementById("new-subtask-title")?.focus();
                      });
                    }}
                    className="rounded p-1 text-on-surface-muted transition-colors hover:bg-accent-action/10 hover:text-accent-foreground-hover"
                    title="Add sub-task"
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {subtasks.length > 0 && (
                  <div className="mx-2 mt-1.5 mb-2 h-1 overflow-hidden rounded-full bg-surface-tertiary">
                    <div
                      className="h-full rounded-full bg-accent-action transition-all duration-300"
                      style={{ width: `${subtaskProgress}%` }}
                    />
                  </div>
                )}
                {subtasksExpanded && (
                  <div className="mt-1">
                    {subtasks.map((sub) => (
                      <div key={sub.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                        <span
                          className={`h-4 w-4 flex-shrink-0 rounded-full border-2 ${
                            sub.status === "completed"
                              ? "border-success bg-success"
                              : "border-accent-action"
                          }`}
                          aria-hidden="true"
                        />
                        {onOpenFullPage ? (
                          <button
                            type="button"
                            onClick={() => onOpenFullPage(sub.id)}
                            className={`min-w-0 flex-1 truncate text-left hover:underline ${
                              sub.status === "completed"
                                ? "text-on-surface-muted line-through"
                                : "text-on-surface"
                            }`}
                          >
                            {sub.title}
                          </button>
                        ) : (
                          <span
                            className={
                              sub.status === "completed"
                                ? "text-on-surface-muted line-through"
                                : "text-on-surface"
                            }
                          >
                            {sub.title}
                          </span>
                        )}
                      </div>
                    ))}
                    <div className="mt-1 flex items-center gap-2 px-2 py-1.5">
                      <div className="h-4 w-4 flex-shrink-0 rounded-full border-2 border-dashed border-on-surface-muted/40" />
                      <label htmlFor="new-subtask-title" className="sr-only">
                        New subtask name
                      </label>
                      <input
                        id="new-subtask-title"
                        type="text"
                        value={subtaskTitle}
                        onChange={(e) => setSubtaskTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleAddSubtask();
                          }
                        }}
                        placeholder="Add a sub-task..."
                        disabled={pending}
                        aria-label="New subtask name"
                        className="flex-1 border-none bg-transparent text-sm text-on-surface outline-none placeholder-on-surface-muted"
                      />
                      <button
                        type="button"
                        onClick={() => void handleAddSubtask()}
                        disabled={pending || !subtaskTitle.trim()}
                        aria-label="Add subtask"
                        className="rounded-md p-1 text-on-surface-muted hover:text-accent-foreground disabled:opacity-50"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Hierarchy — parent only (subtasks above) */}
              <div className={parent ? "px-2" : "sr-only"}>
                <span className="text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                  Parent
                </span>
                {parent ? (
                  <div className="mt-1 flex items-center gap-2 text-sm">
                    {onOpenFullPage ? (
                      <button
                        type="button"
                        onClick={() => onOpenFullPage(parent.id)}
                        className="min-w-0 flex-1 truncate text-left text-accent-foreground hover:underline"
                      >
                        {parent.title}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-on-surface">
                        {parent.title}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleSetParent(null)}
                      disabled={pending}
                      className="text-xs text-on-surface-muted hover:text-error"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-on-surface-muted">No parent</p>
                )}
                {!showParentSearch ? (
                  <button
                    type="button"
                    onClick={() => setShowParentSearch(true)}
                    disabled={pending}
                    className="mt-1 flex items-center gap-1 text-xs text-on-surface-muted hover:text-accent-foreground"
                  >
                    <Search size={12} aria-hidden="true" />
                    {parent ? "Change parent" : "Set parent"}
                  </button>
                ) : (
                  <div className="mt-2">
                    <label htmlFor="parent-search" className="sr-only">
                      Search tasks for parent
                    </label>
                    <input
                      id="parent-search"
                      type="search"
                      value={parentSearch}
                      onChange={(e) => setParentSearch(e.target.value)}
                      placeholder="Search tasks…"
                      disabled={pending}
                      autoFocus
                      className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-focus"
                    />
                    {parentSearching && (
                      <p className="mt-1 text-xs text-on-surface-muted" role="status">
                        Searching…
                      </p>
                    )}
                    {parentResults.length > 0 && (
                      <ul
                        role="listbox"
                        aria-label="Parent candidates"
                        className="mt-1 max-h-32 overflow-y-auto rounded-md border border-border bg-surface"
                      >
                        {parentResults.map((candidate) => (
                          <li key={candidate.id}>
                            <button
                              type="button"
                              role="option"
                              disabled={pending}
                              onClick={() => void handleSetParent(candidate.id)}
                              className="w-full truncate px-3 py-1.5 text-left text-sm text-on-surface hover:bg-surface-secondary"
                            >
                              {candidate.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setShowParentSearch(false);
                        setParentSearch("");
                        setParentResults([]);
                      }}
                      className="mt-1 text-xs text-on-surface-muted hover:text-on-surface"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>

              {/* Relations */}
              <div>
                <div className="mb-1 flex items-center gap-1.5 px-2">
                  <Link size={12} className="text-on-surface-muted" aria-hidden="true" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-on-surface-muted">
                    Relations
                  </span>
                </div>

                {blocks.length > 0 && (
                  <div className="mb-2 px-2">
                    <span className="text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                      Blocks
                    </span>
                    <ul className="mt-1 space-y-1">
                      {blocks.map((rel) => (
                        <li
                          key={`${rel.from_task_id}-${rel.to_task_id}`}
                          className="group flex items-center justify-between rounded px-2 py-1 hover:bg-surface-secondary"
                        >
                          {onOpenFullPage ? (
                            <button
                              type="button"
                              onClick={() => onOpenFullPage(rel.to_task_id)}
                              className="min-w-0 flex-1 truncate text-left text-sm text-on-surface hover:text-accent-foreground"
                            >
                              {titleOf(rel.to_task_id)}
                            </button>
                          ) : (
                            <span className="min-w-0 flex-1 truncate text-sm text-on-surface">
                              {titleOf(rel.to_task_id)}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleRemoveRelation(rel)}
                            disabled={pending}
                            aria-label={`Remove blocks relation to ${titleOf(rel.to_task_id)}`}
                            className="flex h-6 w-6 items-center justify-center rounded text-on-surface-muted hover:text-error"
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {blockedBy.length > 0 && (
                  <div className="mb-2 px-2">
                    <span className="text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                      Blocked by
                    </span>
                    <ul className="mt-1 space-y-1">
                      {blockedBy.map((rel) => (
                        <li
                          key={`${rel.from_task_id}-${rel.to_task_id}`}
                          className="group flex items-center justify-between rounded px-2 py-1 hover:bg-surface-secondary"
                        >
                          {onOpenFullPage ? (
                            <button
                              type="button"
                              onClick={() => onOpenFullPage(rel.from_task_id)}
                              className="min-w-0 flex-1 truncate text-left text-sm text-on-surface hover:text-accent-foreground"
                            >
                              {titleOf(rel.from_task_id)}
                            </button>
                          ) : (
                            <span className="min-w-0 flex-1 truncate text-sm text-on-surface">
                              {titleOf(rel.from_task_id)}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleRemoveRelation(rel)}
                            disabled={pending}
                            aria-label={`Remove blocked-by relation from ${titleOf(rel.from_task_id)}`}
                            className="flex h-6 w-6 items-center justify-center rounded text-on-surface-muted hover:text-error"
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {blocks.length === 0 && blockedBy.length === 0 && !showRelSearch && (
                  <p className="px-2 text-xs text-on-surface-muted">No relations.</p>
                )}

                {showRelSearch ? (
                  <div className="mt-2 space-y-2 px-2">
                    <div className="flex gap-2" role="group" aria-label="Relation kind">
                      <button
                        type="button"
                        onClick={() => setRelKind("blocks")}
                        className={`rounded-md px-2 py-1 text-xs ${
                          relKind === "blocks"
                            ? "bg-accent-action/15 text-accent-foreground"
                            : "text-on-surface-muted hover:bg-surface-secondary"
                        }`}
                      >
                        Blocks
                      </button>
                      <button
                        type="button"
                        onClick={() => setRelKind("blocked_by")}
                        className={`rounded-md px-2 py-1 text-xs ${
                          relKind === "blocked_by"
                            ? "bg-accent-action/15 text-accent-foreground"
                            : "text-on-surface-muted hover:bg-surface-secondary"
                        }`}
                      >
                        Blocked by
                      </button>
                    </div>
                    <label htmlFor="relation-search" className="sr-only">
                      Search tasks to link
                    </label>
                    <input
                      id="relation-search"
                      type="search"
                      value={relSearch}
                      onChange={(e) => setRelSearch(e.target.value)}
                      placeholder="Search tasks to link…"
                      disabled={pending}
                      autoFocus
                      className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-focus"
                    />
                    {relSearching && (
                      <p className="text-xs text-on-surface-muted" role="status">
                        Searching…
                      </p>
                    )}
                    {relResults.length > 0 && (
                      <ul
                        role="listbox"
                        aria-label="Relation candidates"
                        className="max-h-32 overflow-y-auto rounded-md border border-border bg-surface"
                      >
                        {relResults.map((candidate) => (
                          <li key={candidate.id}>
                            <button
                              type="button"
                              role="option"
                              disabled={pending}
                              onClick={() => void handleAddRelation(candidate.id)}
                              className="w-full truncate px-3 py-1.5 text-left text-sm text-on-surface hover:bg-surface-secondary"
                            >
                              {relKind === "blocks" ? "Blocks" : "Blocked by"}: {candidate.title}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setShowRelSearch(false);
                        setRelSearch("");
                        setRelResults([]);
                      }}
                      className="text-xs text-on-surface-muted hover:text-on-surface"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowRelSearch(true)}
                    disabled={pending}
                    className="mt-2 flex items-center gap-1.5 px-2 text-xs text-on-surface-muted hover:text-accent-foreground"
                  >
                    <Link size={12} aria-hidden="true" />
                    Add relation
                  </button>
                )}
              </div>

              {resourceError && (
                <p role="alert" className="px-2 text-xs text-error">
                  {resourceError}
                </p>
              )}

              {/* Comments & Activity */}
              <div className="border-t border-border pt-4">
                <div
                  className="mb-3 flex min-w-0 flex-wrap gap-x-4 gap-y-1 border-b border-border"
                  role="tablist"
                >
                  <button
                    type="button"
                    onClick={() => setActiveTab("comments")}
                    aria-selected={activeTab === "comments"}
                    role="tab"
                    className={`flex items-center gap-1.5 pb-2 text-sm font-medium transition-colors ${
                      activeTab === "comments"
                        ? "border-b-2 border-accent-action text-on-surface"
                        : "text-on-surface-muted hover:text-on-surface"
                    }`}
                  >
                    <MessageSquare size={14} aria-hidden="true" />
                    Comments
                    {comments.length > 0 && (
                      <span className="ml-0.5 text-xs text-on-surface-muted">
                        ({comments.length})
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTab("activity");
                      void reloadActivity();
                    }}
                    aria-selected={activeTab === "activity"}
                    role="tab"
                    className={`flex items-center gap-1.5 pb-2 text-sm font-medium transition-colors ${
                      activeTab === "activity"
                        ? "border-b-2 border-accent-action text-on-surface"
                        : "text-on-surface-muted hover:text-on-surface"
                    }`}
                  >
                    <History size={14} aria-hidden="true" />
                    Activity
                  </button>
                </div>

                {activeTab === "comments" ? (
                  <div>
                    {commentsLoading === "loading" ? (
                      <p className="text-sm text-on-surface-muted" role="status">
                        Loading comments…
                      </p>
                    ) : comments.length === 0 ? (
                      <p className="text-sm text-on-surface-muted">No comments yet.</p>
                    ) : (
                      <div className="mb-3 space-y-2">
                        {comments.map((comment) => (
                          <CommentRow
                            key={comment.id}
                            comment={comment}
                            onReload={reloadCommentsAndActivity}
                          />
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newComment}
                        onChange={(e) => setNewComment(e.target.value)}
                        placeholder="Add a comment…"
                        disabled={pending}
                        className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-focus"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleAddComment();
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => void handleAddComment()}
                        disabled={pending || !newComment.trim()}
                        aria-label="Add comment"
                        className="rounded-md bg-accent-action px-3 py-2 text-sm text-on-accent-action disabled:opacity-50"
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    {activity.length === 0 ? (
                      <p className="text-sm text-on-surface-muted">No activity yet.</p>
                    ) : (
                      <div className="space-y-1">
                        {activity.map((entry) => (
                          <ActivityRow key={`${entry.revision}-${entry.sequence}`} entry={entry} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {stale && (
                <div
                  role="status"
                  className="flex items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-on-warning"
                >
                  <span>This task changed elsewhere. Your unsaved edits are preserved.</span>
                  <button
                    type="button"
                    onClick={handleReloadCommitted}
                    className="shrink-0 rounded-md border border-warning/40 px-2 py-1 font-medium hover:bg-warning/15"
                  >
                    Reload
                  </button>
                </div>
              )}

              <TaskMutationFeedback
                state={
                  mutationPhase === "outcome-unknown"
                    ? "outcome-unknown"
                    : mutationPhase === "error"
                      ? "error"
                      : error
                        ? "error"
                        : "idle"
                }
                message={mutationError ?? error}
              />
              {error && (
                <p role="alert" className="text-xs text-error">
                  {error}
                </p>
              )}

              {/* Keep the legacy clean reading surface; reveal the explicit commit only when edited. */}
              <div
                className={
                  draftDirty
                    ? "sticky bottom-0 mt-auto border-t border-border/60 bg-surface/95 pt-3 pb-1 backdrop-blur-sm"
                    : "sr-only"
                }
              >
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={pending}
                  className="w-full rounded-lg bg-accent-action px-4 py-2.5 text-sm font-medium text-on-accent-action transition-colors hover:bg-accent-action-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Save changes
                </button>
              </div>
            </div>

            {/* Right metadata sidebar */}
            <aside className="scrollbar-panel w-full flex-shrink-0 overflow-visible border-t border-border bg-surface-secondary/35 p-3 min-[240px]:p-4 md:w-80 md:overflow-auto md:border-t-0 md:border-l md:bg-[linear-gradient(180deg,color-mix(in_oklab,var(--color-surface-secondary)_84%,transparent),transparent_22%)] md:p-5">
              <div className="flex flex-col gap-3">
                {/* Due date + Deadline */}
                <div className="order-1 rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
                  <div className="space-y-4">
                    <div className="relative">
                      <label
                        htmlFor="task-due-date"
                        className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted"
                      >
                        <Calendar size={12} aria-hidden="true" /> Date
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id="task-due-date"
                          type="date"
                          value={draft.due_date}
                          onChange={(e) => updateDraft("due_date", e.target.value)}
                          disabled={pending}
                          className="w-full rounded-xl border border-border/70 bg-surface-secondary/65 px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-focus"
                        />
                        {draft.due_date && (
                          <button
                            type="button"
                            onClick={() => updateDraft("due_date", "")}
                            disabled={pending}
                            aria-label="Clear due date"
                            className="p-0.5 text-on-surface-muted transition-colors hover:text-on-surface"
                            title="Clear date"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                      {committed.due_date && (
                        <p
                          className={`mt-1 text-xs ${
                            isOverdue ? "font-medium text-error" : "text-on-surface-muted"
                          }`}
                        >
                          {formatRelativeDate(committed.due_date)}
                        </p>
                      )}
                    </div>

                    <div className="relative">
                      <label
                        htmlFor="task-deadline"
                        className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted"
                      >
                        <AlertTriangle size={12} aria-hidden="true" /> Deadline
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id="task-deadline"
                          type="datetime-local"
                          value={draft.deadline}
                          onChange={(e) => updateDraft("deadline", e.target.value)}
                          disabled={pending}
                          aria-label="Deadline"
                          className={
                            draft.deadline
                              ? "w-full rounded-xl border border-border/70 bg-surface-secondary/65 px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-focus"
                              : "absolute inset-0 h-full w-full cursor-pointer opacity-0"
                          }
                        />
                        {draft.deadline && (
                          <button
                            type="button"
                            onClick={() => updateDraft("deadline", "")}
                            disabled={pending}
                            aria-label="Clear deadline"
                            className="p-0.5 text-on-surface-muted transition-colors hover:text-on-surface"
                            title="Clear deadline"
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                      {!draft.deadline && (
                        <p className="px-2 text-sm text-on-surface-muted">No deadline</p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Priority */}
                <div className="order-2 rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
                  <span className="mb-2 block text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                    Priority
                  </span>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Priority">
                    {PRIORITIES.map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        disabled={pending}
                        aria-pressed={draft.priority === p.value}
                        aria-label={`Priority ${p.label}`}
                        onClick={() =>
                          updateDraft("priority", draft.priority === p.value ? null : p.value)
                        }
                        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                          draft.priority === p.value
                            ? p.activeClass
                            : "bg-surface-tertiary text-on-surface-muted hover:text-on-surface-secondary"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Less-frequent task organization controls remain available below temporal fields. */}
                <div className="order-7 rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
                  <div className="space-y-4">
                    <div>
                      <span className="mb-2 block text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                        Status
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {committed.status === "pending" && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleToggleComplete()}
                              disabled={pending}
                              aria-label={`Complete task: ${committed.title}`}
                              className="rounded-md bg-success/10 px-3 py-1.5 text-xs text-success hover:bg-success/20"
                            >
                              Complete
                            </button>
                            <button
                              type="button"
                              onClick={() => void cancelTask(committed.id)}
                              disabled={pending}
                              className="rounded-md bg-error/10 px-3 py-1.5 text-xs text-error hover:bg-error/20"
                            >
                              Cancel
                            </button>
                          </>
                        )}
                        {committed.status === "completed" && (
                          <button
                            type="button"
                            onClick={() => void uncompleteTask(committed.id)}
                            disabled={pending}
                            aria-label={`Mark task incomplete: ${committed.title}`}
                            className="rounded-md bg-surface-tertiary px-3 py-1.5 text-xs text-on-surface-secondary hover:bg-border"
                          >
                            Reopen
                          </button>
                        )}
                        {committed.status === "cancelled" && (
                          <button
                            type="button"
                            onClick={() => void reopenTask(committed.id)}
                            disabled={pending}
                            className="rounded-md bg-surface-tertiary px-3 py-1.5 text-xs text-on-surface-secondary hover:bg-border"
                          >
                            Restore
                          </button>
                        )}
                        <span className="rounded-full border border-border/60 bg-surface-secondary px-2.5 py-1 text-[11px] font-medium capitalize text-on-surface-secondary">
                          {committed.status}
                        </span>
                      </div>
                    </div>

                    <div>
                      <label className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                        <input
                          type="checkbox"
                          checked={draft.someday}
                          onChange={(e) => updateDraft("someday", e.target.checked)}
                          disabled={pending}
                          className="h-4 w-4 rounded border-border"
                        />
                        <span className="normal-case tracking-normal text-sm font-normal text-on-surface">
                          Someday / Maybe
                        </span>
                      </label>
                    </div>

                    <div>
                      <label
                        htmlFor="task-dread"
                        className="mb-2 block text-xs font-medium uppercase tracking-wider text-on-surface-muted"
                      >
                        Dread
                      </label>
                      <select
                        id="task-dread"
                        value={draft.dread ?? ""}
                        onChange={(e) =>
                          updateDraft(
                            "dread",
                            e.target.value ? Number.parseInt(e.target.value, 10) : null,
                          )
                        }
                        disabled={pending}
                        aria-label="Dread"
                        className="w-full rounded-xl border border-border/70 bg-surface-secondary/65 px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-focus"
                      >
                        <option value="">None</option>
                        <option value="1">1 — Low</option>
                        <option value="2">2</option>
                        <option value="3">3 — Medium</option>
                        <option value="4">4</option>
                        <option value="5">5 — High</option>
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="task-project"
                        className="mb-2 block text-xs font-medium uppercase tracking-wider text-on-surface-muted"
                      >
                        Project
                      </label>
                      <select
                        id="task-project"
                        value={draft.project_id}
                        onChange={(e) => {
                          updateDraft("project_id", e.target.value);
                          updateDraft("section_id", "");
                        }}
                        disabled={pending}
                        aria-label="Project"
                        className="w-full rounded-xl border border-border/70 bg-surface-secondary/65 px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-focus"
                      >
                        <option value="">Inbox (no project)</option>
                        {(catalog?.projects ?? []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {draft.project_id && (
                      <div>
                        <label
                          htmlFor="task-section"
                          className="mb-2 block text-xs font-medium uppercase tracking-wider text-on-surface-muted"
                        >
                          Section
                        </label>
                        <select
                          id="task-section"
                          value={draft.section_id}
                          onChange={(e) => updateDraft("section_id", e.target.value)}
                          disabled={pending}
                          aria-label="Section"
                          className="w-full rounded-xl border border-border/70 bg-surface-secondary/65 px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-focus"
                        >
                          <option value="">No section</option>
                          {sectionsForProject.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                </div>

                {/* Labels */}
                <div className="order-3 min-h-[118px] rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
                  <label className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                    <TagIcon size={12} aria-hidden="true" /> Labels
                  </label>
                  <div className="flex min-h-14 flex-wrap content-start gap-1.5 rounded-md border border-border bg-surface-secondary/50 p-2">
                    {taskTags.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() =>
                          updateDraft(
                            "tag_ids",
                            draft.tag_ids.filter((id) => id !== tag.id),
                          )
                        }
                        aria-label={`Remove label ${tag.name}`}
                        className="inline-flex h-7 items-center gap-1 rounded-full border border-accent-action px-2 text-xs font-medium text-on-surface-secondary"
                      >
                        <span
                          aria-hidden="true"
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: tag.color || "#64748b" }}
                        />
                        {tag.name}
                        <X size={10} aria-hidden="true" />
                      </button>
                    ))}
                    <TagSelector
                      catalogTags={catalog?.tags ?? []}
                      selectedTagIds={draft.tag_ids}
                      onAdd={(tagId) => updateDraft("tag_ids", [...draft.tag_ids, tagId])}
                    />
                  </div>
                </div>

                {/* Reminder */}
                <div className="order-4 rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
                  <div className="relative">
                    <label className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                      <Bell size={12} aria-hidden="true" /> Reminder
                    </label>
                    <button
                      type="button"
                      onClick={() => setEditingReminder((prev) => !prev)}
                      aria-label={committed.remind_at ? "Edit reminder" : "Set reminder"}
                      aria-expanded={editingReminder}
                      className="w-full rounded-xl px-2 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-tertiary"
                    >
                      {committed.remind_at ? (
                        new Date(committed.remind_at).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })
                      ) : (
                        <span className="text-on-surface-muted">No reminder</span>
                      )}
                    </button>
                    {committed.remind_at && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => void handleClearReminder()}
                        aria-label="Clear reminder"
                        className="absolute top-0 right-0 p-0.5 text-on-surface-muted transition-colors hover:text-on-surface"
                        title="Clear reminder"
                      >
                        <X size={12} />
                      </button>
                    )}
                    {editingReminder && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          type="datetime-local"
                          value={reminderInput}
                          onChange={(e) => setReminderInput(e.target.value)}
                          disabled={pending}
                          aria-label={
                            committed.remind_at ? "Edit reminder time" : "Set reminder time"
                          }
                          className="min-w-0 flex-1 rounded-xl border border-border/70 bg-surface-secondary/65 px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-focus"
                        />
                        <button
                          type="button"
                          disabled={pending || !reminderInput.trim()}
                          onClick={() => void handleSaveReminder()}
                          className="rounded-md bg-accent-action/10 px-2 py-1.5 text-xs font-medium text-accent-foreground hover:bg-accent-action/20 disabled:opacity-50"
                        >
                          Schedule
                        </button>
                        {committed.remind_at && (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => void handleSnoozeReminder(60)}
                            className="rounded-md px-2 py-1.5 text-xs text-on-surface-muted hover:bg-surface-tertiary"
                          >
                            Snooze 1h
                          </button>
                        )}
                      </div>
                    )}
                    {editingReminder && reminderOccurrences.length > 0 && (
                      <ul className="mt-2 space-y-1" aria-label="Reminder history">
                        {reminderOccurrences.slice(0, 5).map((row) => (
                          <li
                            key={`${row.remind_at}-${row.state}`}
                            className="text-[11px] text-on-surface-muted"
                          >
                            {new Date(row.remind_at).toLocaleString()} · {row.state}
                          </li>
                        ))}
                      </ul>
                    )}
                    {reminderError && (
                      <p role="alert" className="mt-1 text-xs text-error">
                        {reminderError}
                      </p>
                    )}
                  </div>
                </div>

                {/* Recurrence */}
                <div className="order-4 rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
                  <div className="relative">
                    <label className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted">
                      <Repeat size={12} aria-hidden="true" /> Recurrence
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowRecurrencePicker((prev) => !prev)}
                      aria-label="Recurrence"
                      className="w-full rounded-xl px-2 py-2 text-left text-sm text-on-surface transition-colors hover:bg-surface-tertiary"
                    >
                      {draft.recurrence_rule ? (
                        formatRecurrenceLabel(draft.recurrence_rule)
                      ) : (
                        <span className="text-on-surface-muted">No repeat</span>
                      )}
                    </button>
                    {draft.recurrence_rule && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => updateDraft("recurrence_rule", "")}
                        aria-label="Clear recurrence"
                        className="absolute top-0 right-0 p-0.5 text-on-surface-muted transition-colors hover:text-on-surface"
                        title="Clear recurrence"
                      >
                        <X size={12} />
                      </button>
                    )}
                    {showRecurrencePicker && (
                      <RecurrencePicker
                        value={draft.recurrence_rule || null}
                        pending={pending}
                        onChange={(value) => {
                          updateDraft("recurrence_rule", value ?? "");
                        }}
                        onClose={() => setShowRecurrencePicker(false)}
                      />
                    )}
                  </div>
                </div>

                {/* Estimated time */}
                <div className="order-5 min-h-32 rounded-2xl border border-border/70 bg-surface/72 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
                  <div className="space-y-4">
                    <div>
                      <label
                        htmlFor="task-estimated-minutes"
                        className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted"
                      >
                        <Clock size={12} aria-hidden="true" /> Estimated time
                      </label>
                      <input
                        id="task-estimated-minutes"
                        type="number"
                        min={1}
                        value={draft.estimated_minutes}
                        onChange={(e) => updateDraft("estimated_minutes", e.target.value)}
                        disabled={pending}
                        aria-label="Estimated minutes"
                        placeholder="Minutes"
                        className="w-full rounded-xl border border-border/70 bg-surface-secondary/65 px-3 py-2.5 text-sm text-on-surface placeholder-on-surface-muted/50 [appearance:textfield] focus:outline-none focus:ring-1 focus:ring-focus [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                      {estimatedLabel && (
                        <span className="mt-1 block text-xs text-on-surface-muted">
                          {estimatedLabel}
                        </span>
                      )}
                    </div>
                    {isCompleted && (
                      <div>
                        <label
                          htmlFor="task-actual-minutes"
                          className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-on-surface-muted"
                        >
                          <Clock size={12} aria-hidden="true" /> Actual time (minutes)
                        </label>
                        <input
                          id="task-actual-minutes"
                          type="number"
                          min={0}
                          value={draft.actual_minutes}
                          onChange={(e) => updateDraft("actual_minutes", e.target.value)}
                          disabled={pending}
                          aria-label="Actual minutes"
                          className="w-full rounded-xl border border-border/70 bg-surface-secondary/65 px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:ring-1 focus:ring-focus"
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* Delete */}
                <div className="order-6 rounded-2xl border border-error/20 bg-error/5 px-4 py-3 shadow-[0_8px_24px_-22px_rgba(0,0,0,0.4)]">
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    disabled={pending}
                    aria-label="Delete task"
                    className="flex w-full items-center gap-2 rounded-xl px-1 py-1 text-sm text-error transition-colors hover:text-error/80 disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                    Delete task
                  </button>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete task?"
        message={`Delete "${committed.title}"? This removes the task and can be undone from the toast while the session retains the operation.`}
        confirmLabel="Delete task"
        cancelLabel="Cancel"
        pending={pending}
        onConfirm={() => void handleDeleteConfirmed()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

function TagSelector({
  catalogTags,
  selectedTagIds,
  onAdd,
}: {
  catalogTags: TagDto[];
  selectedTagIds: string[];
  onAdd: (tagId: string) => void;
}) {
  const available = catalogTags.filter((t) => !selectedTagIds.includes(t.id));
  if (available.length === 0) return null;
  return (
    <select
      onChange={(e) => {
        if (e.target.value) onAdd(e.target.value);
        e.target.value = "";
      }}
      aria-label="Add label"
      defaultValue=""
      className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-on-surface-secondary opacity-0 transition-opacity hover:opacity-100 focus:opacity-100"
    >
      <option value="" disabled>
        + Add label
      </option>
      {available.map((tag) => (
        <option key={tag.id} value={tag.id}>
          {tag.name}
        </option>
      ))}
    </select>
  );
}

function CommentRow({ comment, onReload }: { comment: CommentDto; onReload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(comment.content);

  return (
    <div className="rounded-md border border-border/50 p-2">
      {editing ? (
        <div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            className="w-full rounded border border-border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-focus"
          />
          <div className="mt-1 flex gap-1">
            <button
              type="button"
              onClick={async () => {
                await patchCommentApi(
                  comment.id,
                  { content: content.trim() },
                  generateOperationId(),
                );
                setEditing(false);
                void onReload();
              }}
              className="rounded bg-accent-action px-2 py-0.5 text-xs text-on-accent-action"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setContent(comment.content);
                setEditing(false);
              }}
              className="rounded border border-border px-2 py-0.5 text-xs text-on-surface-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          <p className="whitespace-pre-wrap text-sm text-on-surface">{comment.content}</p>
          <div className="mt-1 flex items-center gap-2 text-xs text-on-surface-muted">
            <span>{new Date(comment.created_at).toLocaleString()}</span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-on-surface-muted hover:text-on-surface"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={async () => {
                await deleteCommentApi(comment.id, generateOperationId());
                void onReload();
              }}
              className="text-on-surface-muted hover:text-error"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityRow({ entry }: { entry: TaskActivityDto }) {
  return (
    <div className="border-b border-border/20 py-1 text-xs text-on-surface-muted">
      <span className="font-medium text-on-surface-secondary">{entry.action}</span>
      {entry.field && <span> · {entry.field}</span>}
      {entry.old_value && (
        <span>
          : {entry.old_value} → {entry.new_value}
        </span>
      )}
      <span className="ml-2">{new Date(entry.created_at).toLocaleString()}</span>
    </div>
  );
}
