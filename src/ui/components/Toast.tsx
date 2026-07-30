/**
 * Toast notifications with live-region semantics.
 * Auto-dismiss after a configurable timeout; manual dismiss always available.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Info, X, Undo2 } from "lucide-react";

export type ToastKind = "success" | "error" | "info";

export interface ToastEntry {
  id: string;
  kind: ToastKind;
  message: string;
  undoOperationId?: string | null;
}

let nextToastId = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((kind: ToastKind, message: string, undoOperationId?: string | null) => {
    const id = `toast-${++nextToastId}`;
    setToasts((prev) => [...prev, { id, kind, message, undoOperationId }]);
    return id;
  }, []);

  return { toasts, show, dismiss };
}

export type ToastContainerProps = {
  toasts: ToastEntry[];
  onDismiss: (id: string) => void;
  onUndo?: (operationId: string) => void;
};

export function ToastContainer({ toasts, onDismiss, onUndo }: ToastContainerProps) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col gap-2 items-center w-full max-w-md px-4 pointer-events-none"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} onUndo={onUndo} />
      ))}
    </div>
  );
}

function ToastItem({
  toast,
  onDismiss,
  onUndo,
}: {
  toast: ToastEntry;
  onDismiss: (id: string) => void;
  onUndo?: (operationId: string) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timerRef.current = setTimeout(() => onDismiss(toast.id), 4000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.id, onDismiss]);

  const Icon =
    toast.kind === "success" ? CheckCircle2 : toast.kind === "error" ? AlertCircle : Info;
  const iconColor =
    toast.kind === "success"
      ? "text-success"
      : toast.kind === "error"
        ? "text-error"
        : "text-on-surface-muted";

  return (
    <div
      role="status"
      className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 shadow-lg w-full animate-toast-in"
    >
      <Icon size={16} className={`flex-shrink-0 ${iconColor}`} aria-hidden="true" />
      <span className="flex-1 text-sm text-on-surface">{toast.message}</span>
      {toast.undoOperationId && onUndo && (
        <button
          type="button"
          onClick={() => {
            onUndo(toast.undoOperationId!);
            onDismiss(toast.id);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent-foreground hover:bg-accent-action/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Undo2 size={12} />
          Undo
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="flex-shrink-0 rounded-md p-1 text-on-surface-muted hover:bg-surface-tertiary hover:text-on-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
