import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import {
  executePluginCommand,
  getPluginPanels,
  getPluginViews,
  getStatusBarItems,
  listPluginCommands,
  listPlugins,
  type PluginInfo,
  type PluginCommandInfo,
  type StatusBarItemInfo,
  type PanelInfo,
  type ViewInfo,
} from "../api/plugins.js";

interface PluginContextValue {
  plugins: PluginInfo[];
  commands: PluginCommandInfo[];
  statusBarItems: StatusBarItemInfo[];
  panels: PanelInfo[];
  views: ViewInfo[];
  refreshPlugins: () => Promise<void>;
  refreshCommands: () => Promise<void>;
  refreshStatusBar: () => Promise<void>;
  refreshPanels: () => Promise<void>;
  refreshViews: () => Promise<void>;
  executeCommand: (id: string) => Promise<void>;
}

const PluginContext = createContext<PluginContextValue | null>(null);

export function PluginProvider({ children }: { children: React.ReactNode }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [commands, setCommands] = useState<PluginCommandInfo[]>([]);
  const [statusBarItems, setStatusBarItems] = useState<StatusBarItemInfo[]>([]);
  const [panels, setPanels] = useState<PanelInfo[]>([]);
  const [views, setViews] = useState<ViewInfo[]>([]);
  const mountedRef = useRef(true);

  const refreshPlugins = useCallback(async () => {
    try {
      const data = await listPlugins();
      if (mountedRef.current) setPlugins(data);
    } catch {
      // Non-critical
    }
  }, []);

  const refreshCommands = useCallback(async () => {
    try {
      const data = await listPluginCommands();
      if (mountedRef.current) setCommands(data);
    } catch {
      // Non-critical
    }
  }, []);

  const refreshStatusBar = useCallback(async () => {
    try {
      const data = await getStatusBarItems();
      if (mountedRef.current) setStatusBarItems(data);
    } catch {
      // Non-critical
    }
  }, []);

  const refreshPanels = useCallback(async () => {
    try {
      const data = await getPluginPanels();
      if (mountedRef.current) setPanels(data);
    } catch {
      // Non-critical
    }
  }, []);

  const refreshViews = useCallback(async () => {
    try {
      const data = await getPluginViews();
      if (mountedRef.current) setViews(data);
    } catch {
      // Non-critical
    }
  }, []);

  const executeCommand = useCallback(
    async (id: string) => {
      await executePluginCommand(id);
      // Refresh relevant state after command execution
      await Promise.all([refreshStatusBar(), refreshPanels()]);
    },
    [refreshStatusBar, refreshPanels],
  );

  // Initial fetch — reset mountedRef on mount to handle StrictMode double-mount
  useEffect(() => {
    mountedRef.current = true;
    refreshPlugins();
    refreshViews();

    const scheduleDeferredFetches = () => {
      refreshCommands();
      refreshStatusBar();
      refreshPanels();
    };

    let idleHandle: number | null = null;
    let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | null = null;
    let didRun = false;

    const runOnce = () => {
      if (didRun) return;
      didRun = true;
      if (timeoutHandle !== null) {
        globalThis.clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      scheduleDeferredFetches();
    };

    timeoutHandle = globalThis.setTimeout(runOnce, 300);

    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      idleHandle = window.requestIdleCallback(runOnce, { timeout: 1500 });
    }

    return () => {
      mountedRef.current = false;
      if (idleHandle !== null && typeof window !== "undefined" && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) {
        globalThis.clearTimeout(timeoutHandle);
      }
    };
  }, [refreshPlugins, refreshCommands, refreshStatusBar, refreshPanels, refreshViews]);

  // Poll status bar and panels every 30s for live data
  useEffect(() => {
    const interval = setInterval(() => {
      refreshStatusBar();
      refreshPanels();
    }, 30000);
    return () => clearInterval(interval);
  }, [refreshStatusBar, refreshPanels]);

  const value = useMemo(
    () => ({
      plugins,
      commands,
      statusBarItems,
      panels,
      views,
      refreshPlugins,
      refreshCommands,
      refreshStatusBar,
      refreshPanels,
      refreshViews,
      executeCommand,
    }),
    [
      plugins,
      commands,
      statusBarItems,
      panels,
      views,
      refreshPlugins,
      refreshCommands,
      refreshStatusBar,
      refreshPanels,
      refreshViews,
      executeCommand,
    ],
  );

  return <PluginContext.Provider value={value}>{children}</PluginContext.Provider>;
}

export function usePluginContext() {
  const ctx = useContext(PluginContext);
  if (!ctx) throw new Error("usePluginContext must be used within PluginProvider");
  return ctx;
}

export function useOptionalPluginContext() {
  return useContext(PluginContext);
}
