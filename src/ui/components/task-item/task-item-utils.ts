/** Priority -> row styling: left border + optional background wash */
export const PRIORITY_ROW_STYLES: Record<number, { border: string; bg: string }> = {
  1: { border: "border-l-3 border-l-priority-1", bg: "bg-priority-1/[0.06]" },
  2: { border: "border-l-3 border-l-priority-2", bg: "bg-priority-2/[0.04]" },
  3: { border: "border-l-2 border-l-priority-3", bg: "" },
  4: { border: "", bg: "" },
};

/** Format estimated minutes into a short duration label. */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (Number.isInteger(minutes / 60)) return `${minutes / 60}h`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/** Compute the row-level CSS classes based on selection and priority state. */
export function getRowClassName(
  isMultiSelected: boolean,
  isSelected: boolean,
  status: string,
  priority: number | null,
): string {
  const priorityStyle =
    status !== "completed" && priority && PRIORITY_ROW_STYLES[priority]
      ? PRIORITY_ROW_STYLES[priority]
      : null;

  const bgClass = isMultiSelected
    ? "bg-accent/10 ring-1 ring-accent"
    : isSelected
      ? "bg-accent/5 ring-1 ring-accent/50"
      : priorityStyle
        ? `${priorityStyle.bg} hover:bg-surface-secondary`
        : "hover:bg-surface-secondary";

  const borderClass = priorityStyle ? priorityStyle.border : "";

  return `${bgClass} ${borderClass}`;
}
