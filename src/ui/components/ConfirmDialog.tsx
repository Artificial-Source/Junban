/**
 * Small accessible confirmation dialog matching existing modal tokens.
 * No framework — plain React + the shared focus-trap helper.
 */
import { useEffect, useRef } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive styling for the confirm action (default true). */
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = true,
  pending = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, pending, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 animate-fade-in"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        className="w-full max-w-sm mx-4 bg-surface rounded-xl shadow-2xl border border-border animate-scale-fade-in overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4">
          <h2 id="confirm-dialog-title" className="text-sm font-semibold text-on-surface">
            {title}
          </h2>
          <p id="confirm-dialog-message" className="mt-2 text-sm text-on-surface-secondary">
            {message}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="px-3 py-2 rounded-lg border border-border text-sm font-medium text-on-surface-secondary hover:bg-surface-secondary disabled:opacity-50 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            aria-label={confirmLabel}
            className={
              danger
                ? "px-3 py-2 rounded-lg border border-error/30 bg-error/10 text-error text-sm font-medium hover:bg-error/15 disabled:opacity-50 transition-colors"
                : "px-3 py-2 rounded-lg bg-accent-action text-on-accent-action text-sm font-medium hover:bg-accent-action-hover disabled:opacity-50 transition-colors"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
