import { formatDuration } from "./today-utils.js";

export function WorkloadCapacityBar({
  planned,
  capacity,
}: {
  planned: number;
  capacity: number;
}) {
  const pct = Math.min((planned / capacity) * 100, 100);
  const over = planned > capacity;

  return (
    <div className="mb-4 px-1">
      <div className="flex items-center justify-between text-xs text-on-surface-muted mb-1">
        <span>
          {formatDuration(planned)} / {formatDuration(capacity)} planned
        </span>
        {over && (
          <span className="text-error font-medium">+{formatDuration(planned - capacity)} over</span>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-surface-tertiary overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${over ? "bg-error" : "bg-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
