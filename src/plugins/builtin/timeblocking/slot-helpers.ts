import type { TimeBlock, TimeSlot } from "./types.js";

const DEFAULT_COLOR = "#6366f1";

/** Get completion progress for a slot. */
export function getSlotProgress(
  slot: TimeSlot,
  taskLookup: (taskId: string) => { status: string } | undefined,
): { completed: number; total: number; percent: number } {
  const total = slot.taskIds.length;
  if (total === 0) return { completed: 0, total: 0, percent: 0 };

  const completed = slot.taskIds.filter((id) => {
    const task = taskLookup(id);
    return task?.status === "completed";
  }).length;

  return { completed, total, percent: Math.round((completed / total) * 100) };
}

/** Get the effective color for a slot (explicit > project > default). */
export function getSlotColor(
  slot: TimeSlot,
  projectLookup: (projectId: string) => { color: string } | undefined,
  defaultColor: string = DEFAULT_COLOR,
): string {
  if (slot.color) return slot.color;
  if (slot.projectId) {
    const project = projectLookup(slot.projectId);
    if (project?.color) return project.color;
  }
  return defaultColor;
}

/** Calculate the total estimated minutes for tasks in a slot. */
export function getSlotEstimatedMinutes(
  slot: TimeSlot,
  taskLookup: (taskId: string) => { estimatedMinutes?: number | null } | undefined,
): number {
  return slot.taskIds.reduce((sum, id) => {
    const task = taskLookup(id);
    return sum + (task?.estimatedMinutes ?? 0);
  }, 0);
}

/** Check if two time ranges overlap. Adjacent ranges (one ends where other starts) do not overlap. */
export function isOverlapping(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Find all conflicts (overlapping blocks/slots) for a given date. */
export function findConflicts(
  blocks: TimeBlock[],
  slots: TimeSlot[],
  date: string,
): Array<{ a: { id: string; type: "block" | "slot" }; b: { id: string; type: "block" | "slot" } }> {
  const items: Array<{ id: string; type: "block" | "slot"; startTime: string; endTime: string }> =
    [];

  for (const b of blocks) {
    if (b.date === date) items.push({ id: b.id, type: "block", startTime: b.startTime, endTime: b.endTime });
  }
  for (const s of slots) {
    if (s.date === date) items.push({ id: s.id, type: "slot", startTime: s.startTime, endTime: s.endTime });
  }

  const conflicts: Array<{
    a: { id: string; type: "block" | "slot" };
    b: { id: string; type: "block" | "slot" };
  }> = [];

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (isOverlapping(items[i].startTime, items[i].endTime, items[j].startTime, items[j].endTime)) {
        conflicts.push({
          a: { id: items[i].id, type: items[i].type },
          b: { id: items[j].id, type: items[j].type },
        });
      }
    }
  }

  return conflicts;
}
