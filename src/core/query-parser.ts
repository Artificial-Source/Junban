import * as chrono from "chrono-node";
import type { TaskFilter } from "./filters.js";

export interface ParsedQuery {
  filter: TaskFilter;
  remainingText: string;
}

/**
 * Parse a natural language query string into a TaskFilter.
 *
 * Supported patterns:
 *   - "priority 1", "p1", "p2" etc. → filter by priority
 *   - "tagged <name>", "#<name>" → filter by tag
 *   - "in project <name>", "project <name>" → filter by project name (stored as search)
 *   - "completed", "done" → status: completed
 *   - "pending", "todo", "open" → status: pending
 *   - "overdue" → due before today
 *   - "due today" → due today
 *   - "due this week" → due within 7 days
 *   - "due tomorrow" → due tomorrow
 *   - Date expressions via chrono-node: "due next friday", "due before march 15"
 *   - Free text → search filter
 */
export function parseQuery(input: string, referenceDate?: Date): ParsedQuery {
  const ref = referenceDate ?? new Date();
  const filter: TaskFilter = {};
  let text = input.trim();

  // Priority: "priority 1", "p1", "priority:2"
  text = text.replace(/\b(?:priority[:\s]+|p)([1-4])\b/i, (_, num) => {
    filter.priority = Number(num);
    return "";
  });

  // Status: "completed", "done", "pending", "todo", "open", "cancelled"
  text = text.replace(/\b(completed|done)\b/i, () => {
    filter.status = "completed";
    return "";
  });
  text = text.replace(/\b(pending|todo|open)\b/i, () => {
    filter.status = "pending";
    return "";
  });
  text = text.replace(/\b(cancelled|canceled)\b/i, () => {
    filter.status = "cancelled";
    return "";
  });

  // Tags: "#tagname" or "tagged tagname" or "tag tagname"
  text = text.replace(/(?:#(\w+)|\btagged?\s+(\w+))/gi, (_, hash, word) => {
    filter.tag = hash ?? word;
    return "";
  });

  // Project: "in project X" or "project X" or "+projectname"
  text = text.replace(/(?:\bin\s+project\s+(\w+)|\bproject[:\s]+(\w+)|\+(\w+))/gi, (_, a, b, c) => {
    // We can't filter by project name directly in TaskFilter (only projectId),
    // so we store the project name and let the caller resolve it.
    const projectName = a ?? b ?? c;
    filter.projectName = projectName;
    return "";
  });

  // Overdue: "overdue"
  text = text.replace(/\boverdue\b/i, () => {
    filter.dueBefore = startOfDay(ref).toISOString();
    return "";
  });

  // Due today: "due today"
  text = text.replace(/\bdue\s+today\b/i, () => {
    const start = startOfDay(ref);
    const end = endOfDay(ref);
    filter.dueAfter = start.toISOString();
    filter.dueBefore = end.toISOString();
    return "";
  });

  // Due tomorrow: "due tomorrow"
  text = text.replace(/\bdue\s+tomorrow\b/i, () => {
    const tomorrow = new Date(ref);
    tomorrow.setDate(tomorrow.getDate() + 1);
    filter.dueAfter = startOfDay(tomorrow).toISOString();
    filter.dueBefore = endOfDay(tomorrow).toISOString();
    return "";
  });

  // Due this week: "due this week"
  text = text.replace(/\bdue\s+this\s+week\b/i, () => {
    const end = new Date(ref);
    end.setDate(end.getDate() + (7 - end.getDay()));
    filter.dueAfter = startOfDay(ref).toISOString();
    filter.dueBefore = endOfDay(end).toISOString();
    return "";
  });

  // Due next week: "due next week"
  text = text.replace(/\bdue\s+next\s+week\b/i, () => {
    const nextMonday = new Date(ref);
    nextMonday.setDate(nextMonday.getDate() + (8 - nextMonday.getDay()));
    const nextSunday = new Date(nextMonday);
    nextSunday.setDate(nextSunday.getDate() + 6);
    filter.dueAfter = startOfDay(nextMonday).toISOString();
    filter.dueBefore = endOfDay(nextSunday).toISOString();
    return "";
  });

  // Generic "due <date expression>" via chrono-node
  // Matches "due before X", "due after X", "due by X", "due on X", "due X"
  if (!filter.dueBefore && !filter.dueAfter) {
    const dueBeforeMatch = text.match(
      /\bdue\s+(?:before|by)\s+(.+?)(?:\s+(?:p[1-4]|#\w+|tagged|priority|completed|done|pending|todo|open)|\s*$)/i,
    );
    if (dueBeforeMatch) {
      const parsed = chrono.parseDate(dueBeforeMatch[1], ref);
      if (parsed) {
        filter.dueBefore = endOfDay(parsed).toISOString();
        text = text.replace(dueBeforeMatch[0], "").trim();
      }
    }

    const dueAfterMatch = text.match(
      /\bdue\s+after\s+(.+?)(?:\s+(?:p[1-4]|#\w+|tagged|priority|completed|done|pending|todo|open)|\s*$)/i,
    );
    if (dueAfterMatch) {
      const parsed = chrono.parseDate(dueAfterMatch[1], ref);
      if (parsed) {
        filter.dueAfter = startOfDay(parsed).toISOString();
        text = text.replace(dueAfterMatch[0], "").trim();
      }
    }

    // "due <expression>" (exact date)
    if (!filter.dueBefore && !filter.dueAfter) {
      const dueMatch = text.match(
        /\bdue\s+(?:on\s+)?(.+?)(?:\s+(?:p[1-4]|#\w+|tagged|priority|completed|done|pending|todo|open)|\s*$)/i,
      );
      if (dueMatch) {
        const parsed = chrono.parseDate(dueMatch[1], ref);
        if (parsed) {
          filter.dueAfter = startOfDay(parsed).toISOString();
          filter.dueBefore = endOfDay(parsed).toISOString();
          text = text.replace(dueMatch[0], "").trim();
        }
      }
    }
  }

  // Remaining text becomes the search query
  const remaining = text.replace(/\s+/g, " ").trim();
  if (remaining) {
    filter.search = remaining;
  }

  return { filter, remainingText: remaining };
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}
