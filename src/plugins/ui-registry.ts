import { createLogger } from "../utils/logger.js";

const logger = createLogger("plugin-ui-registry");

/** A React component type — generic to avoid React import in shared module. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginComponent = (props: any) => any;

export interface PanelRegistration {
  id: string;
  pluginId: string;
  title: string;
  icon: string;
  contentType?: "text" | "react";
  component?: PluginComponent;
  getContent?: () => string;
}

export type ViewSlot = "navigation" | "tools" | "workspace";
export type ViewContentType = "text" | "structured" | "react";

export interface ViewRegistration {
  id: string;
  pluginId: string;
  name: string;
  icon: string;
  slot: ViewSlot;
  contentType: ViewContentType;
  component?: PluginComponent;
  getContent?: () => string;
}

export interface StatusBarRegistration {
  id: string;
  pluginId: string;
  text: string;
  icon: string;
  onClick?: () => void;
}

export interface StatusBarHandle {
  update: (data: { text?: string; icon?: string }) => void;
}

/**
 * UI registry — stores plugin-registered UI components.
 * Components are stored but not rendered yet (Sprint 4 wires to React).
 */
export class UIRegistry {
  private panels = new Map<string, PanelRegistration>();
  private views = new Map<string, ViewRegistration>();
  private statusBarItems = new Map<string, StatusBarRegistration>();

  private namespaceId(pluginId: string, id: string): string {
    const prefix = `${pluginId}:`;
    return id.startsWith(prefix) ? id : `${prefix}${id}`;
  }

  private resolveLookupId<T extends { id: string; pluginId: string }>(
    entries: Map<string, T>,
    id: string,
  ): string | undefined {
    if (entries.has(id)) return id;
    if (id.includes(":")) return undefined;

    const matching = Array.from(entries.values()).filter((entry) => {
      const prefix = `${entry.pluginId}:`;
      const localId = entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : entry.id;
      return localId === id;
    });

    if (matching.length === 1) {
      return matching[0].id;
    }

    if (matching.length > 1) {
      logger.warn(`Ambiguous bare UI registration id lookup: "${id}"`, {
        matches: matching.map((entry) => entry.id).join(","),
      });
    }

    return undefined;
  }

  addPanel(panel: PanelRegistration): void {
    const namespacedId = this.namespaceId(panel.pluginId, panel.id);
    this.panels.set(namespacedId, { ...panel, id: namespacedId });
  }

  addView(view: ViewRegistration): void {
    const namespacedId = this.namespaceId(view.pluginId, view.id);
    this.views.set(namespacedId, { ...view, id: namespacedId });
  }

  addStatusBarItem(item: StatusBarRegistration): StatusBarHandle {
    const namespacedId = this.namespaceId(item.pluginId, item.id);
    this.statusBarItems.set(namespacedId, { ...item, id: namespacedId });
    return {
      update: (data) => {
        const existing = this.statusBarItems.get(namespacedId);
        if (existing) {
          if (data.text !== undefined) existing.text = data.text;
          if (data.icon !== undefined) existing.icon = data.icon;
        }
      },
    };
  }

  removeByPlugin(pluginId: string): void {
    for (const [id, panel] of this.panels) {
      if (panel.pluginId === pluginId) this.panels.delete(id);
    }
    for (const [id, view] of this.views) {
      if (view.pluginId === pluginId) this.views.delete(id);
    }
    for (const [id, item] of this.statusBarItems) {
      if (item.pluginId === pluginId) this.statusBarItems.delete(id);
    }
  }

  getPanels(): PanelRegistration[] {
    return Array.from(this.panels.values());
  }

  getViews(): ViewRegistration[] {
    return Array.from(this.views.values());
  }

  getStatusBarItems(): StatusBarRegistration[] {
    return Array.from(this.statusBarItems.values());
  }

  getPanelContent(id: string): string | undefined {
    const resolvedId = this.resolveLookupId(this.panels, id);
    if (!resolvedId) return undefined;
    const panel = this.panels.get(resolvedId);
    return panel?.getContent?.();
  }

  getViewContent(id: string): string | undefined {
    const resolvedId = this.resolveLookupId(this.views, id);
    if (!resolvedId) return undefined;
    const view = this.views.get(resolvedId);
    return view?.getContent?.();
  }
}
