/**
 * Phase 3 recurrence labels and presets.
 * Canonical grammar: daily | weekly | monthly | yearly | weekdays | every N day(s)|week(s).
 */

export const RECURRENCE_PRESETS = [
  { label: "None", value: null },
  { label: "Daily", value: "daily" },
  { label: "Weekly", value: "weekly" },
  { label: "Monthly", value: "monthly" },
  { label: "Yearly", value: "yearly" },
  { label: "Weekdays", value: "weekdays" },
] as const;

/** Format a recurrence rule string into a human-readable label. */
export function formatRecurrenceLabel(recurrence: string): string {
  switch (recurrence) {
    case "daily":
      return "Daily";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    case "yearly":
      return "Yearly";
    case "weekdays":
      return "Weekdays";
    default: {
      const match = recurrence.match(/^every\s+(\d+)\s+(day|week)s?$/i);
      if (match) {
        const n = Number.parseInt(match[1]!, 10);
        const unit = match[2]!.toLowerCase();
        if (n === 1) return unit === "day" ? "Daily" : "Weekly";
        return `Every ${n} ${unit}s`;
      }
      return recurrence;
    }
  }
}

/** Build a custom every-N rule string. */
export function everyNRule(n: number, unit: "day" | "week"): string {
  const count = Math.max(1, Math.floor(n));
  if (unit === "day") return count === 1 ? "every 1 day" : `every ${count} days`;
  return count === 1 ? "every 1 week" : `every ${count} weeks`;
}
