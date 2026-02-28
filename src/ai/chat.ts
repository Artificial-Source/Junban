import type { LLMExecutor } from "./provider/interface.js";
import type { LLMExecutionContext, PipelineResult } from "./core/context.js";
import type { LLMPipeline } from "./core/pipeline.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolContext } from "./tools/types.js";
import type { ChatMessage, StreamEvent, LLMRequest } from "./types.js";
import type { IStorage } from "../storage/interface.js";
import { generateId } from "../utils/ids.js";
import { AIError, classifyProviderError, type StreamErrorData } from "./errors.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("chat");

const STREAM_TIMEOUT_MS = 60_000;
const DEFAULT_CONTEXT_BUDGET = 8_000; // tokens — conservative for 8k-128k models
const KEEP_RECENT_MESSAGES = 12; // ~6 turns of user/assistant

/** Essential tools for local models with small context windows. */
const LOCAL_PROVIDER_TOOLS = new Set([
  "query_tasks",
  "create_task",
  "update_task",
  "complete_task",
  "delete_task",
  "list_projects",
]);

async function* withTimeout(
  source: AsyncIterable<StreamEvent>,
  timeoutMs: number,
): AsyncGenerator<StreamEvent> {
  const iterator = source[Symbol.asyncIterator]();
  while (true) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new AIError("Response timed out.", "timeout", true)), timeoutMs),
      ),
    ]);
    if (result.done) return;
    yield result.value;
  }
}

export class ChatSession {
  private messages: ChatMessage[] = [];
  private executor: LLMExecutor;
  private pipeline: LLMPipeline | null;
  private toolRegistry: ToolRegistry;
  private services: ToolContext;
  private model: string;
  private providerName: string;
  readonly sessionId: string;
  private queries?: IStorage;
  private running = false;
  private runQueue: Array<() => void> = [];

  constructor(
    executor: LLMExecutor,
    services: ToolContext,
    systemMessage: ChatMessage,
    options: {
      sessionId?: string;
      queries?: IStorage;
      pipeline?: LLMPipeline;
      toolRegistry: ToolRegistry;
      model?: string;
      providerName?: string;
    },
  ) {
    this.executor = executor;
    this.services = services;
    this.sessionId = options.sessionId ?? generateId();
    this.queries = options.queries;
    this.pipeline = options.pipeline ?? null;
    this.toolRegistry = options.toolRegistry;
    this.model = options.model ?? "default";
    this.providerName = options.providerName ?? "unknown";
    this.messages.push(systemMessage);
    logger.info("Chat session created", {
      sessionId: this.sessionId,
      provider: this.providerName,
      model: this.model,
    });
  }

  /** Restore previously persisted messages (used when rehydrating a session). */
  restoreMessages(msgs: ChatMessage[]): void {
    this.messages.push(...msgs);
  }

  /** Rough token estimate: ~4 chars per token for English text. */
  private estimateTokens(): number {
    return this.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
  }

