/**
 * Pure Eisenhower matrix classification and drop-result mapping.
 * Uses civil due_date comparison against a sampled local/server today key.
 */
import type { PatchTaskRequest, TaskDto } from "../api/client";

export type MatrixQuadrant = "q1" | "q2" | "q3" | "q4";

export interface QuadrantConfig {
  id: MatrixQuadrant;
  title: string;
  subtitle: string;
  bgClass: string;
  borderClass: string;
}

export const MATRIX_QUADRANTS: QuadrantConfig[] = [
  {
    id: "q1",
    title: "Do First",
    subtitle: "Urgent + Important",
    bgClass: "bg-error/5",
    borderClass: "border-error/20",
  },
  {
    id: "q2",
    title: "Schedule",
    subtitle: "Important",
    bgClass: "bg-accent-action/5",
    borderClass: "border-accent-action/20",
  },
  {
    id: "q3",
    title: "Delegate",
    subtitle: "Urgent",
    bgClass: "bg-warning/5",
    borderClass: "border-warning/20",
  },
  {
    id: "q4",
    title: "Eliminate",
    subtitle: "Neither",
    bgClass: "bg-surface-secondary",
    borderClass: "border-border",
  },
];

/** Classify a pending task into a matrix quadrant using civil due_date urgency. */
export function classifyMatrixTask(task: TaskDto, today: string): MatrixQuadrant {
  const isHighPriority =
    task.priority !== null && task.priority !== undefined && task.priority <= 2;
  const dueDay = task.due_date ?? null;
  const isUrgent = dueDay !== null && dueDay <= today;

  if (isHighPriority && isUrgent) return "q1";
  if (isHighPriority) return "q2";
  if (isUrgent) return "q3";
  return "q4";
}

/**
 * Map a drop target to the exact priority + civil due_date patch.
 * Never writes an ISO timestamp into due_date.
 */
export function matrixDropPatch(target: MatrixQuadrant, today: string): PatchTaskRequest {
  switch (target) {
    case "q1":
      return { priority: 1, due_date: today };
    case "q2":
      return { priority: 1, due_date: null };
    case "q3":
      return { priority: 3, due_date: today };
    case "q4":
      return { priority: 3, due_date: null };
  }
}

export function groupMatrixTasks(
  tasks: TaskDto[],
  today: string,
): Record<MatrixQuadrant, TaskDto[]> {
  const map: Record<MatrixQuadrant, TaskDto[]> = { q1: [], q2: [], q3: [], q4: [] };
  for (const task of tasks) {
    if (task.status !== "pending") continue;
    map[classifyMatrixTask(task, today)].push(task);
  }
  for (const tasksInQuadrant of Object.values(map)) {
    tasksInQuadrant.sort(
      (left, right) =>
        (left.priority ?? 5) - (right.priority ?? 5) || left.sort_order - right.sort_order,
    );
  }
  return map;
}
