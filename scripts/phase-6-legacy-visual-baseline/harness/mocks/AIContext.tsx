import { createContext, useContext, useMemo, type ReactNode } from "react";
import { FIXTURE_COPY, readFixture } from "./read-fixture";

export interface AIConfigInfo {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  authType?: "api-key" | "oauth";
  hasOAuthToken?: boolean;
}

export interface AIChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolResults?: { toolName: string; data: string }[];
  isError?: boolean;
  errorCategory?: string;
  retryable?: boolean;
}

export interface ChatSessionInfo {
  sessionId: string;
  title: string;
  createdAt: string;
  messageCount: number;
}

export type AIContextValue = {
  config: AIConfigInfo | null;
  isConfigured: boolean;
  messages: AIChatMessage[];
  isStreaming: boolean;
  sendMessage: (text: string) => void;
  clearChat: () => void;
  restoreMessages: () => void;
  retryLastMessage: () => void;
  setVoiceCallMode: (active: boolean) => void;
  editAndResend: (index: number, text: string) => void;
  regenerateLastResponse: () => void;
  sessions: ChatSessionInfo[];
  activeSessionId: string | null;
  createNewSession: () => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  focusedTaskId: string | null;
  setFocusedTaskId: (id: string | null) => void;
  updateConfig: (patch: Record<string, unknown>) => Promise<void>;
  refreshConfig: () => Promise<void>;
  dataMutationCount: number;
};

const AIContext = createContext<AIContextValue | null>(null);

function noop() {}
async function asyncNoop() {}

function buildMessages(scene: string): AIChatMessage[] {
  if (
    scene === "ai-conversation-tools-desktop-light" ||
    scene === "focused-task-launch-desktop-light"
  ) {
    return [
      {
        role: "user",
        content:
          scene === "focused-task-launch-desktop-light"
            ? `Help me with this task: ${FIXTURE_COPY.focusedTaskTitle}`
            : FIXTURE_COPY.userPrompt,
      },
      {
        role: "assistant",
        content: FIXTURE_COPY.assistantText,
        toolCalls: [
          {
            id: "call_plan_1",
            name: "plan_my_day",
            arguments: JSON.stringify({ energy: "medium" }),
          },
          {
            id: "call_create_1",
            name: "create_task",
            arguments: JSON.stringify({ title: FIXTURE_COPY.toolTaskTitle, priority: 2 }),
          },
        ],
        toolResults: [
          {
            toolName: "plan_my_day",
            data: JSON.stringify({
              workload: {
                totalToday: 3,
                priorityWeight: 6,
                assessment: "moderate",
                overdueCount: 1,
              },
              overdueTasks: [
                {
                  title: "Publish plugin author guide",
                  daysOverdue: 3,
                  priority: 2,
                },
              ],
              focusBlocks: {
                order: "energy",
                blocks: [
                  {
                    type: "deep_work",
                    tasks: [{ title: FIXTURE_COPY.toolTaskTitle, priority: 2 }],
                  },
                  {
                    type: "quick_win",
                    tasks: [{ title: "Triage inbox notes", priority: 3 }],
                  },
                ],
              },
              remindersToday: [],
              productivityContext: {
                insight: "Morning focus blocks clear the highest-priority work first.",
                recentCompletionRate: 0.72,
              },
            }),
          },
          {
            toolName: "create_task",
            data: JSON.stringify({
              task: {
                id: "task_demo_created",
                title: FIXTURE_COPY.toolTaskTitle,
                status: "pending",
                priority: 2,
                dueDate: "2026-08-02",
              },
            }),
          },
        ],
      },
    ];
  }
  return [];
}

function buildSessions(scene: string): ChatSessionInfo[] {
  if (
    scene === "ai-chat-history-desktop-light" ||
    scene === "ai-conversation-tools-desktop-light" ||
    scene === "focused-task-launch-desktop-light"
  ) {
    const base = Date.parse("2026-08-02T15:00:00.000Z");
    return FIXTURE_COPY.sessionTitles.map((title, index) => ({
      sessionId: `session_demo_${index + 1}`,
      title,
      createdAt: new Date(base - index * 3_600_000).toISOString(),
      messageCount: 4 + index * 2,
    }));
  }
  return [];
}

export function AIProvider({ children }: { children: ReactNode }) {
  const fixture = readFixture();
  const value = useMemo<AIContextValue>(() => {
    const config: AIConfigInfo | null = {
      provider: fixture.aiConfigured ? fixture.aiProvider || "openai" : fixture.aiProvider || null,
      model: fixture.aiConfigured ? fixture.aiModel || "gpt-4o" : fixture.aiModel || null,
      baseUrl: null,
      hasApiKey: fixture.aiHasApiKey,
      authType: "api-key",
      hasOAuthToken: false,
    };

    const isConfigured = !!(
      config.provider &&
      (config.hasApiKey || config.provider === "ollama" || config.provider === "lmstudio")
    );

    return {
      config,
      isConfigured: fixture.aiConfigured || isConfigured,
      messages: buildMessages(fixture.scene),
      isStreaming: false,
      sendMessage: noop,
      clearChat: noop,
      restoreMessages: noop,
      retryLastMessage: noop,
      setVoiceCallMode: noop,
      editAndResend: noop,
      regenerateLastResponse: noop,
      sessions: buildSessions(fixture.scene),
      activeSessionId: buildSessions(fixture.scene)[0]?.sessionId ?? null,
      createNewSession: noop,
      switchSession: noop,
      deleteSession: noop,
      renameSession: noop,
      focusedTaskId:
        fixture.scene === "focused-task-launch-desktop-light" ? FIXTURE_COPY.focusedTaskId : null,
      setFocusedTaskId: noop,
      updateConfig: asyncNoop,
      refreshConfig: asyncNoop,
      dataMutationCount: 0,
    };
  }, [fixture]);

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
}

export function useAIContext(): AIContextValue {
  const ctx = useContext(AIContext);
  if (!ctx) {
    throw new Error("useAIContext requires AIProvider in the Phase 6 harness");
  }
  return ctx;
}
