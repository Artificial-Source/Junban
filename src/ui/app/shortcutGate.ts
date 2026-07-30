/**
 * Global chords/shortcuts stay off under blocking chrome (modals, drawer, detail).
 */
export function shouldEnableAppShortcuts(state: {
  quickAddOpen: boolean;
  searchOpen: boolean;
  paletteOpen: boolean;
  selectedTaskId: string | null;
  projectModalOpen: boolean;
  drawerOpen: boolean;
}): boolean {
  return (
    !state.quickAddOpen &&
    !state.searchOpen &&
    !state.paletteOpen &&
    !state.selectedTaskId &&
    !state.projectModalOpen &&
    !state.drawerOpen
  );
}
