import { memo, useMemo } from "react";
import type { AIChatMessage } from "../../api/index.js";

interface SuggestedActionsProps {
  messages: AIChatMessage[];
  onSend: (text: string) => void;
  isStreaming: boolean;
}

const SUGGESTIONS_MAP: Record<string, string[]> = {
  create_task: ["Break it down", "Set a reminder", "Show my tasks"],
  complete_task: ["What's next?", "Show remaining"],
  analyze_workload: ["Plan my day", "Show overloaded days"],
  break_down_task: ["Show subtasks", "Set due dates"],
  query_tasks: ["Show overdue", "Organize by priority"],
  list_tasks: ["Show overdue", "Organize by priority"],
};

const DEFAULT_SUGGESTIONS = ["Plan my day", "What's overdue?", "Show my tasks"];

export const SuggestedActions = memo(function SuggestedActions({
  messages,
  onSend,
  isStreaming,
}: SuggestedActionsProps) {
  const suggestions = useMemo(() => {
    if (messages.length === 0) return [];

    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && !m.isError);
    if (!lastAssistant) return DEFAULT_SUGGESTIONS;

    const toolNames = lastAssistant.toolCalls?.map((tc) => tc.name) ?? [];

    // Find the first matching tool suggestion
    for (const name of toolNames) {
      if (SUGGESTIONS_MAP[name]) {
        return SUGGESTIONS_MAP[name];
      }
    }

    return DEFAULT_SUGGESTIONS;
  }, [messages]);

  if (isStreaming || messages.length === 0 || suggestions.length === 0) return null;

  // Only show after the last message is an assistant message
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant" || lastMsg.isError) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-1">
      {suggestions.map((text, i) => (
        <button
          key={text}
          onClick={() => onSend(text)}
          className="px-3 py-1.5 text-xs bg-surface-secondary text-on-surface-secondary rounded-full hover:bg-surface-tertiary transition-colors animate-fade-in"
          style={{ animationDelay: `${i * 50}ms` }}
        >
          {text}
        </button>
      ))}
    </div>
  );
});
