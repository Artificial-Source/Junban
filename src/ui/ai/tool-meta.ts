/**
 * Wave 3 local AI tool names and badge presentation metadata.
 * Display only — does not invent authority beyond the server registry.
 */

import {
  AlertTriangle,
  BarChart3,
  Bell,
  BellOff,
  Brain,
  CalendarClock,
  CheckCircle2,
  Clock,
  FolderOpen,
  FolderPlus,
  ListChecks,
  ListPlus,
  ListRestart,
  Moon,
  Pencil,
  Puzzle,
  Search,
  Sparkles,
  Sun,
  Sunset,
  Tag,
  Trash2,
  Zap,
  type LucideIcon,
} from "lucide-react";

/** Canonical Wave 3f.1 tool names (server registry). */
export const AI_TOOL_NAMES = [
  "create_task",
  "update_task",
  "complete_task",
  "delete_task",
  "query_tasks",
  "break_down_task",
  "extract_tasks_from_text",
  "bulk_create_tasks",
  "bulk_complete_tasks",
  "bulk_update_tasks",
  "find_similar_tasks",
  "check_duplicates",
  "create_project",
  "list_projects",
  "get_project",
  "update_project",
  "delete_project",
  "list_tags",
  "add_tags_to_task",
  "remove_tags_from_task",
  "list_reminders",
  "set_reminder",
  "snooze_reminder",
  "dismiss_reminder",
  "analyze_completion_patterns",
  "check_overcommitment",
  "analyze_workload",
  "get_energy_recommendations",
  "get_productivity_stats",
  "estimate_task_duration",
  "time_tracking_summary",
  "suggest_tags",
  "plan_my_day",
  "daily_review",
  "weekly_review",
  "save_memory",
  "recall_memories",
  "forget_memory",
  "auto_schedule_day",
  "apply_auto_schedule_day",
  "reschedule_day",
  "timeblocking_list_blocks",
  "timeblocking_create_block",
  "timeblocking_update_block",
  "timeblocking_delete_block",
  "timeblocking_schedule_task",
  "timeblocking_get_availability",
  "timeblocking_set_recurrence",
  "timeblocking_replan_day",
] as const;

export type AiToolName = (typeof AI_TOOL_NAMES)[number];

export type ToolMeta = {
  icon: LucideIcon;
  /** Progressive badge verb ("Creating", "Searching tasks"). */
  verb: string;
  /**
   * Friendly noun phrase for proposal/result headers.
   * When set, normal UI must not fall back to raw snake_case tool names.
   */
  label?: string;
};

