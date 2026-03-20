import { useRef, useEffect } from "react";
import { AIChatPanel } from "../components/AIChatPanel.js";
import { useAIContext } from "../context/AIContext.js";
import { api } from "../api/index.js";

interface AIChatViewProps {
  onOpenSettings: () => void;
  onSelectTask?: (taskId: string) => void;
}

export function AIChat({ onOpenSettings, onSelectTask }: AIChatViewProps) {
  // Auto-manage LM Studio models when AI Chat view is active
  const autoLoadedModelRef = useRef<string | null>(null);
  const { config: aiConfig } = useAIContext();

  useEffect(() => {
    const autoManage = window.localStorage.getItem("saydo.ai.auto-manage-lmstudio") === "1";
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
      <AIChatPanel
        onClose={() => {}}
        onOpenSettings={onOpenSettings}
        onSelectTask={onSelectTask}
        mode="view"
      />
    </div>
  );
}
