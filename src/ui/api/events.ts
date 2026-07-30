/**
 * Phase 2 committed-event helpers shared by the SSE client and live-query hooks.
 */

import type { CommittedEventDto, ResourceSnapshotDto, TaskDto } from "./types";

/** Event types the Phase 2 server emits today. Unknown strings force a safe resync. */
export const KNOWN_EVENT_TYPES = new Set<string>([
  "task.created",
  "task.updated",
  "task.completed",
  "task.uncompleted",
  "task.cancelled",
  "task.reopened",
  "task.deleted",
  "task.moved",
  "task.reordered",
  "task.bulk",
  "task.restored",
  "project.created",
  "project.updated",
  "project.deleted",
  "section.created",
  "section.updated",
  "section.deleted",
  "tag.created",
  "tag.updated",
  "tag.deleted",
  "template.created",
  "template.updated",
  "template.deleted",
  "template.applied",
  "saved_filter.created",
  "saved_filter.updated",
  "saved_filter.deleted",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "relation.added",
  "relation.removed",
  "operation.undone",
  "sync.resync_required",
]);

export const RESYNC_REQUIRED_TYPE = "sync.resync_required";

export function isKnownEventType(eventType: string): boolean {
  return KNOWN_EVENT_TYPES.has(eventType);
}

export function isResyncRequired(eventType: string): boolean {
  return eventType === RESYNC_REQUIRED_TYPE;
}

/** Structural guard for SSE/mutation envelopes without broad casts. */
export function isCommittedEvent(data: unknown): data is CommittedEventDto {
  if (!data || typeof data !== "object") return false;
  const event = data as Record<string, unknown>;
  if (
    typeof event.revision !== "number" ||
    !Number.isFinite(event.revision) ||
    event.revision < 0 ||
    typeof event.operation_id !== "string" ||
    typeof event.event_type !== "string" ||
    typeof event.occurred_at !== "string" ||
    !event.affected ||
    typeof event.affected !== "object" ||
    !event.resync ||
    typeof event.resync !== "object"
  ) {
    return false;
  }
  const resync = event.resync as Record<string, unknown>;
  return typeof resync.tasks === "boolean" && typeof resync.catalog === "boolean";
}

export function taskSnapshotFrom(snapshot: ResourceSnapshotDto | null | undefined): TaskDto | null {
  if (!snapshot || snapshot.resource_type !== "task") return null;
  return snapshot.task;
}

export function taskFromCommittedEvent(event: CommittedEventDto): TaskDto | null {
  return taskSnapshotFrom(event.snapshot);
}

/** Single-resource task mutations may patch local state; bulk/cascade/delete need a query refresh. */
export function shouldPatchTaskFromEvent(event: CommittedEventDto): boolean {
  if (isResyncRequired(event.event_type) || !isKnownEventType(event.event_type)) {
    return false;
  }
  if (event.resync.tasks) return false;
  if (event.event_type === "task.deleted" || event.event_type === "task.bulk") {
    return false;
  }
  return taskFromCommittedEvent(event) !== null;
}