export const TOOL_META: Record<string, ToolMeta> = {
  create_task: { icon: Sparkles, verb: "Creating" },
  complete_task: { icon: CheckCircle2, verb: "Completing" },
  update_task: { icon: Pencil, verb: "Updating" },
  delete_task: { icon: Trash2, verb: "Deleting" },
  query_tasks: { icon: Search, verb: "Searching tasks" },
  break_down_task: { icon: Puzzle, verb: "Breaking down" },
  extract_tasks_from_text: { icon: ListPlus, verb: "Extracting tasks" },
  bulk_create_tasks: { icon: ListPlus, verb: "Creating tasks" },
  bulk_complete_tasks: { icon: ListChecks, verb: "Completing tasks" },
  bulk_update_tasks: { icon: ListRestart, verb: "Updating tasks" },
  find_similar_tasks: { icon: Search, verb: "Finding similar" },
  check_duplicates: { icon: Search, verb: "Checking duplicates" },
  create_project: { icon: FolderPlus, verb: "Creating project" },
  list_projects: { icon: FolderOpen, verb: "Listing projects" },
  get_project: { icon: FolderOpen, verb: "Getting project" },
  update_project: { icon: FolderOpen, verb: "Updating project" },
  delete_project: { icon: Trash2, verb: "Deleting project" },
  list_tags: { icon: Tag, verb: "Listing tags" },
  add_tags_to_task: { icon: Tag, verb: "Adding tags" },
  remove_tags_from_task: { icon: Tag, verb: "Removing tags" },
  list_reminders: { icon: Bell, verb: "Listing reminders" },
  set_reminder: { icon: Bell, verb: "Setting reminder" },
  snooze_reminder: { icon: Moon, verb: "Snoozing reminder" },
  dismiss_reminder: { icon: BellOff, verb: "Dismissing reminder" },
  analyze_completion_patterns: { icon: BarChart3, verb: "Analyzing patterns" },
  check_overcommitment: { icon: AlertTriangle, verb: "Checking load" },
  analyze_workload: { icon: BarChart3, verb: "Analyzing workload" },
  get_energy_recommendations: { icon: Zap, verb: "Getting recommendations" },
  get_productivity_stats: { icon: BarChart3, verb: "Gathering stats" },
  estimate_task_duration: { icon: Clock, verb: "Estimating duration" },
  time_tracking_summary: { icon: Clock, verb: "Summarizing time" },
  suggest_tags: { icon: Tag, verb: "Suggesting tags" },
  plan_my_day: { icon: Sun, verb: "Planning your day" },
  daily_review: { icon: Sunset, verb: "Reviewing your day" },
  weekly_review: { icon: BarChart3, verb: "Reviewing your week" },
  save_memory: { icon: Brain, verb: "Remembering" },
  recall_memories: { icon: Brain, verb: "Recalling memories" },
  forget_memory: { icon: Brain, verb: "Forgetting" },
  auto_schedule_day: { icon: CalendarClock, verb: "Auto-scheduling" },
  apply_auto_schedule_day: {
    icon: CalendarClock,
    verb: "Applying day schedule",
    label: "day schedule",
  },
  reschedule_day: { icon: CalendarClock, verb: "Rescheduling" },
  timeblocking_list_blocks: { icon: CalendarClock, verb: "Listing blocks" },
  timeblocking_create_block: { icon: CalendarClock, verb: "Creating block" },
  timeblocking_update_block: { icon: CalendarClock, verb: "Updating block" },
  timeblocking_delete_block: { icon: CalendarClock, verb: "Deleting block" },
  timeblocking_schedule_task: { icon: CalendarClock, verb: "Scheduling task" },
  timeblocking_get_availability: { icon: CalendarClock, verb: "Checking availability" },
  timeblocking_set_recurrence: { icon: CalendarClock, verb: "Setting recurrence" },
  timeblocking_replan_day: { icon: CalendarClock, verb: "Replanning day" },
};

export function toolMetaFor(name: string): ToolMeta {
  return TOOL_META[name] ?? { icon: Zap, verb: name.replace(/_/g, " ") };
}

/** Friendly header label for proposal/result chrome (never raw snake_case when known). */
export function toolDisplayLabel(name: string): string {
  const meta = toolMetaFor(name);
  if (meta.label && meta.label.trim()) return meta.label.trim();
  return name.replace(/_/g, " ");
}

/** Build a short badge label from tool name + canonical argument object/JSON. */
export function toolBadgeLabel(name: string, args: unknown): string {
  const meta = toolMetaFor(name);
  let label = meta.verb;
  const obj = asRecord(args);
  if (!obj) return label;
  if (typeof obj.title === "string" && obj.title.trim()) {
    label = `${meta.verb} "${obj.title.trim()}"`;
  } else if (typeof obj.search === "string" && obj.search.trim()) {
    label = `Searching "${obj.search.trim()}"`;
  } else if (typeof obj.status === "string" && obj.status.trim()) {
    label = `${meta.verb} (${obj.status.trim()})`;
  } else if (typeof obj.name === "string" && obj.name.trim()) {
    label = `${meta.verb} "${obj.name.trim()}"`;
  } else if (typeof obj.date === "string" && obj.date.trim()) {
    label = `${meta.verb} (${obj.date.trim()})`;
  }
  return label;
}

/** Canonical apply-auto-schedule tool id (approval-required exact blocks). */
export const APPLY_AUTO_SCHEDULE_DAY_TOOL = "apply_auto_schedule_day" as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** Format tool arguments/results as bounded plain structured text. */
export function formatStructuredPlain(value: unknown, maxChars = 4_000): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…`;
}
