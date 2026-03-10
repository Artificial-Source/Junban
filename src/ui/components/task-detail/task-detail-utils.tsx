import { PlusCircle, CheckCircle2, Pencil, History } from "lucide-react";
import type { TaskActivity } from "../../../core/types.js";

/** Format an ISO timestamp into a short relative string. */
export function formatRelativeTime(isoStr: string): string {
  const now = Date.now();
  const then = new Date(isoStr).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

/** Return an icon element for the given activity action. */
export function getActivityIcon(action: string) {
  switch (action) {
    case "created":
      return <PlusCircle size={12} />;
    case "completed":
      return <CheckCircle2 size={12} />;
    case "updated":
      return <Pencil size={12} />;
    default:
      return <History size={12} />;
  }
}

/** Build a human-readable description for an activity entry. */
export function formatActivityDescription(entry: TaskActivity): string {
  switch (entry.action) {
    case "created":
      return "Task created";
    case "completed":
      return "Task completed";
    case "updated":
      if (entry.field) {
        if (entry.newValue) {
          return `Changed ${entry.field} to "${entry.newValue}"`;
        }
        return `Updated ${entry.field}`;
      }
      return "Task updated";
    default:
      return entry.action.charAt(0).toUpperCase() + entry.action.slice(1);
  }
}
