export function WorkloadBar({
  assessment,
  total,
  weight,
}: {
  assessment: string;
  total: number;
  weight: number;
}) {
  const color =
    assessment === "heavy"
      ? "bg-error/70"
      : assessment === "normal"
        ? "bg-warning/60"
        : "bg-success/60";
  const label = assessment === "heavy" ? "Heavy" : assessment === "normal" ? "Normal" : "Light";
  const pct = Math.min(100, Math.round((weight / 16) * 100));

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-on-surface-muted w-14 shrink-0">{total} tasks</span>
      <div className="flex-1 h-2.5 bg-surface-tertiary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${Math.max(pct, 6)}%` }}
        />
      </div>
      <span
        className={`text-[10px] font-semibold ${
          assessment === "heavy"
            ? "text-error"
            : assessment === "normal"
              ? "text-warning"
              : "text-success"
        }`}
      >
        {label}
      </span>
    </div>
  );
}
