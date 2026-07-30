/**
 * Mutation feedback alert with pending/error/outcome-unknown semantics.
 * Preserves the legacy alert pattern.
 */
import { AlertCircle, Loader2 } from "lucide-react";

export type MutationFeedbackState = "idle" | "pending" | "error" | "outcome-unknown";

interface TaskMutationFeedbackProps {
  state: MutationFeedbackState;
  message?: string | null;
  onRetry?: () => void;
  onRefresh?: () => void;
  className?: string;
}

export function TaskMutationFeedback({
  state,
  message,
  onRetry,
  onRefresh,
  className = "",
}: TaskMutationFeedbackProps) {
  if (state === "idle") return null;

  if (state === "pending") {
    return (
      <p
        role="status"
        className={`flex items-center gap-1.5 text-xs text-on-surface-muted ${className}`}
      >
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />
        Saving…
      </p>
    );
  }

  if (state === "outcome-unknown") {
    return (
      <div
        role="alert"
        className={`rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-on-warning ${className}`}
      >
        <p>{message ?? "The request may or may not have succeeded."}</p>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="mt-1 rounded border border-border px-2 py-0.5 text-xs font-medium text-on-surface-secondary hover:bg-surface-secondary"
          >
            Refresh from server
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={`flex items-start gap-1.5 rounded-md border border-error/30 bg-error/5 p-2 text-xs text-error ${className}`}
    >
      <AlertCircle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
      <div className="flex-1">
        <p>{message ?? "Could not complete the action."}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 rounded border border-border px-2 py-0.5 text-xs font-medium text-on-surface-secondary hover:bg-surface-secondary"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
