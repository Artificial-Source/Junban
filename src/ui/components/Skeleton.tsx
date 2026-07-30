/**
 * Loading skeleton placeholders matching the legacy pattern.
 */
import type { ReactNode } from "react";

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      className={`animate-pulse rounded-md bg-surface-tertiary ${className}`}
      aria-hidden="true"
    />
  );
}

export function TaskRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-border/30">
      <Skeleton className="h-7 w-7 rounded-full flex-shrink-0" />
      <Skeleton className="h-4 flex-1 max-w-xs" />
    </div>
  );
}

export function TaskListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading tasks">
      {Array.from({ length: rows }).map((_, i) => (
        <TaskRowSkeleton key={i} />
      ))}
      <span className="sr-only">Loading tasks…</span>
    </div>
  );
}

export function ViewSkeleton() {
  return (
    <div role="status" aria-label="Loading view" className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full max-w-2xl" />
      <TaskListSkeleton rows={4} />
    </div>
  );
}

export function SidebarSkeleton() {
  return (
    <div className="space-y-2 px-3 py-4" aria-hidden="true">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-6 w-1/2" />
    </div>
  );
}

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description?: string;
}

export function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-on-surface-muted">
      <div className="mb-3 opacity-50">{icon}</div>
      <p className="text-sm font-medium text-on-surface-secondary">{title}</p>
      {description && <p className="mt-1 text-xs text-on-surface-muted">{description}</p>}
    </div>
  );
}
