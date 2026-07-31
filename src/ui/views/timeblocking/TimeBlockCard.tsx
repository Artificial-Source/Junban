/**
 * Timed block card with resize handles, lock/recurrence badges, and keyboard affordances.
 */
import { Lock, Repeat } from "lucide-react";
import type { TimeBlockDto } from "../../api/client";
import {
  civilTimeToMinutes,
  formatDurationMinutes,
  formatTimeRangeLabel,
  isVirtualOccurrence,
  normalizeCivilTime,
} from "./timeblockingRange";

interface TimeBlockCardProps {
  block: TimeBlockDto;
  pixelsPerHour: number;
  workDayStart: string;
  color: string;
  taskStatus?: "pending" | "completed" | "cancelled";
  selected?: boolean;
  onSelect: (occurrenceKey: string) => void;
  onOpenEditor: (occurrenceKey: string) => void;
  onResizePointerDown: (
    occurrenceKey: string,
    edge: "start" | "end",
    event: React.PointerEvent,
  ) => void;
  onMovePointerDown: (occurrenceKey: string, event: React.PointerEvent) => void;
}

export function TimeBlockCard({
  block,
  pixelsPerHour,
  workDayStart,
  color,
  taskStatus,
  selected = false,
  onSelect,
  onOpenEditor,
  onResizePointerDown,
  onMovePointerDown,
}: TimeBlockCardProps) {
  const startMin = civilTimeToMinutes(block.start) ?? 0;
  const endMin = civilTimeToMinutes(block.end) ?? startMin + 30;
  const dayStartMin = civilTimeToMinutes(workDayStart) ?? 0;
  const duration = Math.max(0, endMin - startMin);
  const top = ((startMin - dayStartMin) / 60) * pixelsPerHour;
  const height = Math.max((duration / 60) * pixelsPerHour, 20);
  const isCompact = duration < 45;
  const virtual = isVirtualOccurrence(block);
  const completed = taskStatus === "completed";

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`time-block-${block.occurrence_key}`}
      data-occurrence-key={block.occurrence_key}
      data-block-id={block.id}
      aria-label={`${block.title}, ${normalizeCivilTime(block.start)} to ${normalizeCivilTime(block.end)}${block.locked ? ", locked" : ""}${virtual ? ", recurring series" : ""}`}
      aria-pressed={selected || undefined}
      className={`absolute left-1 right-1 z-10 overflow-hidden rounded-md border select-none cursor-grab group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        selected ? "ring-2 ring-accent-action shadow-md" : "hover:shadow-md"
      }`}
      style={{
        top,
        height,
        backgroundColor: `color-mix(in srgb, ${color} 15%, var(--color-surface))`,
        borderColor: `color-mix(in srgb, ${color} 30%, var(--color-border))`,
      }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(block.occurrence_key);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onOpenEditor(block.occurrence_key);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenEditor(block.occurrence_key);
        }
      }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("[data-resize-edge]")) return;
        onMovePointerDown(block.occurrence_key, event);
      }}
    >
      <div
        data-resize-edge="start"
        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize z-20 hover:bg-accent-action/30 rounded-t-md"
        onPointerDown={(event) => {
          event.stopPropagation();
          onResizePointerDown(block.occurrence_key, "start", event);
        }}
        aria-hidden="true"
      />

      <div className="px-2 py-1 h-full flex flex-col justify-center overflow-hidden pointer-events-none">
        <div className="flex items-center gap-1.5 min-w-0">
          {block.task_id && (
            <div
              className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${
                completed ? "bg-success border-success" : "border-on-surface-muted"
              }`}
            />
          )}
          <span
            className={`text-sm font-medium truncate flex-1 ${
              completed ? "line-through text-on-surface-muted" : "text-on-surface"
            }`}
          >
            {block.title}
          </span>
          {block.locked && (
            <Lock size={12} className="text-on-surface-muted flex-shrink-0" aria-hidden="true" />
          )}
          {(block.recurrence_rule || virtual) && (
            <Repeat size={12} className="text-on-surface-muted flex-shrink-0" aria-hidden="true" />
          )}
        </div>
        {!isCompact && (
          <div className="text-xs text-on-surface-secondary mt-0.5 truncate">
            {formatTimeRangeLabel(block.start, block.end)} · {formatDurationMinutes(duration)}
          </div>
        )}
      </div>

      <div
        data-resize-edge="end"
        className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize z-20 hover:bg-accent-action/30 rounded-b-md"
        onPointerDown={(event) => {
          event.stopPropagation();
          onResizePointerDown(block.occurrence_key, "end", event);
        }}
        aria-hidden="true"
      />
    </div>
  );
}
