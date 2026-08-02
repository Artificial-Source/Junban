/**
 * Trap keyboard focus within a dialog/panel and restore it to the opener on cleanup.
 * Pure DOM — no external focus-trap dependency.
 */
import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

function isSafeFocusTarget(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [aria-hidden="true"], [inert]')) {
    return false;
  }
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function focusableChildren(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    isSafeFocusTarget,
  );
}

export function useFocusTrap<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
  returnFocusTarget?: HTMLElement | null,
): void {
  useEffect(() => {
    if (!active || !ref.current) return;

    const container = ref.current;
    const opener =
      returnFocusTarget ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);

    const autofocusTarget = container.querySelector<HTMLElement>("[data-autofocus]");
    const initialFocusable =
      (autofocusTarget &&
      autofocusTarget.matches(FOCUSABLE_SELECTOR) &&
      isSafeFocusTarget(autofocusTarget)
        ? autofocusTarget
        : null) ??
      focusableChildren(container)[0] ??
      container;

    if (!container.hasAttribute("tabindex")) {
      container.tabIndex = -1;
    }
    initialFocusable.focus({ preventScroll: true });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusable = focusableChildren(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeElement = document.activeElement;

      if (
        activeElement === container ||
        !(activeElement instanceof Node) ||
        !container.contains(activeElement)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
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
        if (opener.matches(":disabled") || !isSafeFocusTarget(opener)) return;
        const activeEl = document.activeElement;
        if (
          activeEl &&
          activeEl !== document.body &&
          activeEl !== document.documentElement &&
          !container.contains(activeEl)
        ) {
          return;
        }
        opener.focus({ preventScroll: true });
      });
    };
  }, [ref, active, returnFocusTarget]);
}
