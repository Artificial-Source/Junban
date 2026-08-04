import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  FIXTURE_COPY,
  fixtureInstalledPlugins,
  readFixture,
  type PluginLoadMode,
} from "./read-fixture";

export type PluginResourceStatus = "loading" | "ready" | "error";
export type PluginResourceKey = "plugins" | "commands" | "statusBar" | "panels" | "views";

export interface PluginResourceState {
  status: PluginResourceStatus;
  hasData: boolean;
  error: string | null;
}

export type PluginResourceStates = Record<PluginResourceKey, PluginResourceState>;

export interface PluginReconciliationState {
  message: string;
  error: string | null;
}

interface PluginContextValue {
  plugins: ReturnType<typeof fixtureInstalledPlugins>;
  commands: { id: string; name: string; hotkey?: string }[];
  statusBarItems: {
    id: string;
    text: string;
    icon: string;
    onClick?: () => void;
  }[];
  panels: {
    id: string;
    pluginId: string;
    title: string;
    icon: string;
    content: string;
    contentType?: "text" | "react";
  }[];
  views: {
    id: string;
    name: string;
    icon: string;
    slot: "navigation" | "tools" | "workspace";
    contentType: "text" | "structured" | "react";
    pluginId: string;
  }[];
  resourceStates: PluginResourceStates;
  reconciliationState: PluginReconciliationState | null;
  refreshPlugins: () => Promise<void>;
  refreshCommands: () => Promise<void>;
  refreshStatusBar: () => Promise<void>;
  refreshPanels: () => Promise<void>;
  refreshViews: () => Promise<void>;
  reconcileAppliedMutation: (message: string) => Promise<void>;
  retryPluginReconciliation: () => Promise<void>;
  executeCommand: (id: string) => Promise<void>;
}

const PluginContext = createContext<PluginContextValue | null>(null);

function resourceFor(mode: PluginLoadMode, errorText: string): PluginResourceState {
  if (mode === "loading") {
    return { status: "loading", hasData: false, error: null };
  }
  if (mode === "error") {
    return { status: "error", hasData: false, error: errorText };
  }
  return { status: "ready", hasData: true, error: null };
}

async function asyncNoop() {}

export function PluginProvider({ children }: { children: ReactNode }) {
  const value = useMemo<PluginContextValue>(() => {
    const fixture = readFixture();
    const pluginState = resourceFor(fixture.pluginLoadMode, FIXTURE_COPY.extensionsLoadError);
    const ready = resourceFor("ready", "");
    return {
      plugins:
        fixture.pluginLoadMode === "ready" && !fixture.emptyInstalledPlugins
          ? fixtureInstalledPlugins()
          : [],
      commands: [
        { id: "pomodoro:start", name: "Pomodoro: Start" },
        { id: "pomodoro:pause", name: "Pomodoro: Pause" },
        { id: "example:run-plan", name: "Run plan" },
      ],
      statusBarItems: [
        {
          id: "pomodoro-timer",
          text: FIXTURE_COPY.statusReady,
          icon: "timer",
          onClick: () => undefined,
        },
      ],
      panels: [
        {
          id: "example-panel",
          pluginId: "example-plugin",
          title: FIXTURE_COPY.panelTitle,
          icon: "puzzle",
          content: "",
          contentType: "text",
        },
      ],
      views: [
        {
          id: "pomodoro",
          name: "Pomodoro",
          icon: "timer",
          slot: "tools",
          contentType: "structured",
          pluginId: "pomodoro",
        },
      ],
      resourceStates: {
        plugins: pluginState,
        commands: ready,
        statusBar: ready,
        panels: ready,
        views: ready,
      },
      reconciliationState: null,
      refreshPlugins: asyncNoop,
      refreshCommands: asyncNoop,
      refreshStatusBar: asyncNoop,
      refreshPanels: asyncNoop,
      refreshViews: asyncNoop,
      reconcileAppliedMutation: asyncNoop,
      retryPluginReconciliation: asyncNoop,
      executeCommand: asyncNoop,
    };
  }, []);

  return <PluginContext.Provider value={value}>{children}</PluginContext.Provider>;
}

export function usePluginContext(): PluginContextValue {
  const ctx = useContext(PluginContext);
  if (!ctx) {
    throw new Error("usePluginContext requires PluginProvider");
  }
  return ctx;
}
