import { useState, useMemo, useCallback } from "react";
import {
  Pencil,
  Check,
  Undo2,
  Trash2,
  Flag,
  FolderInput,
  Calendar as CalendarIcon,
  Bell,
  ArrowUpRight,
  Copy,
  Link,
  Tag as TagIcon,
  ListPlus,
  Lightbulb,
  XCircle,
  CircleDot,
} from "lucide-react";
import type { ContextMenuItem } from "../components/ContextMenu.js";
import type { Task, UpdateTaskInput, Project as ProjectType } from "../../core/types.js";
import { useGeneralSettings } from "../context/SettingsContext.js";
import type { Section } from "../../core/types.js";

/** Build an ISO reminder string N minutes from now. Called at click time, not render time. */
function reminderFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function useTaskContextMenu({
  tasks,
  projects,
  sections,
  availableTags,
  handleSelectTask,
  handleToggleTask,
  handleUpdateTask,
  handleDeleteTask,
  handleDuplicateTask,
  handleCopyTaskLink,
  handleNavigate,
}: {
  tasks: Task[];
  projects: ProjectType[];
  sections: Section[];
  availableTags: string[];
  handleSelectTask: (id: string) => void;
  handleToggleTask: (id: string) => void;
  handleUpdateTask: (id: string, data: UpdateTaskInput) => void;
  handleDeleteTask: (id: string) => void;
  handleDuplicateTask: (id: string) => void;
  handleCopyTaskLink: (id: string) => void;
  handleNavigate: (view: string, id?: string) => void;
}) {
  const { settings } = useGeneralSettings();
  const [contextMenu, setContextMenu] = useState<{
    taskId: string;
    position: { x: number; y: number };
  } | null>(null);

  const [customDatePicker, setCustomDatePicker] = useState<{
    taskId: string;
    mode: "dueDate" | "reminder";
    position: { x: number; y: number };
  } | null>(null);

  const handleContextMenu = useCallback((taskId: string, position: { x: number; y: number }) => {
    setContextMenu({ taskId, position });
  }, []);

  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenu) return [];
    const task = tasks.find((t) => t.id === contextMenu.taskId);
    if (!task) return [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayISO = today.toISOString();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowISO = tomorrow.toISOString();
    const nextMonday = new Date(today);
    nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
    const nextMondayISO = nextMonday.toISOString();
    const nextSaturday = new Date(today);
    nextSaturday.setDate(nextSaturday.getDate() + ((6 - nextSaturday.getDay() + 7) % 7 || 7));
    const nextSaturdayISO = nextSaturday.toISOString();

    const dayAbbr = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short" });
    const shortDate = (d: Date) =>
      d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

    // ── Due date submenu ──
    const dueDateSubmenu: ContextMenuItem[] = [
      {
        id: "due-today",
        label: "Today",
        shortcut: dayAbbr(today),
        onClick: () => handleUpdateTask(task.id, { dueDate: todayISO, dueTime: false }),
      },
      {
        id: "due-tomorrow",
        label: "Tomorrow",
        shortcut: dayAbbr(tomorrow),
        onClick: () => handleUpdateTask(task.id, { dueDate: tomorrowISO, dueTime: false }),
      },
      {
        id: "due-next-week",
        label: "Next week",
        shortcut: shortDate(nextMonday),
        onClick: () => handleUpdateTask(task.id, { dueDate: nextMondayISO, dueTime: false }),
      },
      {
        id: "due-next-weekend",
        label: "Next weekend",
        shortcut: shortDate(nextSaturday),
        onClick: () => handleUpdateTask(task.id, { dueDate: nextSaturdayISO, dueTime: false }),
      },
    ];
    if (task.dueDate) {
      dueDateSubmenu.push({
        id: "due-none",
        label: "No date",
        onClick: () => handleUpdateTask(task.id, { dueDate: null, dueTime: false }),
      });
    }
    dueDateSubmenu.push({
      id: "due-custom",
      label: "Custom...",
      separator: true,
      onClick: () => {
        setContextMenu(null);
        setCustomDatePicker({ taskId: task.id, mode: "dueDate", position: contextMenu.position });
      },
    });

    // ── Priority submenu ──
    const prioritySubmenu: ContextMenuItem[] = [
      {
        id: "priority-1",
        label: "Priority 1",
        icon: <Flag size={14} className="text-priority-1" />,
        onClick: () => handleUpdateTask(task.id, { priority: 1 }),
      },
      {
        id: "priority-2",
        label: "Priority 2",
        icon: <Flag size={14} className="text-priority-2" />,
        onClick: () => handleUpdateTask(task.id, { priority: 2 }),
      },
      {
        id: "priority-3",
        label: "Priority 3",
        icon: <Flag size={14} className="text-priority-3" />,
        onClick: () => handleUpdateTask(task.id, { priority: 3 }),
      },
      {
        id: "priority-4",
        label: "Priority 4",
        icon: <Flag size={14} className="text-priority-4" />,
        onClick: () => handleUpdateTask(task.id, { priority: 4 }),
      },
    ];
    if (task.priority) {
      prioritySubmenu.push({
        id: "priority-none",
        label: "No priority",
        onClick: () => handleUpdateTask(task.id, { priority: null }),
      });
    }

    // ── Reminder submenu ──
    const tomorrowAt9 = new Date(tomorrow);
    tomorrowAt9.setHours(9, 0, 0, 0);
    const nextMondayAt9 = new Date(nextMonday);
    nextMondayAt9.setHours(9, 0, 0, 0);

    const tomorrowAt9ISO = tomorrowAt9.toISOString();
    const nextMondayAt9ISO = nextMondayAt9.toISOString();

    const reminderSubmenu: ContextMenuItem[] = [
      {
        id: "remind-30min",
        label: "In 30 minutes",
        onClick: () => handleUpdateTask(task.id, { remindAt: reminderFromNow(30) }),
      },
      {
        id: "remind-1hr",
        label: "In 1 hour",
        onClick: () => handleUpdateTask(task.id, { remindAt: reminderFromNow(60) }),
      },
      {
        id: "remind-3hr",
        label: "In 3 hours",
        onClick: () => handleUpdateTask(task.id, { remindAt: reminderFromNow(180) }),
      },
      {
        id: "remind-tomorrow-9am",
        label: "Tomorrow at 9 AM",
        shortcut: shortDate(tomorrowAt9),
        onClick: () => handleUpdateTask(task.id, { remindAt: tomorrowAt9ISO }),
      },
      {
        id: "remind-next-monday-9am",
        label: "Next Monday at 9 AM",
        shortcut: shortDate(nextMondayAt9),
        onClick: () => handleUpdateTask(task.id, { remindAt: nextMondayAt9ISO }),
      },
    ];
    if (task.remindAt) {
      reminderSubmenu.push({
        id: "remind-none",
        label: "No reminder",
        onClick: () => handleUpdateTask(task.id, { remindAt: null }),
      });
    }
    reminderSubmenu.push({
      id: "remind-custom",
      label: "Custom...",
      separator: true,
      onClick: () => {
        setContextMenu(null);
        setCustomDatePicker({ taskId: task.id, mode: "reminder", position: contextMenu.position });
      },
    });

    // ── Labels/Tags submenu ──
    const taskTagNames = task.tags.map((t: { name: string }) => t.name);
    const labelsSubmenu: ContextMenuItem[] =
      availableTags.length > 0
        ? availableTags.map((tag) => {
            const hasTag = taskTagNames.includes(tag);
            return {
              id: `tag-${tag}`,
              label: tag,
              icon: hasTag ? <Check size={14} /> : undefined,
              keepOpen: true,
              onClick: () => {
                const newTags = hasTag
                  ? taskTagNames.filter((t: string) => t !== tag)
                  : [...taskTagNames, tag];
                handleUpdateTask(task.id, { tags: newTags });
              },
            };
          })
        : [{ id: "no-tags", label: "No labels yet", disabled: true }];

    // ── Build items ──
    const items: ContextMenuItem[] = [
      {
        id: "edit",
        label: "Edit",
        icon: <Pencil size={14} />,
        shortcut: "Ctrl+E",
        onClick: () => handleSelectTask(task.id),
      },
      {
        id: "toggle",
        label: task.status === "completed" ? "Mark incomplete" : "Complete",
        icon: task.status === "completed" ? <Undo2 size={14} /> : <Check size={14} />,
        separator: true,
        onClick: () => handleToggleTask(task.id),
      },
      {
        id: "due-date",
        label: "Due date",
        icon: <CalendarIcon size={14} />,
        submenu: dueDateSubmenu,
      },
      {
        id: "priority",
        label: "Priority",
        icon: <Flag size={14} />,
        submenu: prioritySubmenu,
      },
      {
        id: "reminder",
        label: "Reminder",
        icon: <Bell size={14} />,
        submenu: reminderSubmenu,
      },
      {
        id: "labels",
        label: "Labels",
        icon: <TagIcon size={14} />,
        submenu: labelsSubmenu,
        separator: true,
      },
    ];

    // ── Add subtask ──
    items.push({
      id: "add-subtask",
      label: "Add subtask",
      icon: <ListPlus size={14} />,
      onClick: () => handleSelectTask(task.id),
    });

    // ── Move to project submenu ──
    if (projects.length > 0) {
      items.push({
        id: "move",
        label: "Move to...",
        icon: <FolderInput size={14} />,
        submenu: [
          {
            id: "move-inbox",
            label: "Inbox",
            onClick: () => handleUpdateTask(task.id, { projectId: null }),
          },
          ...projects.map((p) => ({
            id: `move-${p.id}`,
            label: p.name,
            onClick: () => handleUpdateTask(task.id, { projectId: p.id }),
          })),
        ],
      });
    }

    if (sections.length > 0 && task.projectId) {
      items.push({
        id: "move-section",
        label: "Move to section...",
        icon: <FolderInput size={14} />,
        submenu: [
          {
            id: "move-section-none",
            label: "No section",
            onClick: () => handleUpdateTask(task.id, { sectionId: null }),
          },
          ...sections.map((section) => ({
            id: `move-section-${section.id}`,
            label: section.name,
            onClick: () => handleUpdateTask(task.id, { sectionId: section.id }),
          })),
        ],
      });
    }

    // ── Go to project ──
    if (task.projectId) {
      items.push({
        id: "go-to-project",
        label: "Go to project",
        icon: <ArrowUpRight size={14} />,
        onClick: () => handleNavigate("project", task.projectId!),
      });
    }

    // ── Move to Someday / Remove from Someday ──
    if (settings.feature_someday === "true") {
      items.push({
        id: "someday",
        label: task.isSomeday ? "Remove from Someday" : "Move to Someday",
        icon: <Lightbulb size={14} />,
        onClick: () => handleUpdateTask(task.id, { isSomeday: !task.isSomeday }),
      });
    }

    // ── Mark as cancelled / Reopen ──
    items.push({
      id: "cancel-reopen",
      label: task.status === "cancelled" ? "Reopen" : "Mark as cancelled",
      icon: task.status === "cancelled" ? <CircleDot size={14} /> : <XCircle size={14} />,
      separator: true,
      onClick: () =>
        handleUpdateTask(task.id, {
          status: task.status === "cancelled" ? "pending" : "cancelled",
        }),
    });

    items.push({
      id: "duplicate",
      label: "Duplicate",
      icon: <Copy size={14} />,
      onClick: () => handleDuplicateTask(task.id),
    });
    items.push({
      id: "copy-link",
      label: "Copy link",
      icon: <Link size={14} />,
      separator: true,
      onClick: () => handleCopyTaskLink(task.id),
    });

    items.push({
      id: "delete",
      label: "Delete",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => handleDeleteTask(task.id),
    });

    return items;
  }, [
    contextMenu,
    tasks,
    projects,
    sections,
    availableTags,
    handleSelectTask,
    handleToggleTask,
    handleUpdateTask,
    handleDeleteTask,
    handleDuplicateTask,
    handleCopyTaskLink,
    handleNavigate,
    settings.feature_someday,
  ]);

  return {
    contextMenu,
    setContextMenu,
    contextMenuItems,
    customDatePicker,
    setCustomDatePicker,
    handleContextMenu,
  };
}
