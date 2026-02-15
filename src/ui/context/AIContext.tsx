import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { api, type AIConfigInfo, type AIChatMessage } from "../api.js";

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

export function AIProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AIConfigInfo | null>(null);
  const [messages, setMessages] = useState<AIChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const lastUserMessageRef = useRef<string>("");

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

  const restoreMessages = useCallback(async () => {
    try {
      const restored = await api.getChatMessages();
      if (restored.length > 0) {
        setMessages(restored.filter((m) => m.role !== "tool"));
      }
    } catch {
      // Non-critical — chat history just won't be restored
    }
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    lastUserMessageRef.current = text;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsStreaming(true);

    try {
      const stream = await api.sendChatMessage(text);
      if (!stream) {
        setIsStreaming(false);
        return;
      }

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";
      let toolCalls: AIChatMessage["toolCalls"] = [];
      let buffer = "";

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
                // Update the assistant message in real-time
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last?.role === "assistant" && !last.isError) {
                    return [
                      ...prev.slice(0, -1),
                      { ...last, content: assistantContent, toolCalls },
                    ];
                  }
                  return [...prev, { role: "assistant", content: assistantContent, toolCalls }];
                });
              } else if (event.type === "tool_call") {
                // Capture tool calls for display as badges
                try {
                  const calls = JSON.parse(event.data);
                  toolCalls = [...(toolCalls ?? []), ...calls];
                  setMessages((prev) => {
                    const last = prev[prev.length - 1];
                    if (last?.role === "assistant" && !last.isError) {
                      return [...prev.slice(0, -1), { ...last, toolCalls }];
                    }
                    return [...prev, { role: "assistant", content: "", toolCalls }];
                  });
                } catch {
                  // Skip malformed tool call data
                }
              } else if (event.type === "done") {
                // On done, reset accumulators for next tool-call round
                assistantContent = "";
                toolCalls = [];
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
    }
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

  const clearChat = useCallback(async () => {
    await api.clearChat();
    setMessages([]);
  }, []);

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
