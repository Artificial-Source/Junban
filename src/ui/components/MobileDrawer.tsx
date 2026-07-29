import { type ReactNode } from "react";

interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function MobileDrawer({ open, onClose, children }: MobileDrawerProps) {
  return (
    <div
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
        className={`absolute inset-y-0 left-0 flex h-dvh max-h-dvh w-[min(17.5rem,100%)] flex-col overflow-hidden bg-surface-secondary shadow-xl transition-transform duration-300 ease-out motion-reduce:transition-none ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation drawer"
      >
        {children}
      </aside>
    </div>
  );
}
