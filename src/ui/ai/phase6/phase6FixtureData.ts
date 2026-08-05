/**
 * Presentation-only Phase 6 fixture view-models.
 * Never touches network, credentials, mic, models, or workers.
 */

import type { ChatMessageView, ChatSessionView } from "../message-view";
import type { WelcomeStats } from "../chat";
import {
  PHASE6_FIXTURE_COPY,
  PHASE6_FIXED_CLOCK,
  type Phase6SceneId,
} from "../../lib/phase6VisualFixture";
import {
  FIXTURE_CALL_LISTENING,
  FIXTURE_CALL_PROCESSING,
  FIXTURE_CALL_RECOGNITION_ERROR,
  FIXTURE_CALL_SPEAKING,
  FIXTURE_PTT_ERROR,
  FIXTURE_PTT_LISTENING,
  FIXTURE_PTT_TRANSCRIBING,
  FIXTURE_VAD_GRACE,
  type VoiceFixture,
} from "../../voice";

const CLOCK_MS = Date.parse(PHASE6_FIXED_CLOCK);

export const PHASE6_WELCOME_STATS: WelcomeStats = {
  overdueCount: 1,
  todayCount: 2,
  pendingCount: 4,
};

function planMyDayData(): Record<string, unknown> {
  return {
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
          tasks: [{ title: PHASE6_FIXTURE_COPY.toolTaskTitle, priority: 2 }],
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
  };
}

function createTaskData(): Record<string, unknown> {
  return {
    task: {
      id: "task_demo_created",
      title: PHASE6_FIXTURE_COPY.toolTaskTitle,
      status: "pending",
      priority: 2,
      dueDate: "2026-08-02",
    },
  };
}

/** Conversation + focused-task assistant/user messages with tool cards. */
export function phase6ConversationMessages(scene: Phase6SceneId): ChatMessageView[] {
  if (
    scene !== "ai-conversation-tools-desktop-light" &&
    scene !== "focused-task-launch-desktop-light"
  ) {
    return [];
  }

  const userText =
    scene === "focused-task-launch-desktop-light"
      ? `Help me with this task: ${PHASE6_FIXTURE_COPY.focusedTaskTitle}`
      : PHASE6_FIXTURE_COPY.userPrompt;

  return [
    {
      id: "msg_user_1",
      role: "user",
      status: "completed",
      text: userText,
      createdAt: new Date(CLOCK_MS - 60_000).toISOString(),
      sequence: 1,
      turnId: "turn_1",
      focusedTaskId:
        scene === "focused-task-launch-desktop-light" ? PHASE6_FIXTURE_COPY.focusedTaskId : null,
      briefingDate: null,
      segments: [],
      proposals: [],
      isError: false,
      retryable: false,
    },
    {
      id: "msg_asst_1",
      role: "assistant",
      status: "completed",
      text: PHASE6_FIXTURE_COPY.assistantText,
      createdAt: new Date(CLOCK_MS - 30_000).toISOString(),
      sequence: 2,
      turnId: "turn_1",
      focusedTaskId:
        scene === "focused-task-launch-desktop-light" ? PHASE6_FIXTURE_COPY.focusedTaskId : null,
      briefingDate: null,
      segments: [
        {
          kind: "tool_badge",
          tool: "plan_my_day",
          arguments: { energy: "medium" },
          complete: true,
        },
        {
          kind: "tool_badge",
          tool: "create_task",
          arguments: { title: PHASE6_FIXTURE_COPY.toolTaskTitle, priority: 2 },
          complete: true,
        },
        {
          kind: "tool_result",
          result: {
            tool: "plan_my_day",
            outcome: "ok",
            data: planMyDayData(),
            truncated: false,
            operationId: null,
            revision: null,
          },
        },
        {
          kind: "tool_result",
          result: {
            tool: "create_task",
            outcome: "ok",
            data: createTaskData(),
            truncated: false,
            operationId: null,
            revision: null,
          },
        },
        { kind: "text", text: PHASE6_FIXTURE_COPY.assistantText },
      ],
      proposals: [],
      isError: false,
      retryable: false,
    },
  ];
}

export function phase6Sessions(scene: Phase6SceneId): ChatSessionView[] {
  if (
    scene !== "ai-chat-history-desktop-light" &&
    scene !== "ai-conversation-tools-desktop-light" &&
    scene !== "focused-task-launch-desktop-light"
  ) {
    return [];
  }

  return PHASE6_FIXTURE_COPY.sessionTitles.map((title, index) => ({
    id: `session_demo_${index + 1}`,
    title,
    messageCount: 4 + index * 2,
    createdAt: new Date(CLOCK_MS - index * 3_600_000).toISOString(),
    updatedAt: new Date(CLOCK_MS - index * 3_600_000).toISOString(),
    lastMessageAt: new Date(CLOCK_MS - index * 3_600_000).toISOString(),
    status: "active" as const,
  }));
}

export function phase6VoiceFixture(scene: Phase6SceneId): VoiceFixture | null {
  switch (scene) {
    case "ptt-listening-desktop-light":
      return FIXTURE_PTT_LISTENING;
    case "ptt-transcribing-desktop-light":
      return FIXTURE_PTT_TRANSCRIBING;
    case "ptt-error-desktop-light":
      return FIXTURE_PTT_ERROR;
    case "vad-grace-desktop-light":
      return FIXTURE_VAD_GRACE;
    default:
      return null;
  }
}

export function phase6CallStateFixtures(): Array<{
  label: string;
  fixture: VoiceFixture;
}> {
  return [
    { label: "listening", fixture: FIXTURE_CALL_LISTENING },
    { label: "processing", fixture: FIXTURE_CALL_PROCESSING },
    { label: "speaking", fixture: FIXTURE_CALL_SPEAKING },
    { label: "recognition-error", fixture: FIXTURE_CALL_RECOGNITION_ERROR },
  ];
}
