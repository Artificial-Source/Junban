import { memo } from "react";
import { AlertTriangle, RotateCcw, Bot } from "lucide-react";
import { ToolCallBadge } from "./ToolCallBadge.js";
import { MarkdownMessage } from "./MarkdownMessage.js";
import { ChatToolResultCard } from "./ChatToolResultCard.js";
import { ChatTaskCard } from "../ChatTaskCard.js";
import { MessageActions } from "./MessageActions.js";
import type { AIChatMessage } from "../../api/index.js";

interface MessageBubbleProps {
  message: AIChatMessage;
  onRetry?: () => void;
  onSelectTask?: (taskId: string) => void;
  isLatest?: boolean;
  isStreaming?: boolean;
  mode?: "panel" | "view";
  messageIndex?: number;
  onEditAndResend?: (index: number, newText: string) => void;
  onRegenerate?: () => void;
}

function getErrorHint(category?: string, message?: string): string | null {
  switch (category) {
    case "auth":
      return "Check your API key in Settings.";
    case "rate_limit":
      return "You've hit the rate limit. Wait a moment.";
    case "network":
      if (message?.includes("LM Studio") || message?.includes("Ollama")) {
        return null;
      }
      return "Check your network connection and provider settings.";
    case "server":
      return "The provider is having issues. Try again in a moment.";
    case "timeout":
      return "The response took too long. Try a simpler question or check the provider.";
    default:
      return null;
  }
}

function extractTasksFromMessage(
  msg: AIChatMessage,
): {
  id: string;
  title: string;
  status?: string;
  priority?: number | null;
  dueDate?: string | null;
}[] {
  const taskToolNames = new Set(["create_task", "update_task", "complete_task"]);
  const toolCalls = msg.toolCalls;
  const toolResults = msg.toolResults;
  if (!toolCalls || toolCalls.length === 0) return [];

  const resultByTool = new Map<string, Record<string, unknown>>();
  if (toolResults) {
    for (const tr of toolResults) {
      if (!taskToolNames.has(tr.toolName)) continue;
      try {
        resultByTool.set(tr.toolName, JSON.parse(tr.data));
      } catch {
        /* skip */
      }
    }
  }

  const tasks: {
    id: string;
    title: string;
    status?: string;
    priority?: number | null;
    dueDate?: string | null;
  }[] = [];

  for (const tc of toolCalls) {
    if (!taskToolNames.has(tc.name)) continue;
    try {
      const args = JSON.parse(tc.arguments);
      const result = resultByTool.get(tc.name) as Record<string, unknown> | undefined;
      const resultTask = result?.task as Record<string, unknown> | undefined;
      const id =
        (resultTask?.id as string) ??
        (result?.taskId as string) ??
        args.taskId ??
        "";
      const title =
        (resultTask?.title as string) ??
        args.title ??
        tc.name.replace(/_/g, " ");
      if (title || id) {
        tasks.push({
          id,
          title,
          priority: (resultTask?.priority as number) ?? args.priority ?? null,
          dueDate: (resultTask?.dueDate as string) ?? args.dueDate ?? null,
          status:
            (resultTask?.status as string) ??
            (tc.name === "complete_task" ? "completed" : "pending"),
        });
      }
    } catch {
      /* skip */
    }
  }
  return tasks;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  onRetry,
  onSelectTask,
  isLatest = false,
  isStreaming = false,
  mode = "panel",
  messageIndex,
  onEditAndResend,
  onRegenerate,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isTool = message.role === "tool";
  const isView = mode === "view";
  const avatarSize = isView ? 28 : 24;
  const iconSize = isView ? 14 : 12;

  if (isTool) return null;

  const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;

  if (message.isError) {
    const hint = getErrorHint(message.errorCategory, message.content);
    return (
      <div className="flex items-start gap-2 animate-message-enter">
        <div
          className="shrink-0 rounded-full bg-error/10 text-error flex items-center justify-center"
          style={{ width: avatarSize, height: avatarSize }}
        >
          <AlertTriangle size={iconSize} />
        </div>
        <div className="max-w-[85%] space-y-1">
          <div className="px-3 py-2 rounded-lg text-sm bg-error/10 border border-error/20 text-error">
            <div className="min-w-0">
              <p>{message.content}</p>
              {hint && <p className="text-xs mt-1 opacity-80">{hint}</p>}
            </div>
            {onRetry && (
              <button
                onClick={onRetry}
                className="mt-2 flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md bg-error/10 hover:bg-error/20 transition-colors"
              >
                <RotateCcw size={12} />
                Retry
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const inlineTasks = extractTasksFromMessage(message);
  const hasRichToolResults = message.toolResults && message.toolResults.length > 0;
  const animClass = isLatest ? "animate-message-enter" : "";

  if (isUser) {
    return (
      <div className={`flex justify-end group ${animClass}`}>
        <div className="max-w-[85%] space-y-1 relative">
          <MessageActions
            message={message}
            isUser
            messageIndex={messageIndex}
            onEditAndResend={onEditAndResend}
          />
          <div className="px-3 py-2 rounded-lg text-sm bg-accent text-white">
            <span className="whitespace-pre-wrap">{message.content}</span>
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className={`flex items-start gap-2 group ${animClass}`}>
      <div
        className={`shrink-0 rounded-full bg-accent/10 text-accent flex items-center justify-center mt-0.5 ${
          isLatest && isStreaming ? "animate-pulse" : ""
        }`}
        style={{ width: avatarSize, height: avatarSize }}
      >
        <Bot size={iconSize} />
      </div>
      <div className="max-w-[85%] space-y-1 relative min-w-0">
        <MessageActions
          message={message}
          isUser={false}
          isLastAssistant={isLatest}
          onRegenerate={onRegenerate}
        />
        {hasToolCalls && (
          <div className="flex flex-wrap gap-1">
            {message.toolCalls!.map((tc) => (
              <ToolCallBadge key={tc.id} name={tc.name} args={tc.arguments} />
            ))}
          </div>
        )}
        {hasRichToolResults && (
          <ChatToolResultCard toolResults={message.toolResults!} onSelectTask={onSelectTask} />
        )}
        {inlineTasks.length > 0 && onSelectTask && (
          <div className="space-y-1">
            {inlineTasks.map((task, i) => (
              <ChatTaskCard
                key={task.id || i}
                task={task}
                onClick={onSelectTask}
              />
            ))}
          </div>
        )}
        {message.content && (
          <div className="px-3 py-2 rounded-lg text-sm bg-surface-tertiary text-on-surface">
            <MarkdownMessage content={message.content} onSelectTask={onSelectTask} />
          </div>
        )}
      </div>
    </div>
  );
});
