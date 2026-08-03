import { memo, useMemo } from "react";
import type { ChatMessageView } from "../message-view";

const SUGGESTIONS_MAP: Record<string, string[]> = {
  create_task: ["Break it down", "Set a reminder", "Show my tasks"],
  complete_task: ["What's next?", "Show remaining"],
  analyze_workload: ["Plan my day", "Show overloaded days"],
  break_down_task: ["Show subtasks", "Set due dates"],
  query_tasks: ["Show overdue", "Organize by priority"],
  bulk_create_tasks: ["Show what was created", "Organize by project"],
  bulk_complete_tasks: ["What's next?", "Show remaining"],
  bulk_update_tasks: ["Show updated tasks", "What's left?"],
  plan_my_day: ["Break down my top task", "What if I have low energy?"],
  daily_review: ["Plan tomorrow", "Show my streak"],
  weekly_review: ["Plan my week", "Show overloaded days"],
  save_memory: ["What else should I remember?", "Show my tasks"],
};

const DEFAULT_SUGGESTIONS = ["Plan my day", "What's overdue?", "Show my tasks"];

export const SuggestedActions = memo(function SuggestedActions({
  messages,
  onSend,
  isStreaming,
}: {
  messages: ChatMessageView[];
  onSend: (text: string) => void;
  isStreaming: boolean;
}) {
  const suggestions = useMemo(() => {
    if (messages.length === 0) return [];
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && !m.isError);
    if (!lastAssistant) return DEFAULT_SUGGESTIONS;

    const toolNames = lastAssistant.segments
      .filter((s) => s.kind === "tool_badge" || s.kind === "tool_proposed")
      .map((s) => (s.kind === "tool_badge" ? s.tool : s.proposal.tool));

    for (const name of toolNames) {
      if (SUGGESTIONS_MAP[name]) return SUGGESTIONS_MAP[name];
    }
    return DEFAULT_SUGGESTIONS;
  }, [messages]);

  if (isStreaming || messages.length === 0 || suggestions.length === 0) return null;

  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== "assistant" || lastMsg.isError) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-1">
      {suggestions.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => onSend(text)}
          className="px-3 py-1.5 text-xs bg-surface-secondary text-on-surface-secondary rounded-lg border border-border/50 hover:bg-surface-tertiary hover:border-border transition-colors"
        >
          {text}
        </button>
      ))}
    </div>
  );
});
