import { useEffect } from "react";
import { shortcutManager } from "../shortcutManagerInstance.js";
import { themeManager } from "../themes/manager.js";
import { api } from "../api/index.js";

export function useAppShortcuts(
  setCommandPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>,
  undo: () => void,
  redo: () => void,
  setSearchOpen?: React.Dispatch<React.SetStateAction<boolean>>,
  setFocusModeOpen?: React.Dispatch<React.SetStateAction<boolean>>,
  setQuickAddOpen?: React.Dispatch<React.SetStateAction<boolean>>,
) {
  useEffect(() => {
    shortcutManager.register({
      id: "command-palette",
      description: "Open Command Palette",
      defaultKey: "ctrl+k",
      callback: () => setCommandPaletteOpen((open) => !open),
    });
    shortcutManager.register({
      id: "toggle-dark-mode",
      description: "Toggle Dark Mode",
      defaultKey: "ctrl+shift+d",
      callback: () => themeManager.toggle(),
    });
    shortcutManager.register({
      id: "undo",
      description: "Undo",
      defaultKey: "ctrl+z",
      callback: () => undo(),
    });
    shortcutManager.register({
      id: "redo",
      description: "Redo",
      defaultKey: "ctrl+shift+z",
      callback: () => redo(),
    });
    if (setSearchOpen) {
      shortcutManager.register({
        id: "search",
        description: "Search Tasks",
        defaultKey: "ctrl+f",
        callback: () => setSearchOpen((open) => !open),
      });
    }
    if (setFocusModeOpen) {
      shortcutManager.register({
        id: "focus-mode",
        description: "Enter Focus Mode",
        defaultKey: "ctrl+shift+f",
        callback: () => setFocusModeOpen(true),
      });
    }
    if (setQuickAddOpen) {
      shortcutManager.register({
        id: "quick-add",
        description: "Quick Add Task",
        defaultKey: "q",
        callback: () => setQuickAddOpen(true),
      });
      shortcutManager.register({
        id: "quick-add-ctrl",
        description: "Quick Add Task (Alt)",
        defaultKey: "ctrl+n",
        callback: () => setQuickAddOpen(true),
      });
    }

    // Load custom bindings from settings
    api.getAppSetting("keyboard_shortcuts").then((val) => {
      if (val) {
        try {
          shortcutManager.loadCustomBindings(JSON.parse(val));
        } catch {
          // Non-critical
        }
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      shortcutManager.handleKeyDown(e);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo, setCommandPaletteOpen, setSearchOpen, setFocusModeOpen, setQuickAddOpen]);
}
