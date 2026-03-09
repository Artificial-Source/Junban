import type { TimeBlock } from "./types.js";

/** Find all blocks linked to a specific task. */
export function getBlocksForTask(blocks: TimeBlock[], taskId: string): TimeBlock[] {
  return blocks.filter((b) => b.taskId === taskId);
}

/** Find the block linked to a task on a specific date (if any). */
export function getBlockForTaskOnDate(
  blocks: TimeBlock[],
  taskId: string,
  date: string,
): TimeBlock | null {
  return blocks.find((b) => b.taskId === taskId && b.date === date) ?? null;
}

/** Check if a task is already scheduled (has any linked block on or after today). */
export function isTaskScheduled(blocks: TimeBlock[], taskId: string, today: string): boolean {
  return blocks.some((b) => b.taskId === taskId && b.date >= today);
}
