import type { AIProvider } from "./provider.js";
import type { ChatMessage, StreamEvent } from "./types.js";
import { getToolDefinitions, executeTool, type ToolServices } from "./tools.js";
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
  private provider: AIProvider;
  private services: ToolServices;
  readonly sessionId: string;
  private queries?: IStorage;

  constructor(
    provider: AIProvider,
    services: ToolServices,
    systemMessage: ChatMessage,
    sessionId?: string,
    queries?: IStorage,
  ) {
    this.provider = provider;
    this.services = services;
    this.sessionId = sessionId ?? generateId();
    this.queries = queries;
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
    const tools = getToolDefinitions();
    let maxIterations = 10;

    while (maxIterations-- > 0) {
      let fullContent = "";
      let toolCalls: { id: string; name: string; arguments: string }[] | null = null;

      try {
        for await (const event of withTimeout(
          this.provider.streamChat(this.messages, tools),
          STREAM_TIMEOUT_MS,
        )) {
          if (event.type === "token") {
            fullContent += event.data;
            yield event;
          } else if (event.type === "tool_call") {
            toolCalls = JSON.parse(event.data);
            yield event; // Forward to frontend for badge display
          } else if (event.type === "error") {
            // Provider already classified the error — save partial content if any
            if (fullContent) {
              const partialMsg: ChatMessage = { role: "assistant", content: fullContent };
              this.messages.push(partialMsg);
              this.persistMessage(partialMsg);
            }
            yield event;
            return;
          }
        }
      } catch (err) {
        // Mid-stream failure (timeout or unexpected crash)
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
          const result = await executeTool(tc.name, args, this.services);

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

      // Signal end of this round so frontend can finalize the current message
      // before the next round starts a new assistant response
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
    provider: AIProvider,
    services: ToolServices,
    queries?: IStorage,
    contextBlock?: string,
  ): ChatSession {
    if (!this.session) {
      const systemMessage = this.buildSystemMessage(services, contextBlock);
      this.session = new ChatSession(provider, services, systemMessage, undefined, queries);
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

  resetWithProvider(provider: AIProvider, services: ToolServices, queries?: IStorage): ChatSession {
    this.session = null;
    return this.getOrCreateSession(provider, services, queries);
  }

  restoreSession(
    provider: AIProvider,
    services: ToolServices,
    queries: IStorage,
  ): ChatSession | null {
    const latest = queries.getLatestSessionId();
    if (!latest) return null;

    const rows = queries.listChatMessages(latest.sessionId);
    if (rows.length === 0) return null;

    const systemMessage = this.buildSystemMessage(services);
    const session = new ChatSession(provider, services, systemMessage, latest.sessionId, queries);

    // Restore messages from DB (skip system — already added by constructor)
    for (const row of rows) {
      if (row.role === "system") continue;
      const msg: ChatMessage = {
        role: row.role as ChatMessage["role"],
        content: row.content,
        ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
        ...(row.toolCalls ? { toolCalls: JSON.parse(row.toolCalls) } : {}),
      };
      // Push directly to avoid re-persisting
      (session as any).messages.push(msg);
    }

    this.session = session;
    return session;
  }

  buildSystemMessage(_services: ToolServices, contextBlock = ""): ChatMessage {
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
You can create, list, update, complete, and delete tasks using the tools available to you.

## Identity
- You are a confident, polished assistant — never say you are "under development", "having trouble with tools", or apologize for your capabilities
- Answer questions directly and helpfully
- If asked about the current date/time, just state it from the information above — no caveats needed

## Guidelines

### NEVER Invent Content
- ONLY create tasks with titles and details the user explicitly provided
- If the user says "create 3 tasks for next week" without specifying what they are, ASK what the tasks should be — do NOT invent titles like "Prepare Q1 Report"
- You may suggest due dates and priorities, but the task TITLE and DESCRIPTION must come from the user
- Never fabricate task IDs — always use list_tasks to find real IDs first

### Be Proactive & Context-Aware
- When a user asks about their tasks, ALWAYS use list_tasks first to get current data
- If a user has overdue tasks, mention them proactively: "I noticed you have X overdue tasks..."
- When creating tasks, suggest a priority if the user didn't specify one
- When a task has no due date, ask if they'd like to set one

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
export async function gatherContext(services: ToolServices): Promise<string> {
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

  return lines.join("\n");
}
