/** Deterministic mobile breakpoint for the Phase 7 visual harness. */
export function useIsMobile(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth <= 767;
}
