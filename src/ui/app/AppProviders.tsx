import type { ReactNode } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { TaskProvider } from "../context/TaskContext.js";
import { PluginProvider } from "../context/PluginContext.js";
import { AIProvider } from "../context/AIContext.js";
import { VoiceProvider } from "../context/VoiceContext.js";
import { UndoProvider } from "../context/UndoContext.js";
import { SettingsProvider } from "../context/SettingsContext.js";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <SettingsProvider>
        <TaskProvider>
          <PluginProvider>
            <AIProvider>
              <VoiceProvider>
                <UndoProvider>{children}</UndoProvider>
              </VoiceProvider>
            </AIProvider>
          </PluginProvider>
        </TaskProvider>
      </SettingsProvider>
    </ErrorBoundary>
  );
}
