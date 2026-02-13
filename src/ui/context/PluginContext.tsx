import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import {
  api,
  type PluginInfo,
  type PluginCommandInfo,
  type StatusBarItemInfo,
  type PanelInfo,
  type ViewInfo,
} from "../api.js";

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
      const data = await api.listPlugins();
      if (mountedRef.current) setPlugins(data);
    } catch {
      // Non-critical
    }
  }, []);

  const refreshCommands = useCallback(async () => {
    try {
      const data = await api.listPluginCommands();
      if (mountedRef.current) setCommands(data);
    } catch {
      // Non-critical
    }
  }, []);

  const refreshStatusBar = useCallback(async () => {
    try {
      const data = await api.getStatusBarItems();
      if (mountedRef.current) setStatusBarItems(data);
    } catch {
      // Non-critical
    }
  }, []);

  const refreshPanels = useCallback(async () => {
    try {
      const data = await api.getPluginPanels();
      if (mountedRef.current) setPanels(data);
    } catch {
      // Non-critical
    }
  }, []);

  const refreshViews = useCallback(async () => {
    try {
      const data = await api.getPluginViews();
      if (mountedRef.current) setViews(data);
    } catch {
      // Non-critical
    }
  }, []);

  const executeCommand = useCallback(async (id: string) => {
    await api.executePluginCommand(id);
    // Refresh relevant state after command execution
    await Promise.all([refreshStatusBar(), refreshPanels()]);
  }, [refreshStatusBar, refreshPanels]);

  // Initial fetch
  useEffect(() => {
    refreshPlugins();
    refreshCommands();
    refreshStatusBar();
    refreshPanels();
    refreshViews();
  }, [refreshPlugins, refreshCommands, refreshStatusBar, refreshPanels, refreshViews]);

  // Poll status bar and panels every 1s for live data
  useEffect(() => {
    const interval = setInterval(() => {
      refreshStatusBar();
      refreshPanels();
    }, 1000);
    return () => clearInterval(interval);
  }, [refreshStatusBar, refreshPanels]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return (
    <PluginContext.Provider
      value={{
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
      }}
    >
      {children}
    </PluginContext.Provider>
  );
}

export function usePluginContext() {
  const ctx = useContext(PluginContext);
  if (!ctx) throw new Error("usePluginContext must be used within PluginProvider");
  return ctx;
}
