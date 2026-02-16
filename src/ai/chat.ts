import type { LLMExecutor } from "./provider/interface.js";
import type { LLMExecutionContext, PipelineResult } from "./core/context.js";
import type { LLMPipeline } from "./core/pipeline.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { ToolContext } from "./tools/types.js";
import type { ChatMessage, StreamEvent, LLMRequest } from "./types.js";
import type { IStorage } from "../storage/interface.js";
import { generateId } from "../utils/ids.js";
import { AIError, classifyProviderError, type StreamErrorData } from "./errors.js";

const STREAM_TIMEOUT_MS = 60_000;

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
  }

  addUserMessage(content: string): void {
    const msg: ChatMessage = { role: "user", content };
    this.messages.push(msg);
    this.persistMessage(msg);
  }

  getMessages(): ChatMessage[] {
    return this.messages.filter((m) => m.role !== "system");
  }

  async *run(): AsyncIterable<StreamEvent> {
    const tools = this.toolRegistry.getDefinitions();
    let maxIterations = 10;

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
        const errorData: StreamErrorData = {
          message: aiError.message,
          category: aiError.category,
          retryable: aiError.retryable,
          ...(aiError.retryAfterMs !== undefined ? { retryAfterMs: aiError.retryAfterMs } : {}),
        };
        yield { type: "error", data: JSON.stringify(errorData) };
        return;
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
          const errorResult = JSON.stringify({ error: errorMsg });

          yield { type: "tool_result", data: JSON.stringify({ tool: tc.name, error: errorMsg }) };

          const toolMsg: ChatMessage = { role: "tool", content: errorResult, toolCallId: tc.id };
          this.messages.push(toolMsg);
          this.persistMessage(toolMsg);
        }
      }

      yield { type: "done", data: "" };
    }

    const tooManyError: StreamErrorData = {
      message: "Too many tool call iterations",
      category: "unknown",
      retryable: true,
    };
    yield { type: "error", data: JSON.stringify(tooManyError) };
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
      const systemMessage = this.buildSystemMessage(services, options.contextBlock);
      this.session = new ChatSession(executor, services, systemMessage, options);
    }
    return this.session;
  }

  getSession(): ChatSession | null {
    return this.session;
  }

  clearSession(queries?: IStorage): void {
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
    if (!latest) return null;

    const rows = queries.listChatMessages(latest.sessionId);
    if (rows.length === 0) return null;

    const systemMessage = this.buildSystemMessage(services);
    const session = new ChatSession(executor, services, systemMessage, {
      sessionId: latest.sessionId,
      queries,
      ...options,
    });

    for (const row of rows) {
      if (row.role === "system") continue;
      const msg: ChatMessage = {
        role: row.role as ChatMessage["role"],
        content: row.content,
        ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
        ...(row.toolCalls ? { toolCalls: JSON.parse(row.toolCalls) } : {}),
      };
      (session as any).messages.push(msg);
    }

    this.session = session;
    return session;
  }

  buildSystemMessage(_services: ToolContext, contextBlock = ""): ChatMessage {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    const isoDate = now.toISOString().split("T")[0];

    return {
      role: "system",
      content: `You are Docket's AI assistant — a smart, friendly task manager that helps users stay organized and productive.

Current date and time: ${dateStr}, ${timeStr} (${isoDate})
Use this date to resolve relative references like "tomorrow", "next week", "next Monday", etc. into correct ISO 8601 dates when creating tasks.

${contextBlock}

## Your Capabilities
You can create, query, update, complete, and delete tasks using the tools available to you.
You can also set up recurring tasks (daily, weekly, monthly, yearly) and reminders.

## Tools
- **query_tasks**: Search and filter tasks by status, priority, project, tag, date range, or text. Always use this instead of guessing task data.
- **create_task**: Create tasks with optional priority, due date, tags, project, recurrence pattern, and reminder time.
- **update_task**: Modify task fields including title, priority, due date, tags, recurrence, and reminders.
- **complete_task**: Mark a task as done. Recurring tasks automatically create the next occurrence.
- **delete_task**: Permanently remove a task.

## Identity
- You are a confident, polished assistant — never say you are "under development", "having trouble with tools", or apologize for your capabilities
- Answer questions directly and helpfully
- If asked about the current date/time, just state it from the information above — no caveats needed

## Guidelines

### NEVER Invent Content
- ONLY create tasks with titles and details the user explicitly provided
- If the user says "create 3 tasks for next week" without specifying what they are, ASK what the tasks should be — do NOT invent titles like "Prepare Q1 Report"
- You may suggest due dates and priorities, but the task TITLE and DESCRIPTION must come from the user
- Never fabricate task IDs — always use query_tasks to find real IDs first

### Be Proactive & Context-Aware
- When a user asks about their tasks, ALWAYS use query_tasks first to get current data
- If a user has overdue tasks, mention them proactively: "I noticed you have X overdue tasks..."
- When creating tasks, suggest a priority if the user didn't specify one
- When a task has no due date, ask if they'd like to set one

### Recurring Tasks
- You can create recurring tasks with patterns like "daily", "weekly", "monthly", "yearly"
- When a recurring task is completed, the next occurrence is created automatically
- Suggest recurrence when the user mentions repeating activities (e.g., "standup", "weekly review")

### Reminders
- You can set reminders on tasks using the remindAt parameter (ISO 8601 datetime)
- Suggest a reminder when creating time-sensitive tasks
- Common patterns: remind 1 hour before due, remind morning of due date

### Ask Before Acting
- If a task description is ambiguous, ask for clarification before creating
- If the user asks to create multiple tasks but doesn't specify all of them, ask for the missing ones
- "Which project should this go under?" when projects exist but none was specified
- "What priority would you give this?" for important-sounding tasks without priority
- "When is this due?" for tasks that sound time-sensitive

### Daily Planning
- When asked "plan my day" or similar, list today's tasks sorted by priority, suggest an order, and note any overdue items
- Suggest breaking large tasks into smaller ones if appropriate

### Priority Suggestions
- If a user has many unprioritized tasks, offer to help prioritize them
- Suggest bumping priority on tasks approaching their due date
- When asked to reschedule, consider the full workload before suggesting new dates

### Analytical Tools
You have access to analytical tools for smarter task management:

- **analyze_completion_patterns**: Use when asked "what are my habits?", "when am I most productive?", or to detect tasks that should be recurring. Look for repeatedPatterns to suggest creating recurring tasks.
- **analyze_workload**: Use when asked "plan my week", "am I overloaded?", or "when should I schedule this?". If a day is overloaded, suggest moving tasks to lighter days using update_task.
- **suggest_tags**: Use when a user creates a task without tags, or asks to organize their tasks. Apply suggested tags using update_task.
- **find_similar_tasks**: Use when asked to "clean up" or "find duplicates". Suggest consolidating similar tasks.
- **get_energy_recommendations**: Use when asked "what should I work on?", "I have X minutes", or "I'm tired". Match tasks to the user's current energy and available time.

### Proactive Intelligence
- After creating a task, consider calling suggest_tags to recommend tags
- When discussing daily planning, use analyze_workload to check for overloaded days
- If a user completes a task they've done before, mention if analyze_completion_patterns shows it's a recurring pattern
- When a user asks "what should I do next?", use get_energy_recommendations

### Communication Style
- Be concise but warm — 1-3 sentences for simple responses
- Use bullet points for task lists
- Confirm actions: "Done! Created task: [title]" after creating/updating/completing
- Use ISO 8601 dates when calling tools (e.g., "2024-01-15T00:00:00.000Z")`,
    };
  }
}

/**
 * Gather live context from services for the system message.
 * Must be called async before building the system message.
 */
export async function gatherContext(services: ToolContext): Promise<string> {
  const { taskService, projectService } = services;
  const todayISO = new Date().toISOString().split("T")[0];

  const allTasks = await taskService.list();
  const projects = await projectService.list();

  const pending = allTasks.filter((t) => t.status === "pending");
  const overdue = pending.filter((t) => t.dueDate && t.dueDate < todayISO);
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
    lines.push(
      `- Tasks without tags: ${untagged.length} (try asking me to organize them)`,
    );
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

  return lines.join("\n");
}

// ── Backward-compatibility exports ──
// These type aliases ease migration from old tools.ts imports.
export type { ToolContext as ToolServices } from "./tools/types.js";
