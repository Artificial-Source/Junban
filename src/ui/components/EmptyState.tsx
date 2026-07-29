import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
}

export function EmptyState({ icon, title }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-on-surface-muted">
      <div className="mb-3 opacity-50">{icon}</div>
      <p className="text-sm font-medium text-on-surface-secondary">{title}</p>
    </div>
  );
}
