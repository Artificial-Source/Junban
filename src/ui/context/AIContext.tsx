import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { api, type AIConfigInfo, type AIChatMessage, type ChatSessionInfo } from "../api/index.js";
import { useTaskContext } from "./TaskContext.js";
import type { AIContextValue } from "./ai/ai-context-types.js";
import { useAISendMessage } from "./ai/useAISendMessage.js";
import { useAISessionManagement } from "./ai/useAISessionManagement.js";
import { useAIMessageActions } from "./ai/useAIMessageActions.js";

// Re-export types for backward compatibility
export type { AIState, AIContextValue } from "./ai/ai-context-types.js";

const AIContext = createContext<AIContextValue | null>(null);

export function AIProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AIConfigInfo | null>(null);
  const [messages, setMessages] = useState<AIChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [voiceCallActive, setVoiceCallActive] = useState(false);
  const [dataMutationCount, setDataMutationCount] = useState(0);
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const voiceCallActiveRef = useRef(false);
  const lastUserMessageRef = useRef<string>("");
  const { refreshTasks } = useTaskContext();

  // Dynamic check: provider is configured if it has an API key or doesn't need one
  // For built-in providers we check known names; for plugin providers,
  // we assume they handle their own key requirements
  const isConfigured = !!(
    config?.provider &&
    (config.hasApiKey ||
      config.provider === "ollama" ||
      config.provider === "lmstudio" ||
      config.provider.includes(":"))
  );

  const refreshConfig = useCallback(async () => {
    try {
      const cfg = await api.getAIConfig();
      setConfig(cfg);
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    refreshConfig();
  }, [refreshConfig]);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.listChatSessions();
      setSessions(list);
    } catch {
      // Non-critical
    }
  }, []);

  const { sendMessage, restoreMessages } = useAISendMessage({
    voiceCallActiveRef,
    lastUserMessageRef,
    focusedTaskId,
    setMessages,
    setIsStreaming,
    setDataMutationCount,
    refreshTasks,
    refreshSessions,
  });

  const { retryLastMessage, editAndResend, regenerateLastResponse } = useAIMessageActions({
    lastUserMessageRef,
    setMessages,
    sendMessage,
  });

  const { createNewSession, switchSession, deleteSession, renameSession } = useAISessionManagement({
    setMessages,
    setActiveSessionId,
    activeSessionId,
    refreshSessions,
  });

  const setVoiceCallMode = useCallback((active: boolean) => {
    setVoiceCallActive(active);
    voiceCallActiveRef.current = active;
  }, []);

  const clearChat = useCallback(async () => {
    await api.clearChat();
    setMessages([]);
    setActiveSessionId(null);
    await refreshSessions();
  }, [refreshSessions]);

  const updateConfig = useCallback(
    async (cfg: { provider?: string; apiKey?: string; model?: string; baseUrl?: string }) => {
      await api.updateAIConfig(cfg);
      await refreshConfig();
      setMessages([]);
    },
    [refreshConfig],
  );

  return (
    <AIContext.Provider
      value={{
        config,
        messages,
        isStreaming,
        isConfigured,
        sendMessage,
        clearChat,
        restoreMessages,
        updateConfig,
        refreshConfig,
        retryLastMessage,
        voiceCallActive,
        setVoiceCallMode,
        dataMutationCount,
        focusedTaskId,
        setFocusedTaskId,
        editAndResend,
        regenerateLastResponse,
        sessions,
        activeSessionId,
        createNewSession,
        switchSession,
        deleteSession,
        renameSession,
        refreshSessions,
      }}
    >
      {children}
    </AIContext.Provider>
  );
}

export function useAIContext(): AIContextValue {
  const context = useContext(AIContext);
  if (!context) {
    throw new Error("useAIContext must be used within an AIProvider");
  }
  return context;
}
