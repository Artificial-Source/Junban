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

  addPanel(panel: PanelRegistration): void {
    this.panels.set(panel.id, panel);
  }

  addView(view: ViewRegistration): void {
    this.views.set(view.id, view);
  }

  addStatusBarItem(item: StatusBarRegistration): StatusBarHandle {
    this.statusBarItems.set(item.id, item);
    return {
      update: (data) => {
        const existing = this.statusBarItems.get(item.id);
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
    const panel = this.panels.get(id);
    return panel?.getContent?.();
  }

  getViewContent(id: string): string | undefined {
    const view = this.views.get(id);
    return view?.getContent?.();
  }
}
