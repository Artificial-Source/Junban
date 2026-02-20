import { describe, it, expect, vi } from "vitest";
import { ChatSession, ChatManager } from "../../src/ai/chat.js";
import type { LLMExecutor } from "../../src/ai/provider/interface.js";
import type { LLMExecutionContext, PipelineResult } from "../../src/ai/core/context.js";
import type { StreamEvent, ToolCall } from "../../src/ai/types.js";
import { DEFAULT_CAPABILITIES } from "../../src/ai/core/capabilities.js";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerTaskCrudTools } from "../../src/ai/tools/builtin/task-crud.js";
import { registerQueryTasksTool } from "../../src/ai/tools/builtin/query-tasks.js";
import { createTestServices } from "../integration/helpers.js";

function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerTaskCrudTools(registry);
  registerQueryTasksTool(registry);
  return registry;
}

function createMockExecutor(
  responses: Array<{ content: string; toolCalls?: ToolCall[] }>,
): LLMExecutor {
  let callCount = 0;
  return {
    getCapabilities: () => ({ ...DEFAULT_CAPABILITIES }),
    execute: async (_ctx: LLMExecutionContext): Promise<PipelineResult> => {
      const response = responses[callCount++];
      return {
        mode: "stream",
        events: (async function* (): AsyncGenerator<StreamEvent> {
          if (!response) return;
          if (response.content) {
            yield { type: "token", data: response.content };
          }
          if (response.toolCalls?.length) {
            yield { type: "tool_call", data: JSON.stringify(response.toolCalls) };
          } else {
            yield { type: "done", data: "" };
          }
        })(),
      };
    },
  };
}

