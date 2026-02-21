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

interface AIState {
  config: AIConfigInfo | null;
  messages: AIChatMessage[];
  isStreaming: boolean;
  isConfigured: boolean;
}

interface AIContextValue extends AIState {
  sendMessage: (text: string) => Promise<void>;
  clearChat: () => Promise<void>;
  restoreMessages: () => Promise<void>;
  updateConfig: (config: {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }) => Promise<void>;
  refreshConfig: () => Promise<void>;
  retryLastMessage: () => void;
  voiceCallActive: boolean;
  setVoiceCallMode: (active: boolean) => void;
  /** Increments when AI tools mutate projects/tags — watch this to refresh data */
  dataMutationCount: number;
  // Phase 5: Message actions
  editAndResend: (messageIndex: number, newText: string) => void;
  regenerateLastResponse: () => void;
  // Phase 6: Session management
  sessions: ChatSessionInfo[];
  activeSessionId: string | null;
  createNewSession: () => Promise<void>;
  switchSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
}

const AIContext = createContext<AIContextValue | null>(null);

const SAFETY_TIMEOUT_MS = 90_000;

function parseStreamError(data: string): {
  message: string;
  category: string;
  retryable: boolean;
} {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed.message === "string" && typeof parsed.category === "string") {
      return {
        message: parsed.message,
        category: parsed.category,
        retryable: !!parsed.retryable,
      };
    }
  } catch {
    // Plain string error (legacy format)
  }
  return { message: data, category: "unknown", retryable: true };
}

const TASK_MUTATING_TOOLS = new Set(["create_task", "complete_task", "update_task", "delete_task"]);

const DATA_MUTATING_TOOLS = new Set([
  "create_project",
  "update_project",
  "delete_project",
  "add_tags_to_task",
  "remove_tags_from_task",
]);

