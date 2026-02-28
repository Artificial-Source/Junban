import { memo } from "react";
import {
  Sparkles,
  CheckCircle2,
  Pencil,
  Trash2,
  ListChecks,
  Search,
  Tag,
  FolderPlus,
  FolderOpen,
  Bell,
  BellOff,
  Moon,
  BarChart3,
  AlertTriangle,
  Zap,
  Puzzle,
  Brain,
  Sun,
  Sunset,
  type LucideIcon,
} from "lucide-react";

export const TOOL_META: Record<string, { icon: LucideIcon; emoji: string; verb: string }> = {
  create_task: { icon: Sparkles, emoji: "\u2728", verb: "Creating" },
  complete_task: { icon: CheckCircle2, emoji: "\u2705", verb: "Completing" },
  update_task: { icon: Pencil, emoji: "\u270f\ufe0f", verb: "Updating" },
  delete_task: { icon: Trash2, emoji: "\ud83d\uddd1\ufe0f", verb: "Deleting" },
  list_tasks: { icon: ListChecks, emoji: "\ud83d\udccb", verb: "Checking tasks" },
  query_tasks: { icon: Search, emoji: "\ud83d\udd0d", verb: "Searching tasks" },
  list_tags: { icon: Tag, emoji: "\ud83c\udff7\ufe0f", verb: "Listing tags" },
  add_tags_to_task: { icon: Tag, emoji: "\ud83c\udff7\ufe0f", verb: "Adding tags" },
  remove_tags_from_task: { icon: Tag, emoji: "\ud83c\udff7\ufe0f", verb: "Removing tags" },
  create_project: { icon: FolderPlus, emoji: "\ud83d\udcc1", verb: "Creating project" },
  update_project: { icon: FolderOpen, emoji: "\ud83d\udcc1", verb: "Updating project" },
  delete_project: { icon: Trash2, emoji: "\ud83d\udcc1", verb: "Deleting project" },
  list_projects: { icon: FolderOpen, emoji: "\ud83d\udcc2", verb: "Listing projects" },
  get_project: { icon: FolderOpen, emoji: "\ud83d\udcc2", verb: "Getting project" },
  list_reminders: { icon: Bell, emoji: "\u23f0", verb: "Listing reminders" },
  set_reminder: { icon: Bell, emoji: "\u23f0", verb: "Setting reminder" },
  snooze_reminder: { icon: Moon, emoji: "\ud83d\udca4", verb: "Snoozing reminder" },
  dismiss_reminder: { icon: BellOff, emoji: "\u274c", verb: "Dismissing reminder" },
  analyze_completion_patterns: {
    icon: BarChart3,
    emoji: "\ud83d\udcca",
    verb: "Analyzing patterns",
  },
  analyze_workload: { icon: BarChart3, emoji: "\ud83d\udcca", verb: "Analyzing workload" },
  check_overcommitment: { icon: AlertTriangle, emoji: "\u26a0\ufe0f", verb: "Checking load" },
  suggest_tags: { icon: Tag, emoji: "\ud83c\udff7\ufe0f", verb: "Suggesting tags" },
  find_similar_tasks: { icon: Search, emoji: "\ud83d\udd0d", verb: "Finding similar" },
  check_duplicates: { icon: Search, emoji: "\ud83d\udd0d", verb: "Checking duplicates" },
  get_energy_recommendations: { icon: Zap, emoji: "\u26a1", verb: "Getting recommendations" },
  break_down_task: { icon: Puzzle, emoji: "\ud83e\udde9", verb: "Breaking down" },
  smart_organize: { icon: Brain, emoji: "\ud83e\udde0", verb: "Organizing" },
  plan_my_day: { icon: Sun, emoji: "\u2600\ufe0f", verb: "Planning your day" },
  daily_review: { icon: Sunset, emoji: "\ud83c\udf05", verb: "Reviewing your day" },
};

export const ToolCallBadge = memo(function ToolCallBadge({
  name,
  args,
  isComplete,
}: {
  name: string;
  args: string;
  isComplete?: boolean;
}) {
  const meta = TOOL_META[name] ?? { icon: Zap, emoji: "\u26a1", verb: name.replace(/_/g, " ") };
  let label = meta.verb;
  try {
    const parsed = JSON.parse(args);
    if (parsed.title) label = `${meta.verb} "${parsed.title}"`;
    else if (parsed.search) label = `Searching "${parsed.search}"`;
    else if (parsed.status) label = `${meta.verb} (${parsed.status})`;
  } catch {
    // Use default label
  }

  const Icon = meta.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border transition-all duration-300 ${
        isComplete
          ? "bg-surface-secondary border-border text-on-surface-secondary"
          : "bg-accent/10 border-accent/30 text-accent"
      }`}
    >
      <Icon size={12} />
      {label}
    </span>
  );
});
