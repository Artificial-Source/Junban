/**
 * First-load start-screen resolution from confirmed task_defaults.default_view.
 * Only Inbox/Today/Upcoming are legacy start screens; broader enum values are ignored.
 */

export type StartScreenView = "inbox" | "today" | "upcoming";

/** Map a server default_view onto a legacy start-screen destination, if any. */
export function startScreenFromDefaultView(defaultView: string): StartScreenView | null {
  if (defaultView === "inbox" || defaultView === "today" || defaultView === "upcoming") {
    return defaultView;
  }
  return null;
}

/** True only for the first authoritative settings apply on bare root `/`. */
export function shouldApplyStartupDefaultView(args: {
  pathname: string;
  alreadyApplied: boolean;
  /** Any immutable visual fixture query must keep the frozen scene path. */
  visualFixture: boolean;
}): boolean {
  if (args.alreadyApplied || args.visualFixture) return false;
  const path =
    args.pathname.length > 1 && args.pathname.endsWith("/")
      ? args.pathname.slice(0, -1)
      : args.pathname;
  return path === "/" || path === "";
}
