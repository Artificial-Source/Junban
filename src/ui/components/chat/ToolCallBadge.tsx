import { memo } from "react";

export const TOOL_META: Record<string, { emoji: string; verb: string }> = {
  create_task: { emoji: "\u2728", verb: "Creating" },
  complete_task: { emoji: "\u2705", verb: "Completing" },
  update_task: { emoji: "\u270f\ufe0f", verb: "Updating" },
  delete_task: { emoji: "\ud83d\uddd1\ufe0f", verb: "Deleting" },
  list_tasks: { emoji: "\ud83d\udccb", verb: "Checking tasks" },
  query_tasks: { emoji: "\ud83d\udd0d", verb: "Searching tasks" },
  list_tags: { emoji: "\ud83c\udff7\ufe0f", verb: "Listing tags" },
  add_tags_to_task: { emoji: "\ud83c\udff7\ufe0f", verb: "Adding tags" },
  remove_tags_from_task: { emoji: "\ud83c\udff7\ufe0f", verb: "Removing tags" },
  create_project: { emoji: "\ud83d\udcc1", verb: "Creating project" },
  update_project: { emoji: "\ud83d\udcc1", verb: "Updating project" },
  delete_project: { emoji: "\ud83d\udcc1", verb: "Deleting project" },
  list_projects: { emoji: "\ud83d\udcc2", verb: "Listing projects" },
  get_project: { emoji: "\ud83d\udcc2", verb: "Getting project" },
  list_reminders: { emoji: "\u23f0", verb: "Listing reminders" },
  set_reminder: { emoji: "\u23f0", verb: "Setting reminder" },
  snooze_reminder: { emoji: "\ud83d\udca4", verb: "Snoozing reminder" },
  dismiss_reminder: { emoji: "\u274c", verb: "Dismissing reminder" },
  analyze_completion_patterns: { emoji: "\ud83d\udcca", verb: "Analyzing patterns" },
  analyze_workload: { emoji: "\ud83d\udcca", verb: "Analyzing workload" },
  check_overcommitment: { emoji: "\u26a0\ufe0f", verb: "Checking load" },
  suggest_tags: { emoji: "\ud83c\udff7\ufe0f", verb: "Suggesting tags" },
  find_similar_tasks: { emoji: "\ud83d\udd0d", verb: "Finding similar" },
  check_duplicates: { emoji: "\ud83d\udd0d", verb: "Checking duplicates" },
  get_energy_recommendations: { emoji: "\u26a1", verb: "Getting recommendations" },
  break_down_task: { emoji: "\ud83e\udde9", verb: "Breaking down" },
  smart_organize: { emoji: "\ud83e\udde0", verb: "Organizing" },
};

export const ToolCallBadge = memo(function ToolCallBadge({
  name,
  args,
}: {
  name: string;
  args: string;
}) {
  const meta = TOOL_META[name] ?? { emoji: "\u26a1", verb: name.replace(/_/g, " ") };
  let label = meta.verb;
  try {
    const parsed = JSON.parse(args);
    if (parsed.title) label = `${meta.verb} "${parsed.title}"`;
    else if (parsed.search) label = `Searching "${parsed.search}"`;
    else if (parsed.status) label = `${meta.verb} (${parsed.status})`;
  } catch {
    // Use default label
  }

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs bg-accent/10 text-accent rounded-full">
      <span>{meta.emoji}</span>
      {label}
    </span>
  );
});
