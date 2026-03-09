import { useMemo, type ReactNode } from "react";
import {
  Settings,
  Home,
  Link,
  Heart,
  EyeOff,
  Eye,
  RotateCcw,
  ArrowUpToLine,
  ArrowDownToLine,
  FolderPlus,
  ListPlus,
  SlidersHorizontal,
} from "lucide-react";
import type { GeneralSettings } from "../../context/SettingsContext.js";
import { NAV_FEATURE_MAP, CORE_VIEWS, SECTION_IDS } from "./SidebarPrimitives.js";

export interface ContextMenuState {
  itemId: string;
  x: number;
  y: number;
}

export function useSidebarContextMenu({
  ctxMenu,
  favoriteViewIds,
  settings,
  updateSetting,
  onOpenSettings,
  orderedSidebarItems,
  hasHiddenViews,
}: {
  ctxMenu: ContextMenuState | null;
  favoriteViewIds: Set<string>;
  settings: GeneralSettings;
  updateSetting: (key: keyof GeneralSettings, value: string) => void;
  onOpenSettings?: () => void;
  orderedSidebarItems: string[];
  hasHiddenViews: boolean;
}) {
  return useMemo(() => {
    if (!ctxMenu) return [];
    const { itemId } = ctxMenu;
    const items: Array<{
      id: string;
      label: string;
      icon?: ReactNode;
      separator?: boolean;
      disabled?: boolean;
      onClick?: () => void;
    }> = [];

    // ── Group 1: Favorites ──
    const isFavorited = favoriteViewIds.has(itemId);
    items.push({
      id: "favorite",
      label: isFavorited ? "Remove from Favorites" : "Add to Favorites",
      icon: <Heart size={14} />,
      onClick: () => {
        const current = new Set(favoriteViewIds);
        if (isFavorited) current.delete(itemId);
        else current.add(itemId);
        updateSetting("sidebar_favorite_views", [...current].join(","));
      },
    });

    // ── Group 2: Set as Home ──
    const isHome = settings.start_view === itemId;
    items.push({
      id: "set-home",
      label: isHome ? "Home view" : "Set as Home view",
      icon: <Home size={14} />,
      separator: true,
      disabled: isHome,
      onClick: isHome ? undefined : () => updateSetting("start_view", itemId),
    });

    // Copy link
    items.push({
      id: "copy-link",
      label: "Copy link",
      icon: <Link size={14} />,
      onClick: () => {
        const url = `${window.location.origin}${window.location.pathname}#/${itemId}`;
        navigator.clipboard.writeText(url).catch(() => {});
      },
    });

    // ── Group 3: Visibility ──
    const featureKey = NAV_FEATURE_MAP[itemId];
    if (featureKey && !CORE_VIEWS.has(itemId)) {
      items.push({
        id: "hide",
        label: "Hide from sidebar",
        icon: <EyeOff size={14} />,
        separator: true,
        onClick: () => updateSetting(featureKey, "false"),
      });

      // Hide others — hide all optional views except this one
      const otherOptionalVisible = orderedSidebarItems.filter(
        (id) => id !== itemId && NAV_FEATURE_MAP[id] && !CORE_VIEWS.has(id) && !SECTION_IDS.has(id),
      );
      if (otherOptionalVisible.length > 0) {
        items.push({
          id: "hide-others",
          label: "Hide others",
          icon: <EyeOff size={14} />,
          onClick: () => {
            for (const otherId of otherOptionalVisible) {
              const key = NAV_FEATURE_MAP[otherId];
              if (key) updateSetting(key, "false");
            }
          },
        });
      }
    }

    if (CORE_VIEWS.has(itemId) && onOpenSettings) {
      items.push({
        id: "manage",
        label: "Manage in Settings",
        icon: <Settings size={14} />,
        separator: true,
        onClick: () => onOpenSettings(),
      });
    }

    // Show all hidden
    if (hasHiddenViews) {
      items.push({
        id: "show-all",
        label: "Show all hidden",
        icon: <Eye size={14} />,
        separator: !featureKey && !CORE_VIEWS.has(itemId),
        onClick: () => {
          for (const [, key] of Object.entries(NAV_FEATURE_MAP)) {
            if (settings[key] === "false") updateSetting(key, "true");
          }
        },
      });
    }

    // ── Group 4: Ordering ──
    const currentIndex = orderedSidebarItems.indexOf(itemId);

    if (currentIndex > 0) {
      items.push({
        id: "move-top",
        label: "Move to top",
        icon: <ArrowUpToLine size={14} />,
        separator: true,
        onClick: () => {
          const reordered = orderedSidebarItems.filter((id) => id !== itemId);
          reordered.unshift(itemId);
          updateSetting("sidebar_section_order", reordered.join(","));
        },
      });
    }

    if (currentIndex >= 0 && currentIndex < orderedSidebarItems.length - 1) {
      items.push({
        id: "move-bottom",
        label: "Move to bottom",
        icon: <ArrowDownToLine size={14} />,
        onClick: () => {
          const reordered = orderedSidebarItems.filter((id) => id !== itemId);
          reordered.push(itemId);
          updateSetting("sidebar_section_order", reordered.join(","));
        },
      });
    }

    if (settings.sidebar_section_order || settings.sidebar_nav_order) {
      items.push({
        id: "reset-order",
        label: "Reset order",
        icon: <RotateCcw size={14} />,
        onClick: () => {
          updateSetting("sidebar_section_order", "");
          if (settings.sidebar_nav_order) updateSetting("sidebar_nav_order", "");
        },
      });
    }

    return items;
  }, [
    ctxMenu,
    favoriteViewIds,
    settings,
    onOpenSettings,
    orderedSidebarItems,
    hasHiddenViews,
    updateSetting,
  ]);
}

/** Context menu items for right-clicking empty sidebar space. */
export function useSidebarEmptyContextMenu({
  position,
  onOpenProjectModal,
  onAddTask,
  onOpenSettings,
  settings,
  updateSetting,
}: {
  position: { x: number; y: number } | null;
  onOpenProjectModal?: () => void;
  onAddTask?: () => void;
  onOpenSettings?: () => void;
  settings: GeneralSettings;
  updateSetting: (key: keyof GeneralSettings, value: string) => void;
}) {
  return useMemo(() => {
    if (!position) return [];
    const items: Array<{
      id: string;
      label: string;
      icon?: ReactNode;
      separator?: boolean;
      disabled?: boolean;
      onClick?: () => void;
    }> = [];

    if (onOpenProjectModal) {
      items.push({
        id: "new-project",
        label: "New Project",
        icon: <FolderPlus size={14} />,
        onClick: onOpenProjectModal,
      });
    }

    if (onAddTask) {
      items.push({
        id: "add-task",
        label: "Add Task",
        icon: <ListPlus size={14} />,
        onClick: onAddTask,
      });
    }

    if (onOpenSettings) {
      items.push({
        id: "manage-sidebar",
        label: "Manage Sidebar",
        icon: <SlidersHorizontal size={14} />,
        separator: items.length > 0,
        onClick: onOpenSettings,
      });
    }

    if (settings.sidebar_section_order || settings.sidebar_nav_order) {
      items.push({
        id: "reset-order",
        label: "Reset Order",
        icon: <RotateCcw size={14} />,
        onClick: () => {
          updateSetting("sidebar_section_order", "");
          if (settings.sidebar_nav_order) updateSetting("sidebar_nav_order", "");
        },
      });
    }

    return items;
  }, [position, onOpenProjectModal, onAddTask, onOpenSettings, settings, updateSetting]);
}
