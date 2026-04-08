import { useCallback, type MutableRefObject, type Dispatch, type SetStateAction } from "react";
import { api, type AIChatMessage } from "../../api/index.js";
import {
  SAFETY_TIMEOUT_MS,
  TASK_MUTATING_TOOLS,
  DATA_MUTATING_TOOLS,
  parseStreamError,
} from "./ai-context-types.js";
import { dispatchAIDataMutatedEvent } from "../ai-events.js";

interface UseAISendMessageParams {
  voiceCallActiveRef: MutableRefObject<boolean>;
  lastUserMessageRef: MutableRefObject<string>;
  focusedTaskId: string | null;
  setMessages: Dispatch<SetStateAction<AIChatMessage[]>>;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  setDataMutationCount: Dispatch<SetStateAction<number>>;
  refreshTasks: () => void;
  refreshSessions: () => Promise<void>;
}

interface UseAISendMessageReturn {
  sendMessage: (text: string) => Promise<void>;
  restoreMessages: () => Promise<void>;
}

export function useAISendMessage({
  voiceCallActiveRef,
  lastUserMessageRef,
  focusedTaskId,
  setMessages,
  setIsStreaming,
  setDataMutationCount,
  refreshTasks,
  refreshSessions,
}: UseAISendMessageParams): UseAISendMessageReturn {
  const sendMessage = useCallback(
    async (text: string) => {
      lastUserMessageRef.current = text;
      setMessages((prev) => [...prev, { role: "user", content: text }]);
      setIsStreaming(true);
      let hadTaskMutation = false;
      let hadDataMutation = false;

      try {
        const stream = await api.sendChatMessage(text, {
          voiceCall: voiceCallActiveRef.current,
          focusedTaskId: focusedTaskId ?? undefined,
        });
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
                    dispatchAIDataMutatedEvent();
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
          dispatchAIDataMutatedEvent();
        }
        // Refresh sessions list (new session may have been created)
        refreshSessions();
      }
    },
    [
      voiceCallActiveRef,
      lastUserMessageRef,
      focusedTaskId,
      setMessages,
      setIsStreaming,
      setDataMutationCount,
      refreshTasks,
      refreshSessions,
    ],
  );

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
  }, [setMessages, refreshSessions]);

  return { sendMessage, restoreMessages };
}
