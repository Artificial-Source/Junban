/**
 * Trap keyboard focus within a dialog/panel and restore it to the opener on cleanup.
 * Pure DOM — no external focus-trap dependency.
 */
import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active || !ref.current) return;

    const container = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Focus the first focusable element (or the container itself).
    const firstFocusable = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (firstFocusable) {
      firstFocusable.focus();
    } else {
      container.focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    container.addEventListener("keydown", handleKeyDown);
    return () => {
      container.removeEventListener("keydown", handleKeyDown);
      // Modal-shell isolation is released by a sibling effect in the same commit.
      // Restore after all effect cleanups so focus is not rejected by `inert`.
      queueMicrotask(() => {
        if (!opener?.isConnected) return;
        const active = document.activeElement;
        if (
          active &&
          active !== document.body &&
          active !== document.documentElement &&
          !container.contains(active)
        ) {
          return;
        }
        opener.focus();
      });
    };
  }, [ref, active]);
}