describe("ChatSession", () => {
  it("tracks message history", () => {
    const executor = createMockExecutor([]);
    const { taskService, projectService } = createTestServices();
    const toolRegistry = createToolRegistry();
    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      { toolRegistry },
    );

    session.addUserMessage("Hello");
    const messages = session.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello");
  });

  it("appends assistant response after run", async () => {
    const executor = createMockExecutor([{ content: "Hello! How can I help?" }]);
    const { taskService, projectService } = createTestServices();
    const toolRegistry = createToolRegistry();
    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      { toolRegistry },
    );

    session.addUserMessage("Hi");
    const events: StreamEvent[] = [];
    for await (const event of session.run()) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "token")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(true);

    const messages = session.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hello! How can I help?");
  });

  it("yields structured error event when provider yields error", async () => {
    const { taskService, projectService } = createTestServices();
    const toolRegistry = createToolRegistry();

    const executor: LLMExecutor = {
      getCapabilities: () => ({ ...DEFAULT_CAPABILITIES }),
      execute: async (): Promise<PipelineResult> => ({
        mode: "stream",
        events: (async function* () {
          yield {
            type: "error" as const,
            data: JSON.stringify({
              message: "Authentication failed. Please check your API key in Settings.",
              category: "auth",
              retryable: false,
            }),
          };
        })(),
      }),
    };

    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      { toolRegistry },
    );

    session.addUserMessage("Hi");
    const events: StreamEvent[] = [];
    for await (const event of session.run()) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    const parsed = JSON.parse(errorEvent!.data);
    expect(parsed.category).toBe("auth");
    expect(parsed.retryable).toBe(false);
  });

  it("preserves partial content on mid-stream error", async () => {
    const { taskService, projectService } = createTestServices();
    const toolRegistry = createToolRegistry();

    const executor: LLMExecutor = {
      getCapabilities: () => ({ ...DEFAULT_CAPABILITIES }),
      execute: async (): Promise<PipelineResult> => ({
        mode: "stream",
        events: (async function* () {
          yield { type: "token" as const, data: "Here is some partial " };
          yield { type: "token" as const, data: "content" };
          yield {
            type: "error" as const,
            data: JSON.stringify({
              message: "Stream interrupted",
              category: "network",
              retryable: true,
            }),
          };
        })(),
      }),
    };

    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      { toolRegistry },
    );

    session.addUserMessage("Tell me something");
    const events: StreamEvent[] = [];
    for await (const event of session.run()) {
      events.push(event);
    }

    // Partial content should be saved as assistant message
    const messages = session.getMessages();
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("Here is some partial content");

    // Error event should also be yielded
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("handles provider crash (thrown error) with structured error event", async () => {
    const { taskService, projectService } = createTestServices();
    const toolRegistry = createToolRegistry();

    const executor: LLMExecutor = {
      getCapabilities: () => ({ ...DEFAULT_CAPABILITIES }),
      execute: async (): Promise<PipelineResult> => ({
        mode: "stream",
        events: (async function* () {
          yield { type: "token" as const, data: "partial" };
          throw Object.assign(new Error("Server Error"), { status: 500 });
        })(),
      }),
    };

    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      { toolRegistry },
    );

    session.addUserMessage("Hi");
    const events: StreamEvent[] = [];
    for await (const event of session.run()) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    const parsed = JSON.parse(errorEvent!.data);
    expect(parsed.category).toBe("server");
    expect(parsed.retryable).toBe(true);

    // Partial content saved
    const messages = session.getMessages();
    const assistantMsg = messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBe("partial");
  });

  it("detects duplicate tool call loops and exits gracefully", async () => {
    const { taskService, projectService } = createTestServices();
    const toolRegistry = createToolRegistry();

    // Executor always returns the same tool call (hallucination loop)
    let callCount = 0;
    const executor: LLMExecutor = {
      getCapabilities: () => ({ ...DEFAULT_CAPABILITIES }),
      execute: async (): Promise<PipelineResult> => {
        callCount++;
        return {
          mode: "stream",
          events: (async function* () {
            yield {
              type: "tool_call" as const,
              data: JSON.stringify([
                { id: `call_${callCount}`, name: "query_tasks", arguments: "{}" },
              ]),
            };
          })(),
        };
      },
    };

    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      { toolRegistry },
    );

    session.addUserMessage("List tasks forever");
    const events: StreamEvent[] = [];
    for await (const event of session.run()) {
      events.push(event);
    }

    // Duplicate detector should catch it after 2 calls, exiting cleanly
    expect(callCount).toBe(2);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("emits structured error for too many iterations with varying calls", async () => {
    const { taskService, projectService } = createTestServices();
    const toolRegistry = createToolRegistry();

    // Executor returns different args each time (bypasses duplicate detection)
    let callCount = 0;
    const executor: LLMExecutor = {
      getCapabilities: () => ({ ...DEFAULT_CAPABILITIES }),
      execute: async (): Promise<PipelineResult> => {
        callCount++;
        return {
          mode: "stream",
          events: (async function* () {
            yield {
              type: "tool_call" as const,
              data: JSON.stringify([
                {
                  id: `call_${callCount}`,
                  name: "query_tasks",
                  arguments: JSON.stringify({ search: `query_${callCount}` }),
                },
              ]),
            };
          })(),
        };
      },
    };

    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      { toolRegistry },
    );

    session.addUserMessage("List tasks forever");
    const events: StreamEvent[] = [];
    for await (const event of session.run()) {
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    const parsed = JSON.parse(errorEvent!.data);
    expect(parsed.message).toBe("Too many tool call iterations");
    expect(callCount).toBe(10);
  });

  it("handles tool call loop", async () => {
    const { taskService, projectService } = createTestServices();
    const toolRegistry = createToolRegistry();

    const executor = createMockExecutor([
      // First response: tool call
      {
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "create_task",
            arguments: JSON.stringify({ title: "Buy milk" }),
          },
        ],
      },
      // Second response: final text
      { content: "I created the task for you!" },
    ]);

    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      { toolRegistry },
    );

    session.addUserMessage("Create a task: buy milk");
    const events: StreamEvent[] = [];
    for await (const event of session.run()) {
      events.push(event);
    }

    // Should have tool_result and token events
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events.some((e) => e.type === "token")).toBe(true);

    // Task should actually be created
    const tasks = await taskService.list();
    expect(tasks.some((t) => t.title === "Buy milk")).toBe(true);
  });
});

describe("ChatManager", () => {
  it("creates and reuses session", () => {
    const manager = new ChatManager();
    const executor = createMockExecutor([]);
    const { taskService, projectService } = createTestServices();
    const services = { taskService, projectService };
    const toolRegistry = createToolRegistry();

    const s1 = manager.getOrCreateSession(executor, services, { toolRegistry });
    const s2 = manager.getOrCreateSession(executor, services, { toolRegistry });
    expect(s1).toBe(s2);
  });

  it("clearSession resets session", () => {
    const manager = new ChatManager();
    const executor = createMockExecutor([]);
    const { taskService, projectService } = createTestServices();
    const services = { taskService, projectService };
    const toolRegistry = createToolRegistry();

    manager.getOrCreateSession(executor, services, { toolRegistry });
    manager.clearSession();
    expect(manager.getSession()).toBeNull();
  });

  it("resetWithProvider creates new session", () => {
    const manager = new ChatManager();
    const executor1 = createMockExecutor([]);
    const executor2 = createMockExecutor([]);
    const { taskService, projectService } = createTestServices();
    const services = { taskService, projectService };
    const toolRegistry = createToolRegistry();

    const s1 = manager.getOrCreateSession(executor1, services, { toolRegistry });
    const s2 = manager.resetWithProvider(executor2, services, { toolRegistry });
    expect(s1).not.toBe(s2);
  });
});
