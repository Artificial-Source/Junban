/**
 * Toast notifications with live-region semantics.
 * Auto-dismiss after a configurable timeout; manual dismiss always available.
 * Optional action (e.g. Smart Nudge Dismiss) uses the inverted legacy surface.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertCircle, Info, X, Undo2 } from "lucide-react";

export type ToastKind = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastEntry {
  id: string;
  kind: ToastKind;
  message: string;
  undoOperationId?: string | null;
  /** Optional primary action (e.g. Dismiss for nudges). */
  action?: ToastAction | null;
  /** Optional href rendered as a link beside the message. */
  href?: string | null;
  hrefLabel?: string | null;
  /** Auto-dismiss ms; null disables auto-dismiss. Default 4000. */
  durationMs?: number | null;
  /** Inverted surface used by Smart Nudge / legacy action toasts. */
  inverted?: boolean;
}

let nextToastId = 0;

export type ShowToastOptions = {
  undoOperationId?: string | null;
  action?: ToastAction | null;
  href?: string | null;
  hrefLabel?: string | null;
  durationMs?: number | null;
  inverted?: boolean;
};

export function useToasts() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (kind: ToastKind, message: string, options?: string | null | ShowToastOptions) => {
      const normalized: ShowToastOptions =
        typeof options === "string" || options === null || options === undefined
          ? { undoOperationId: options }
          : options;
      const id = `toast-${++nextToastId}`;
      setToasts((prev) => [
        ...prev,
        {
          id,
          kind,
          message,
          undoOperationId: normalized.undoOperationId,
          action: normalized.action,
          href: normalized.href,
          hrefLabel: normalized.hrefLabel,
          durationMs: normalized.durationMs,
          inverted: normalized.inverted,
        },
      ]);
      return id;
    },
    [],
  );

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
      className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4 md:bottom-16"
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
  const inverted = Boolean(toast.inverted || toast.action);

  useEffect(() => {
    if (toast.durationMs === null) return;
    const ms = toast.durationMs ?? 4000;
    timerRef.current = setTimeout(() => onDismiss(toast.id), ms);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.id, toast.durationMs, onDismiss]);

  const Icon =
    toast.kind === "success" ? CheckCircle2 : toast.kind === "error" ? AlertCircle : Info;
  const iconColor = inverted
    ? "text-surface"
    : toast.kind === "success"
      ? "text-success"
      : toast.kind === "error"
        ? "text-error"
        : "text-on-surface-muted";

  return (
    <div
      role={toast.action ? "alert" : "status"}
      className={
        inverted
          ? "pointer-events-auto flex w-full items-center gap-3 rounded-lg bg-on-surface px-4 py-2.5 text-sm text-surface shadow-lg animate-toast-in"
          : "pointer-events-auto flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-4 py-3 shadow-lg animate-toast-in"
      }
    >
      {!inverted && <Icon size={16} className={`flex-shrink-0 ${iconColor}`} aria-hidden="true" />}
      <span className={`flex-1 text-sm ${inverted ? "text-surface" : "text-on-surface"}`}>
        {toast.message}
        {toast.href && (
          <>
            {" "}
            <a
              href={toast.href}
              className={
                inverted
                  ? "underline decoration-surface/70 hover:decoration-surface"
                  : "font-medium text-accent-foreground underline"
              }
            >
              {toast.hrefLabel ?? "Open"}
            </a>
          </>
        )}
      </span>
      {toast.undoOperationId && onUndo && (
        <button
          type="button"
          onClick={() => {
            onUndo(toast.undoOperationId!);
            onDismiss(toast.id);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-action/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Undo2 size={12} />
          Undo
        </button>
      )}
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
          className="rounded border border-surface px-1.5 py-0.5 font-medium text-surface underline transition-colors hover:bg-surface hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className={
          inverted
            ? "ml-1 rounded text-surface transition-colors hover:bg-surface hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface"
            : "flex-shrink-0 rounded-md p-1 text-on-surface-muted transition-colors hover:bg-surface-tertiary hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        }
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
