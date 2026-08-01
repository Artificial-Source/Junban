/**
 * Shell isolation helpers for blocking overlays (detail, modals, drawer).
 * Task-detail isolation must track a real overlay/loading surface — not a bare
 * selectedTaskId — so a rejected detail load cannot leave the shell inert.
 */

/** True only while the detail panel or its loading cover is actually rendered. */
export function isTaskDetailLayerActive(
  selectedTaskId: string | null,
  detailTask: { id: string } | null,
  detailLoading: boolean,
): boolean {
  if (selectedTaskId === null) return false;
  if (detailTask !== null && detailTask.id === selectedTaskId) return true;
  if (detailLoading && (detailTask === null || detailTask.id !== selectedTaskId)) return true;
  return false;
}

export type ShellBlockingFlags = {
  drawerOpen: boolean;
  quickAddOpen: boolean;
  searchOpen: boolean;
  paletteOpen: boolean;
  projectModalOpen: boolean;
  taskDetailActive: boolean;
  planMyDayOpen?: boolean;
  endOfDayOpen?: boolean;
  weeklyReviewOpen?: boolean;
  focusModeOpen?: boolean;
};

export function isShellBlocking(flags: ShellBlockingFlags): boolean {
  return (
    flags.drawerOpen ||
    flags.quickAddOpen ||
    flags.searchOpen ||
    flags.paletteOpen ||
    flags.projectModalOpen ||
    flags.taskDetailActive ||
    Boolean(flags.planMyDayOpen) ||
    Boolean(flags.endOfDayOpen) ||
    Boolean(flags.weeklyReviewOpen) ||
    Boolean(flags.focusModeOpen)
  );
}

/**
 * Mark every direct child of `root` inert/aria-hidden except those tagged
 * `data-app-overlay`. Returns a restore function.
 */
export function isolateShellSiblings(root: HTMLElement): () => void {
  const isolated: Array<{ element: HTMLElement; ariaHidden: string | null }> = [];
  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement) || child.hasAttribute("data-app-overlay")) continue;
    if (child.inert) continue;
    isolated.push({ element: child, ariaHidden: child.getAttribute("aria-hidden") });
    child.inert = true;
    child.setAttribute("aria-hidden", "true");
  }
  return () => {
    for (const { element, ariaHidden } of isolated) {
      element.inert = false;
      if (ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", ariaHidden);
    }
  };
}
