/** Format a date string according to user preferences. */
export function formatTaskDate(
  isoDate: string,
  format: "relative" | "short" | "long" | "iso",
): string {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return isoDate;

  switch (format) {
    case "relative":
      return formatRelative(date);
    case "short":
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    case "long":
      return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    case "iso":
      return isoDate.slice(0, 10);
    default:
      return isoDate;
  }
}

/** Format a time string according to user preferences. */
export function formatTaskTime(isoDate: string, timeFormat: "12h" | "24h"): string {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return "";

  if (timeFormat === "24h") {
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatRelative(date: Date): string {
  const now = new Date();
  const todayStr = toDateKey(now);
  const dateStr = toDateKey(date);

  if (dateStr === todayStr) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dateStr === toDateKey(yesterday)) return "Yesterday";

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dateStr === toDateKey(tomorrow)) return "Tomorrow";

  // Within the next 6 days — show weekday name
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays > 1 && diffDays <= 6) {
    return date.toLocaleDateString("en-US", { weekday: "long" });
  }

  // Fallback: short date without year if same year
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