  /**
   * Compact conversation if it exceeds the context budget.
   * Replaces old messages with a summary, keeping the system message and recent messages.
   */
  private async compactIfNeeded(): Promise<void> {
    const estimate = this.estimateTokens();
    if (estimate <= DEFAULT_CONTEXT_BUDGET) return;

    // Find the system message (always first)
    const systemMsg = this.messages[0];
    if (systemMsg?.role !== "system") return;

    // Keep system + last N messages
    const nonSystemMessages = this.messages.slice(1);
    if (nonSystemMessages.length <= KEEP_RECENT_MESSAGES) return;

    const oldMessages = nonSystemMessages.slice(0, -KEEP_RECENT_MESSAGES);
    const recentMessages = nonSystemMessages.slice(-KEEP_RECENT_MESSAGES);
    const oldCount = this.messages.length;

    try {
      // Build compaction request
      const compactionMessages: ChatMessage[] = [
        ...oldMessages,
        {
          role: "user",
          content:
            "Summarize this conversation so far in 2-4 paragraphs. Preserve: key decisions, task actions taken, user preferences mentioned, and any pending questions or plans.",
        },
      ];

      const request: LLMRequest = {
        messages: compactionMessages,
        model: this.model,
      };

      const ctx: LLMExecutionContext = {
        request,
        providerName: this.providerName,
        capabilities: this.executor.getCapabilities(this.model),
        metadata: new Map(),
      };

      const result = await this.executor.execute(ctx);
      let summary = "";
      if (result.mode === "stream") {
        for await (const event of result.events) {
          if (event.type === "token") summary += event.data;
        }
      } else {
        summary = result.response.content;
      }

      if (!summary) return;

      // Replace old messages with summary
      const summaryMsg: ChatMessage = {
        role: "assistant",
        content: `[Conversation summary]\n\n${summary}`,
      };

      this.messages = [systemMsg, summaryMsg, ...recentMessages];

      logger.info("Conversation compacted", {
        sessionId: this.sessionId,
        before: oldCount,
        after: this.messages.length,
      });
    } catch (err) {
      logger.warn("Conversation compaction failed", {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal — continue with uncompacted messages
    }
  }

  addUserMessage(content: string): void {
    logger.debug("User message added", { sessionId: this.sessionId, length: content.length });
    const msg: ChatMessage = { role: "user", content };
    this.messages.push(msg);
    this.persistMessage(msg);
  }

  getMessages(): ChatMessage[] {
    return this.messages.filter((m) => m.role !== "system");
  }

  async *run(): AsyncIterable<StreamEvent> {
    // Serialize concurrent runs — second caller waits until first completes
    if (this.running) {
      await new Promise<void>((resolve) => this.runQueue.push(resolve));
    }
    this.running = true;
    try {
      yield* this.executeRun();
    } finally {
      this.running = false;
      const next = this.runQueue.shift();
      if (next) next();
    }
  }

  private async *executeRun(): AsyncIterable<StreamEvent> {
    // Compact conversation if approaching context limits
    await this.compactIfNeeded();

    const isLocal = this.providerName === "ollama" || this.providerName === "lmstudio";
    const allTools = this.toolRegistry.getDefinitions();
    const tools = isLocal ? allTools.filter((t) => LOCAL_PROVIDER_TOOLS.has(t.name)) : allTools;
    let maxIterations = 10;
    let lastToolSignature = "";

    while (maxIterations-- > 0) {
      let fullContent = "";
      let toolCalls: { id: string; name: string; arguments: string }[] | null = null;

      try {
        const request: LLMRequest = {
          messages: this.messages,
          tools: tools.length > 0 ? tools : undefined,
          model: this.model,
        };

        const ctx: LLMExecutionContext = {
          request,
          providerName: this.providerName,
          capabilities: this.executor.getCapabilities(this.model),
          metadata: new Map(),
        };

        let result: PipelineResult;
        if (this.pipeline) {
          result = await this.pipeline.execute(ctx, (c) => this.executor.execute(c));
        } else {
          result = await this.executor.execute(ctx);
        }

        if (result.mode === "stream") {
          for await (const event of withTimeout(result.events, STREAM_TIMEOUT_MS)) {
            if (event.type === "token") {
              fullContent += event.data;
              yield event;
            } else if (event.type === "tool_call") {
              toolCalls = JSON.parse(event.data);
              yield event;
            } else if (event.type === "error") {
              if (fullContent) {
                const partialMsg: ChatMessage = { role: "assistant", content: fullContent };
                this.messages.push(partialMsg);
                this.persistMessage(partialMsg);
              }
              yield event;
              return;
            }
          }
        } else {
          // Complete mode — convert to events
          fullContent = result.response.content;
          if (fullContent) {
            yield { type: "token", data: fullContent };
          }
          if (result.response.toolCalls?.length) {
            toolCalls = result.response.toolCalls;
            yield { type: "tool_call", data: JSON.stringify(toolCalls) };
          }
        }
      } catch (err) {
        if (fullContent) {
          const partialMsg: ChatMessage = { role: "assistant", content: fullContent };
          this.messages.push(partialMsg);
          this.persistMessage(partialMsg);
        }
        const aiError = classifyProviderError(err);
        logger.error("Provider error", {
          sessionId: this.sessionId,
          category: aiError.category,
          retryable: aiError.retryable,
        });
        const errorData: StreamErrorData = {
          message: aiError.message,
          category: aiError.category,
          retryable: aiError.retryable,
          ...(aiError.retryAfterMs !== undefined ? { retryAfterMs: aiError.retryAfterMs } : {}),
        };
        yield { type: "error", data: JSON.stringify(errorData) };
        return;
      }

      if (toolCalls && toolCalls.length > 0) {
        logger.debug("Tool calls received", {
          sessionId: this.sessionId,
          tools: toolCalls.map((tc) => tc.name),
        });

        // Detect hallucination loop: same tool calls repeated back-to-back
        const signature = toolCalls
          .map((tc) => `${tc.name}:${tc.arguments}`)
          .sort()
          .join("|");
        if (signature === lastToolSignature) {
          logger.warn("Duplicate tool call loop detected, breaking", { sessionId: this.sessionId });
          const msg: ChatMessage = { role: "assistant", content: fullContent || "Done." };
          this.messages.push(msg);
          this.persistMessage(msg);
          yield { type: "done", data: "" };
          return;
        }
        lastToolSignature = signature;
      }

      if (!toolCalls || toolCalls.length === 0) {
        const msg: ChatMessage = { role: "assistant", content: fullContent };
        this.messages.push(msg);
        this.persistMessage(msg);
        yield { type: "done", data: "" };
        return;
      }

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: fullContent,
        toolCalls,
      };
      this.messages.push(assistantMsg);
      this.persistMessage(assistantMsg);

      for (const tc of toolCalls) {
        try {
          const args = JSON.parse(tc.arguments);
          const result = await this.toolRegistry.execute(tc.name, args, this.services);

          yield { type: "tool_result", data: JSON.stringify({ tool: tc.name, result }) };

          const toolMsg: ChatMessage = { role: "tool", content: result, toolCallId: tc.id };
          this.messages.push(toolMsg);
          this.persistMessage(toolMsg);
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.warn("Tool execution failed", {
            sessionId: this.sessionId,
            tool: tc.name,
            error: errorMsg,
          });
          const errorResult = JSON.stringify({ error: errorMsg });

          yield { type: "tool_result", data: JSON.stringify({ tool: tc.name, error: errorMsg }) };

          const toolMsg: ChatMessage = { role: "tool", content: errorResult, toolCallId: tc.id };
          this.messages.push(toolMsg);
          this.persistMessage(toolMsg);
        }
      }

      yield { type: "done", data: "" };
    }

    logger.warn("Max tool iterations exceeded", { sessionId: this.sessionId });
    const tooManyError: StreamErrorData = {
      message: "Too many tool call iterations",
      category: "unknown",
      retryable: true,
    };
    yield { type: "error", data: JSON.stringify(tooManyError) };
  }

  /**
   * Silently review the conversation and extract memories worth saving.
   * Fire-and-forget — errors are logged but not surfaced to the user.
   */
  async extractMemories(): Promise<void> {
    // Skip short conversations
    const userMessages = this.messages.filter((m) => m.role === "user");
    if (userMessages.length < 2) return;

    const extractPrompt =
      "Review this conversation. If the user shared any preferences, habits, schedules, work patterns, or important context worth remembering for future conversations, use save_memory to store them. Use recall_memories first to avoid duplicates. If nothing is worth saving, do nothing. Do not respond with text.";

    this.messages.push({ role: "user", content: extractPrompt });

    try {
      for await (const _event of this.executeRun()) {
        // Consume all events silently
      }
    } catch (err) {
      logger.warn("Memory extraction failed", {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Remove the extraction prompt and any responses from the persisted history
    // (we don't want this meta-conversation visible to the user)
  }

  private persistMessage(msg: ChatMessage): void {
    if (!this.queries) return;
    this.queries.insertChatMessage({
      sessionId: this.sessionId,
      role: msg.role,
      content: msg.content,
      toolCallId: msg.toolCallId ?? null,
      toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
      createdAt: new Date().toISOString(),
    });
  }
}

export class ChatManager {
  private session: ChatSession | null = null;

  getOrCreateSession(
    executor: LLMExecutor,
    services: ToolContext,
    options: {
      queries?: IStorage;
      contextBlock?: string;
      pipeline?: LLMPipeline;
      toolRegistry: ToolRegistry;
      model?: string;
      providerName?: string;
    },
  ): ChatSession {
    if (!this.session) {
      logger.info("Creating chat session");
      const systemMessage = this.buildSystemMessage(
        services,
        options.contextBlock,
        options.providerName,
      );
      this.session = new ChatSession(executor, services, systemMessage, options);
    }
    return this.session;
  }

  getSession(): ChatSession | null {
    return this.session;
  }

  /** Replace the current session (e.g., when restoring a persisted session). */
  setSession(session: ChatSession | null): void {
    this.session = session;
  }

  clearSession(queries?: IStorage): void {
    logger.info("Chat session cleared", { sessionId: this.session?.sessionId });
    if (this.session && queries) {
      queries.deleteChatSession(this.session.sessionId);
    }
    this.session = null;
  }

  resetWithProvider(
    executor: LLMExecutor,
    services: ToolContext,
    options: {
      queries?: IStorage;
      pipeline?: LLMPipeline;
      toolRegistry: ToolRegistry;
      model?: string;
      providerName?: string;
    },
  ): ChatSession {
    this.session = null;
    return this.getOrCreateSession(executor, services, options);
  }

  restoreSession(
    executor: LLMExecutor,
    services: ToolContext,
    queries: IStorage,
    options: {
      pipeline?: LLMPipeline;
      toolRegistry: ToolRegistry;
      model?: string;
      providerName?: string;
    },
  ): ChatSession | null {
    const latest = queries.getLatestSessionId();
    if (!latest) {
      logger.debug("No previous session to restore");
      return null;
    }

    const rows = queries.listChatMessages(latest.sessionId);
    if (rows.length === 0) return null;

    const systemMessage = this.buildSystemMessage(services, "", options.providerName);
    const session = new ChatSession(executor, services, systemMessage, {
      sessionId: latest.sessionId,
      queries,
      ...options,
    });

    const restoredMessages: ChatMessage[] = [];
    for (const row of rows) {
      if (row.role === "system") continue;
      const msg: ChatMessage = {
        role: row.role as ChatMessage["role"],
        content: row.content,
        ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
        ...(row.toolCalls ? { toolCalls: JSON.parse(row.toolCalls) } : {}),
      };
      restoredMessages.push(msg);
    }

    session.restoreMessages(restoredMessages);
    this.session = session;
    logger.info("Chat session restored", {
      sessionId: latest.sessionId,
      messageCount: rows.length,
    });
    return session;
  }

  buildSystemMessage(_services: ToolContext, contextBlock = "", providerName = ""): ChatMessage {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    const isoDate = now.toISOString().split("T")[0];

    const isLocalProvider = providerName === "ollama" || providerName === "lmstudio";
    const content = isLocalProvider
      ? this.buildCompactPrompt(dateStr, timeStr, isoDate, contextBlock)
      : this.buildFullPrompt(dateStr, timeStr, isoDate, contextBlock);

    return { role: "system", content };
  }

  private buildFullPrompt(
    dateStr: string,
    timeStr: string,
    isoDate: string,
    contextBlock: string,
  ): string {
    return `You are Saydo's AI assistant — a task manager that helps users stay organized.

Current date/time: ${dateStr}, ${timeStr} (${isoDate})
Resolve relative dates ("tomorrow", "next Monday") into ISO 8601 dates.

## Rules (in priority order)
1. **Always use tools** — never describe what you would do; call the tool. Never narrate actions you could perform.
2. **Never invent data** — do not fabricate task IDs, project names, dates, or titles. Use query_tasks to get real data.
3. **No sycophancy** — skip "Great question!" or praise prefixes. Answer directly.
4. **Act, then confirm** — for clear requests, execute immediately and confirm the result. Only ask for clarification when the request is genuinely ambiguous.
5. **Be concise** — 1-3 sentences for simple responses. Use bullet points for lists.

${contextBlock ? contextBlock + "\n" : ""}## Task Tools
- **query_tasks**: Search/filter by status, priority, project, tag, date range, text. Always query before referencing task data.
- **create_task**: Create with optional priority (1-4), dueDate (ISO 8601), tags, projectId, recurrence ("daily"|"weekly"|"monthly"|"yearly"), remindAt, estimatedMinutes, deadline, isSomeday, sectionId.
- **update_task**: Modify any field by task ID (from query_tasks). Supports estimatedMinutes, deadline, isSomeday, sectionId in addition to all create fields.
- **complete_task**: Mark done by ID. Recurring tasks auto-create next occurrence.
- **delete_task**: Permanently remove by ID.

## Project Tools
- **create_project**: Name + optional color.
- **list_projects**: All projects (set includeArchived=true to include archived).
- **get_project**: By ID or name.
- **update_project**: Change name, color, or archived status.
- **delete_project**: Remove project; tasks get projectId=null.

## Reminder Tools
- **list_reminders**: Filter by "overdue", "upcoming", or "all".
- **set_reminder**: Set/update with ISO 8601 datetime.
- **snooze_reminder**: Push forward by N minutes (15, 30, 60, 1440).
- **dismiss_reminder**: Clear without completing.

## Tag/Label Tools
- **list_tags**: List all existing tags/labels with their colors.
- **add_tags_to_task**: Add tags to a task without removing existing ones. Creates new tags if needed.
- **remove_tags_from_task**: Remove specific tags from a task, keeping others intact.

## Bulk Operations
- **bulk_create_tasks**: Create multiple tasks at once. Perfect for brain dumps, meeting notes, or planning sessions.
  When the user describes multiple things to do, extract ALL tasks and create them with bulk_create_tasks.
- **bulk_complete_tasks**: Mark multiple tasks done by IDs. Use after querying tasks.
- **bulk_update_tasks**: Update multiple tasks at once (priority, due date, project, tags).

## Smart Capture Behavior
- When the user sends unstructured text with multiple actionable items, extract ALL tasks and create them with bulk_create_tasks.
- Infer priority from urgency words ("ASAP" → P1, "when you can" → P4).
- Infer due dates from temporal references ("tomorrow", "by Friday", "next week").
- Infer projects from context if mentioned ("for the website redesign" → match existing project).
- Infer tags from topic keywords.
- After bulk creation, summarize what was created.

## Analytical Tools
- **analyze_completion_patterns**: Habits, productivity patterns, recurring task detection.
- **analyze_workload**: Weekly load distribution, overloaded days.
- **check_overcommitment**: Quick check if a date is overloaded. Use when creating tasks with due dates.
- **suggest_tags**: Tag recommendations for untagged tasks.
- **find_similar_tasks**: Duplicate detection and consolidation.
- **check_duplicates**: Check if a task title is similar to existing tasks before creating. Use after the user requests a new task.
- **get_energy_recommendations**: Task suggestions based on energy/time available.
- **break_down_task**: Break a task into subtasks. Provide the parent task ID and a list of subtask titles.

## Planning Tools
- **plan_my_day**: Morning briefing with today's tasks, overdue items, focus blocks, and productivity insights. Optional energy_level (low/medium/high).
- **daily_review**: End-of-day review with completion stats, streaks, carried-over tasks, and tomorrow preview. Optional date (ISO).
- **get_productivity_stats**: Productivity report with streak, completion counts, and trends. Optional startDate/endDate (ISO, defaults to last 30 days).

## Behavior
- Only create tasks with titles the user explicitly provided — never invent titles.
- When a user asks about tasks, call query_tasks first.
- Mention overdue tasks proactively when relevant.
- Suggest priority, due date, or reminders for tasks missing them.
- For "plan my day" / "morning briefing": use the plan_my_day tool. For "review my day" / "daily review": use the daily_review tool.
- For recurring activities ("standup", "weekly review"), suggest recurrence.
- Confirm completed actions: "Done! Created: [title]" / "Marked complete: [title]".
- Use ISO 8601 for all tool date arguments.
- After creating a task, call check_duplicates to warn about potential duplicates.
- When setting a due date, call check_overcommitment to warn about overloaded days.
- When asked to "break down" or "split" a task, use break_down_task.
- When referencing tasks in your response, link them using this format: [Task Title](saydo://task/<taskId>). This makes tasks clickable in the UI.
- When a "Currently Focused Task" section is present in context, the user is viewing that task. Respond to references like "this task", "break it down", "add a reminder for this" as referring to the focused task.

## Memory Tools
- **save_memory**: Save an important fact about the user (preferences, habits, schedules, work patterns, instructions). Keep each memory concise (1-2 sentences).
- **recall_memories**: List all saved memories with IDs. Use before saving to avoid duplicates.
- **forget_memory**: Delete an outdated memory by ID.

## Memory Guidelines
- Proactively save important facts the user shares: preferences, habits, schedules, work patterns, instructions for how you should behave.
- Do NOT save trivial or temporary info (e.g., "add a task called X").
- Use recall_memories before saving to check for duplicates.
- When facts change, forget the old memory and save the updated one.
- Aim for max ~50 memories; consolidate related ones if approaching that limit.`;
  }

  private buildCompactPrompt(
    dateStr: string,
    timeStr: string,
    isoDate: string,
    contextBlock: string,
  ): string {
    return `You are Saydo, a task manager assistant.
Date: ${dateStr}, ${timeStr} (${isoDate}). Use for relative date resolution.

RULES:
1. ONLY do what the user asked. If they ask to list tasks, ONLY query. Never create, update, or delete unless explicitly asked.
2. Use tools to act — do not narrate actions.
3. Never invent task IDs, titles, or dates. Query first.
4. Respond concisely. Confirm actions briefly.
${contextBlock ? "\n" + contextBlock : ""}`;
  }
}

/**
 * Gather live context from services for the system message.
 * Must be called async before building the system message.
 */
export async function gatherContext(
  services: ToolContext,
  options?: {
    compact?: boolean;
    voiceCall?: boolean;
    storage?: IStorage;
    focusedTaskId?: string;
  },
): Promise<string> {
  const { taskService, projectService } = services;
  const todayISO = new Date().toISOString().split("T")[0];
  const compact = options?.compact ?? false;
  const voiceCall = options?.voiceCall ?? false;
  const storage = options?.storage ?? services.storage;
  const focusedTaskId = options?.focusedTaskId;

  const allTasks = await taskService.list();
  const projects = await projectService.list();

  const pending = allTasks.filter((t) => t.status === "pending");
  const overdue = pending.filter((t) => t.dueDate && t.dueDate < todayISO);

  const voiceCallBlock = voiceCall
    ? `## Voice Call Mode
You are in a live voice call with the user. Follow these rules:
- Be conversational and concise — speak in short sentences
- Confirm actions briefly: "Done, created Buy groceries for tomorrow"
- Ask follow-up questions naturally: "Anything else?"
- When user says multiple tasks in one sentence, create each one separately
- For "plan my day" or "what's on my plate": query tasks, summarize briefly, suggest an order
- Don't use markdown formatting — your response will be spoken aloud
- Keep responses under 3 sentences unless the user asks for details
- End your responses in a way that invites the user to continue talking

`
    : "";

  if (compact) {
    const lines: string[] = [`Pending: ${pending.length}`];
    if (overdue.length > 0) lines.push(`Overdue: ${overdue.length}`);
    if (projects.length > 0) lines.push(`Projects: ${projects.map((p) => p.name).join(", ")}`);
    return voiceCallBlock + lines.join(". ") + ".";
  }

  const dueToday = pending.filter((t) => t.dueDate?.startsWith(todayISO));
  const highPriority = pending.filter((t) => t.priority === 1 || t.priority === 2);
  const noPriority = pending.filter((t) => t.priority === null);

  const lines: string[] = ["## Current Task Context"];

  lines.push(`- Total pending tasks: ${pending.length}`);
  if (overdue.length > 0) {
    lines.push(`- OVERDUE tasks: ${overdue.length}`);
    for (const t of overdue.slice(0, 5)) {
      lines.push(`  - "${t.title}" (due ${t.dueDate}${t.priority ? `, P${t.priority}` : ""})`);
    }
    if (overdue.length > 5) lines.push(`  - ...and ${overdue.length - 5} more`);
  }
  if (dueToday.length > 0) {
    lines.push(`- Due TODAY: ${dueToday.length}`);
    for (const t of dueToday.slice(0, 5)) {
      lines.push(`  - "${t.title}"${t.priority ? ` (P${t.priority})` : ""}`);
    }
  }
  if (highPriority.length > 0) {
    lines.push(`- High priority (P1/P2): ${highPriority.length}`);
  }
  if (noPriority.length > 0) {
    lines.push(`- Tasks without priority: ${noPriority.length}`);
  }
  if (projects.length > 0) {
    lines.push(`- Projects: ${projects.map((p) => p.name).join(", ")}`);
  }

  // Tags and scheduling insights for analytical tools
  const untagged = pending.filter((t) => t.tags.length === 0);
  if (untagged.length > 0) {
    lines.push(`- Tasks without tags: ${untagged.length} (try asking me to organize them)`);
  }

  const unscheduled = pending.filter((t) => !t.dueDate);
  if (unscheduled.length > 0) {
    lines.push(`- Tasks without due dates: ${unscheduled.length}`);
  }

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoISO = sevenDaysAgo.toISOString();
  const completedRecently = allTasks.filter(
    (t) => t.status === "completed" && t.completedAt && t.completedAt >= sevenDaysAgoISO,
  );
  if (completedRecently.length > 0) {
    lines.push(`- Tasks completed in last 7 days: ${completedRecently.length}`);
  }

  // Inject AI memories
  if (storage) {
    try {
      const memories = storage.listAiMemories();
      if (memories.length > 0) {
        lines.push("");
        lines.push("## Your memories about the user");
        for (const m of memories) {
          lines.push(`- [${m.category}] ${m.content}`);
        }
      }
    } catch {
      // Non-critical — memories just won't be injected
    }
  }

  // Inject custom instructions
  if (storage) {
    try {
      const customInstructions = storage.getAppSetting("ai_custom_instructions");
      if (customInstructions?.value) {
        lines.push("");
        lines.push("## User's Custom Instructions");
        lines.push(customInstructions.value);
      }
    } catch {
      // Non-critical
    }
  }

  // Inject focused task context
  if (focusedTaskId) {
    try {
      const task = await taskService.get(focusedTaskId);
      if (task) {
        lines.push("");
        lines.push("## Currently Focused Task");
        lines.push(`- Title: "${task.title}"`);
        lines.push(`- ID: ${task.id}`);
        lines.push(`- Status: ${task.status}`);
        if (task.priority) lines.push(`- Priority: P${task.priority}`);
        if (task.dueDate) lines.push(`- Due: ${task.dueDate}`);
        if (task.projectId) lines.push(`- Project ID: ${task.projectId}`);
        if (task.tags.length > 0) lines.push(`- Tags: ${task.tags.join(", ")}`);
        if (task.description) lines.push(`- Description: ${task.description}`);
        if (task.estimatedMinutes) lines.push(`- Estimated: ${task.estimatedMinutes} minutes`);
        if (task.deadline) lines.push(`- Deadline: ${task.deadline}`);
        if (task.recurrence) lines.push(`- Recurrence: ${task.recurrence}`);
        if (task.remindAt) lines.push(`- Reminder: ${task.remindAt}`);
      }
    } catch {
      // Non-critical — focused task just won't be injected
    }
  }

  return voiceCallBlock + lines.join("\n");
}

// ── Backward-compatibility exports ──
// These type aliases ease migration from old tools.ts imports.
export type { ToolContext as ToolServices } from "./tools/types.js";
