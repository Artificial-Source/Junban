/**
 * Mobile navigation drawer with dialog semantics, focus trap, Escape dismiss,
 * opener focus restoration, and background inertness while open.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
  /** Optional id for aria-controls on the menu trigger. */
  id?: string;
  /** AppLayout owns isolation when several modal layers share one shell. */
  manageBackground?: boolean;
}

export function MobileDrawer({
  open,
  onClose,
  children,
  id,
  manageBackground = true,
}: MobileDrawerProps) {
  const panelRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const drawerId = id ?? generatedId;
  useFocusTrap(panelRef, open);

  // Escape closes the open drawer.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  // Make sibling app chrome inert so background content is not operable.
  useEffect(() => {
    if (!open || !manageBackground) return;
    const root = rootRef.current;
    const parent = root?.parentElement;
    if (!root || !parent) return;

    const madeInert: HTMLElement[] = [];
    for (const child of Array.from(parent.children)) {
      if (child === root || !(child instanceof HTMLElement)) continue;
      if (child.inert) continue;
      child.inert = true;
      madeInert.push(child);
    }
    return () => {
      for (const el of madeInert) {
        el.inert = false;
      }
    };
  }, [open, manageBackground]);

  return (
    <div
      ref={rootRef}
      className={`fixed inset-0 z-50 h-dvh max-h-dvh overflow-hidden md:hidden transition-visibility motion-reduce:transition-none ${
        open ? "visible" : "invisible"
      }`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-300 motion-reduce:transition-none ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      {/* Drawer panel */}
      <aside
        ref={panelRef}
        id={drawerId}
        className={`absolute inset-y-0 left-0 flex h-dvh max-h-dvh w-[min(17.5rem,100%)] flex-col overflow-hidden bg-surface-secondary shadow-xl transition-transform duration-300 ease-out motion-reduce:transition-none ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation drawer"
        tabIndex={-1}
      >
        {children}
      </aside>
    </div>
  );
}
