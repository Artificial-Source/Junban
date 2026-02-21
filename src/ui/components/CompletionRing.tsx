interface CompletionRingProps {
  completed: number;
  total: number;
  size?: number;
}

export function CompletionRing({ completed, total, size = 32 }: CompletionRingProps) {
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = total > 0 ? completed / total : 0;
  const offset = circumference * (1 - progress);

  return (
    <div
      className="inline-flex items-center gap-1.5"
      aria-label={`${completed} of ${total} tasks completed`}
    >
      <svg width={size} height={size} className="transform -rotate-90">
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          className="text-surface-tertiary"
        />
        {/* Progress circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="text-accent transition-all duration-500"
        />
      </svg>
      <span className="text-xs font-medium text-on-surface-muted">
        {completed}/{total}
      </span>
    </div>
  );
}
