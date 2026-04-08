import type { ReactNode } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { TaskProvider } from "../context/TaskContext.js";
import { PluginProvider } from "../context/PluginContext.js";
import { UndoProvider } from "../context/UndoContext.js";
import { SettingsProvider } from "../context/SettingsContext.js";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <SettingsProvider>
        <TaskProvider>
          <PluginProvider>
            <UndoProvider>{children}</UndoProvider>
          </PluginProvider>
        </TaskProvider>
      </SettingsProvider>
    </ErrorBoundary>
  );
}
