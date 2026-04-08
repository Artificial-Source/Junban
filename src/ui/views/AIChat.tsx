import { lazy, Suspense, useRef, useEffect } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { useAIContext } from "../context/AIContext.js";
import { AIVoiceFeatureProviders } from "../context/AIVoiceFeatureProviders.js";
import { useAppState } from "../context/AppStateContext.js";
import { api } from "../api/index.js";

const AIChatPanel = lazy(() =>
  import("../components/AIChatPanel.js").then((module) => ({ default: module.AIChatPanel })),
);

interface AIChatViewProps {
  onOpenSettings: () => void;
  onSelectTask?: (taskId: string) => void;
}

export function AIChat({ onOpenSettings, onSelectTask }: AIChatViewProps) {
  return (
    <AIVoiceFeatureProviders>
      <AIChatContent onOpenSettings={onOpenSettings} onSelectTask={onSelectTask} />
    </AIVoiceFeatureProviders>
  );
}

function AIChatContent({ onOpenSettings, onSelectTask }: AIChatViewProps) {
  // Auto-manage LM Studio models when AI Chat view is active
  const autoLoadedModelRef = useRef<string | null>(null);
  const { config: aiConfig } = useAIContext();
  const { selectedTaskId } = useAppState();

  useEffect(() => {
    const autoManage = window.localStorage.getItem("junban.ai.auto-manage-lmstudio") === "1";
    if (!autoManage || aiConfig?.provider !== "lmstudio" || !aiConfig.model) return;

    // Auto-load model when view mounts
    api
      .loadModel("lmstudio", aiConfig.model)
      .then(() => {
        autoLoadedModelRef.current = aiConfig.model;
      })
      .catch((err: unknown) => console.warn("[ai-chat] Failed to auto-load model:", err));

    return () => {
      // Auto-unload model when view unmounts
      if (autoLoadedModelRef.current) {
        const modelToUnload = autoLoadedModelRef.current;
        autoLoadedModelRef.current = null;
        api
          .unloadModel("lmstudio", modelToUnload)
          .catch((err: unknown) => console.warn("[ai-chat] Failed to unload model:", err));
      }
    };
  }, [aiConfig]);

  return (
    <div className="h-full w-full">
      <ErrorBoundary
        fallback={
          <div className="flex items-center justify-center h-full text-on-surface-secondary">
            AI Chat encountered an error. Please try refreshing.
          </div>
        }
      >
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-on-surface-secondary">
              Loading AI chat...
            </div>
          }
        >
          <AIChatPanel
            onClose={() => {}}
            onOpenSettings={onOpenSettings}
            onSelectTask={onSelectTask}
            focusedTaskId={selectedTaskId}
            mode="view"
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
