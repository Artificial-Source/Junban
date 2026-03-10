/** Format a duration in minutes to a human-readable string (e.g. "1h 30m"). */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Format the today header string, e.g. "Mar 10 · Today · Monday". */
export function formatTodayHeader(): string {
  const now = new Date();
  const month = now.toLocaleDateString(undefined, { month: "short" });
  const day = now.getDate();
  const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
  return `${month} ${day} · Today · ${weekday}`;
}