export function AIProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AIConfigInfo | null>(null);
  const [messages, setMessages] = useState<AIChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [voiceCallActive, setVoiceCallActive] = useState(false);
  const [dataMutationCount, setDataMutationCount] = useState(0);
  const [sessions, setSessions] = useState<ChatSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
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

  const restoreMessages = useCallback(async () => {
    try {
      const restored = await api.getChatMessages();
      if (restored.length > 0) {
        setMessages(restored.filter((m) => m.role !== "tool"));
      }
      // Load sessions list
      await refreshSessions();
    } catch {
      // Non-critical — chat history just won't be restored
    }
  }, [refreshSessions]);

  const sendMessage = useCallback(
    async (text: string) => {
      lastUserMessageRef.current = text;
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setIsStreaming(true);
      let hadTaskMutation = false;
      let hadDataMutation = false;

      try {
        const stream = await api.sendChatMessage(text, { voiceCall: voiceCallActiveRef.current });
        if (!stream) {
          setIsStreaming(false);
          return;
        }

        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let assistantContent = "";
        let toolCalls: AIChatMessage["toolCalls"] = [];
        let toolResults: AIChatMessage["toolResults"] = [];
        let buffer = "";
        let roundFinalized = false;

        // Safety timeout to prevent stuck spinner
        const safetyTimer = setTimeout(() => {
          reader.cancel().catch(() => {});
        }, SAFETY_TIMEOUT_MS);

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Parse SSE events from buffer
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const jsonStr = line.slice(6);
              if (!jsonStr) continue;

              try {
                const event = JSON.parse(jsonStr) as { type: string; data: string };

                if (event.type === "token") {
                  assistantContent += event.data;
                  const isNewRound = roundFinalized;
                  if (isNewRound) roundFinalized = false;
                  // Snapshot values so React batching doesn't read stale refs
                  const contentSnap = assistantContent;
                  const toolCallsSnap = [...toolCalls];
                  setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (!isNewRound && last?.role === "assistant" && !last.isError) {
                      return [
                        ...prev.slice(0, -1),
                        { ...last, content: contentSnap, toolCalls: toolCallsSnap },
                      ];
                    }
                    return [
                      ...prev,
                      { role: "assistant", content: contentSnap, toolCalls: toolCallsSnap },
                    ];
                  });
                } else if (event.type === "tool_call") {
                  // Capture tool calls for display as badges
                  try {
                    const calls = JSON.parse(event.data);
                    toolCalls = [...(toolCalls ?? []), ...calls];
                    const toolCallsSnap = [...toolCalls];
                    setMessages((prev) => {
                      const last = prev[prev.length - 1];
                      if (last?.role === "assistant" && !last.isError) {
                        return [...prev.slice(0, -1), { ...last, toolCalls: toolCallsSnap }];
                      }
                      return [
                        ...prev,
                        { role: "assistant", content: "", toolCalls: toolCallsSnap },
                      ];
                    });
                  } catch {
                    // Skip malformed tool call data
                  }
                } else if (event.type === "tool_result") {
                  // Track mutations for refresh and capture results
                  try {
                    const result = JSON.parse(event.data);
                    if (TASK_MUTATING_TOOLS.has(result.tool)) {
                      hadTaskMutation = true;
                    }
                    if (DATA_MUTATING_TOOLS.has(result.tool)) {
                      hadDataMutation = true;
                    }
                    // Store tool results on the current assistant message
                    toolResults = [
                      ...(toolResults ?? []),
                      { toolName: result.tool, data: result.result ?? "" },
                    ];
                    const toolResultsSnap = [...toolResults];
                    setMessages((prev) => {
                      const last = prev[prev.length - 1];
                      if (last?.role === "assistant" && !last.isError) {
                        return [...prev.slice(0, -1), { ...last, toolResults: toolResultsSnap }];
                      }
                      return prev;
                    });
                  } catch {
                    // Skip malformed tool result
                  }
                } else if (event.type === "done") {
                  // Refresh task list after tool round completes
                  if (hadTaskMutation) {
                    refreshTasks();
                  }
                  if (hadDataMutation) {
                    setDataMutationCount((c) => c + 1);
                  }
                  // Finalize current round — next tokens will start a new message
                  assistantContent = "";
                  toolCalls = [];
                  toolResults = [];
                  roundFinalized = true;
                } else if (event.type === "error") {
                  const { message, category, retryable } = parseStreamError(event.data);
                  setMessages((prev) => [
                    ...prev,
                    {
                      role: "assistant",
                      content: message,
                      isError: true,
                      errorCategory: category,
                      retryable,
                    },
                  ]);
                }
              } catch {
                // Skip malformed JSON
              }
            }
          }
        } finally {
          clearTimeout(safetyTimer);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to send message";
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: msg,
            isError: true,
            errorCategory: "network",
            retryable: true,
          },
        ]);
      } finally {
        setIsStreaming(false);
        // Safety-net refresh after stream ends to catch any missed mutations
        if (hadTaskMutation) {
          refreshTasks();
        }
        if (hadDataMutation) {
          setDataMutationCount((c) => c + 1);
        }
        // Refresh sessions list (new session may have been created)
        refreshSessions();
      }
    },
    [refreshTasks, refreshSessions],
  );

  const setVoiceCallMode = useCallback((active: boolean) => {
    setVoiceCallActive(active);
    voiceCallActiveRef.current = active;
  }, []);

  const retryLastMessage = useCallback(() => {
    const text = lastUserMessageRef.current;
    if (!text) return;

    // Remove trailing error + user messages
    setMessages((prev) => {
      const copy = [...prev];
      // Pop the error message
      if (copy.length > 0 && copy[copy.length - 1]?.isError) {
        copy.pop();
      }
      // Pop the user message that triggered it
      if (copy.length > 0 && copy[copy.length - 1]?.role === "user") {
        copy.pop();
      }
      return copy;
    });

    // Re-send after state update settles
    setTimeout(() => {
      sendMessage(text);
    }, 0);
  }, [sendMessage]);

  const editAndResend = useCallback(
    (messageIndex: number, newText: string) => {
      // Truncate history at the edit point and re-send
      setMessages((prev) => prev.slice(0, messageIndex));
      setTimeout(() => {
        sendMessage(newText);
      }, 0);
    },
    [sendMessage],
  );

  const regenerateLastResponse = useCallback(() => {
    // Remove the last assistant message and re-send the last user message
    setMessages((prev) => {
      const copy = [...prev];
      // Pop trailing assistant messages
      while (copy.length > 0 && copy[copy.length - 1]?.role === "assistant") {
        copy.pop();
      }
      // The last message should now be the user message — grab its text
      const lastUser = copy[copy.length - 1];
      if (lastUser?.role === "user") {
        lastUserMessageRef.current = lastUser.content;
      }
      return copy;
    });

    setTimeout(() => {
      const text = lastUserMessageRef.current;
      if (text) {
        // Remove the user message too, sendMessage will re-add it
        setMessages((prev) => {
          if (prev.length > 0 && prev[prev.length - 1]?.role === "user") {
            return prev.slice(0, -1);
          }
          return prev;
        });
        setTimeout(() => sendMessage(text), 0);
      }
    }, 0);
  }, [sendMessage]);

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

  // Session management
  const createNewSession = useCallback(async () => {
    await api.createNewChatSession();
    setMessages([]);
    setActiveSessionId(null);
    await refreshSessions();
  }, [refreshSessions]);

  const switchSession = useCallback(
    async (sessionId: string) => {
      try {
        const msgs = await api.switchChatSession(sessionId);
        setMessages(msgs.filter((m) => m.role !== "tool"));
        setActiveSessionId(sessionId);
      } catch {
        // Non-critical
      }
    },
    [],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      await api.deleteChatSession(sessionId);
      if (activeSessionId === sessionId) {
        setMessages([]);
        setActiveSessionId(null);
      }
      await refreshSessions();
    },
    [activeSessionId, refreshSessions],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      await api.renameChatSession(sessionId, title);
      await refreshSessions();
    },
    [refreshSessions],
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
