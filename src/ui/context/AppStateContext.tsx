import { createContext, useContext, type ReactNode } from "react";
import type { Task, Project as ProjectType, Section } from "../../core/types.js";
import type { ViewInfo } from "../api/plugins.js";
import type { View, CalendarMode } from "../hooks/useRouting.js";
import type { GeneralSettings } from "./SettingsContext.js";

/** Read-only app state shared across views via context. */
export interface AppState {
  currentView: View;
  projects: ProjectType[];
  selectedProjectId: string | null;
  selectedRouteTaskId: string | null;
  selectedPluginViewId: string | null;
  selectedFilterId: string | null;
  selectedTaskId: string | null;
  multiSelectedIds: Set<string>;
  featureSettings: GeneralSettings;
  pluginViews: ViewInfo[];
  calendarMode: CalendarMode | null;
  sections: Section[];
  availableTags: string[];
  tasks: Task[];
}

const AppStateContext = createContext<AppState | null>(null);

export function AppStateProvider({ value, children }: { value: AppState; children: ReactNode }) {
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}
