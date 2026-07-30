/**
 * Decide how an open task-detail panel should react to a committed event.
 * Catalog-only events never force a detail refetch.
 */
import type { CommittedEventDto, TaskDto } from "../api/client";
import { taskFromCommittedEvent } from "../api/client";

export type DetailRefreshAction =
  { kind: "none" } | { kind: "snapshot"; task: TaskDto } | { kind: "refetch" } | { kind: "close" };

export function detailRefreshFromEvent(
  selectedTaskId: string | null,
  event: CommittedEventDto,
): DetailRefreshAction {
  if (!selectedTaskId) return { kind: "none" };

  if (event.event_type === "task.deleted") {
    if (event.affected.task_ids?.includes(selectedTaskId)) {
      return { kind: "close" };
    }
    return { kind: "none" };
  }

  const snapshot = taskFromCommittedEvent(event);
  if (snapshot?.id === selectedTaskId) {
    return { kind: "snapshot", task: snapshot };
  }

  if (event.affected.task_ids?.includes(selectedTaskId)) {
    return { kind: "refetch" };
  }

  return { kind: "none" };
}
