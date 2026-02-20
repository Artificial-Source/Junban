import { describe, it, expect } from "vitest";
import { ChatSession, ChatManager, gatherContext } from "../../src/ai/chat.js";
import type { LLMExecutor } from "../../src/ai/provider/interface.js";
import type { LLMExecutionContext, PipelineResult } from "../../src/ai/core/context.js";
import type { StreamEvent, ToolCall } from "../../src/ai/types.js";
import { DEFAULT_CAPABILITIES } from "../../src/ai/core/capabilities.js";
import { ToolRegistry } from "../../src/ai/tools/registry.js";
import { registerTaskCrudTools } from "../../src/ai/tools/builtin/task-crud.js";
import { registerQueryTasksTool } from "../../src/ai/tools/builtin/query-tasks.js";
import { createDefaultToolRegistry } from "../../src/ai/provider.js";
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

describe("Chat Persistence", () => {
  it("persists messages to SQLite", async () => {
    const { taskService, projectService, storage } = createTestServices();
    const executor = createMockExecutor([{ content: "Hi there!" }]);
    const toolRegistry = createToolRegistry();
    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      { queries: storage, toolRegistry },
    );

    session.addUserMessage("Hello");
    for await (const _event of session.run()) {
      // drain
    }

    // Check messages were persisted (system is NOT persisted, only user + assistant)
    const rows = storage.listChatMessages(session.sessionId);
    expect(rows.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(rows.some((r) => r.role === "user" && r.content === "Hello")).toBe(true);
    expect(rows.some((r) => r.role === "assistant" && r.content === "Hi there!")).toBe(true);
  });

  it("persists tool call messages", async () => {
    const { taskService, projectService, storage } = createTestServices();
    const executor = createMockExecutor([
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "query_tasks", arguments: "{}" }],
      },
      { content: "You have no tasks." },
    ]);
    const toolRegistry = createToolRegistry();

    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      { queries: storage, toolRegistry },
    );

    session.addUserMessage("What tasks do I have?");
    for await (const _event of session.run()) {
      // drain
    }

    const rows = storage.listChatMessages(session.sessionId);
    // user + assistant(tool call) + tool result + assistant(final)
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.some((r) => r.role === "tool")).toBe(true);
    expect(rows.some((r) => r.toolCalls !== null)).toBe(true);
  });

  it("restores session from DB", async () => {
    const { taskService, projectService, storage } = createTestServices();
    const executor = createMockExecutor([{ content: "Hello!" }]);
    const services = { taskService, projectService };
    const toolRegistry = createToolRegistry();

    // Create and populate a session
    const manager1 = new ChatManager();
    const session1 = manager1.getOrCreateSession(executor, services, {
      queries: storage,
      toolRegistry,
    });
    session1.addUserMessage("Hi");
    for await (const _event of session1.run()) {
      // drain
    }
    const sessionId = session1.sessionId;

    // Now restore from a fresh manager
    const manager2 = new ChatManager();
    const executor2 = createMockExecutor([]);
    const restored = manager2.restoreSession(executor2, services, storage, {
      toolRegistry,
    });

    expect(restored).not.toBeNull();
    expect(restored!.sessionId).toBe(sessionId);
    const messages = restored!.getMessages();
    expect(messages.some((m) => m.role === "user" && m.content === "Hi")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content === "Hello!")).toBe(true);
  });

  it("clearSession deletes from DB", async () => {
    const { taskService, projectService, storage } = createTestServices();
    const executor = createMockExecutor([{ content: "Hello!" }]);
    const services = { taskService, projectService };
    const toolRegistry = createToolRegistry();

    const manager = new ChatManager();
    const session = manager.getOrCreateSession(executor, services, {
      queries: storage,
      toolRegistry,
    });
    session.addUserMessage("Hi");
    for await (const _event of session.run()) {
      // drain
    }
    const sessionId = session.sessionId;

    // Verify messages exist
    expect(storage.listChatMessages(sessionId).length).toBeGreaterThan(0);

    // Clear and verify deletion
    manager.clearSession(storage);
    expect(storage.listChatMessages(sessionId).length).toBe(0);
    expect(manager.getSession()).toBeNull();
  });

  it("returns null when no session to restore", () => {
    const { taskService, projectService, storage } = createTestServices();
    const executor = createMockExecutor([]);
    const toolRegistry = createToolRegistry();
    const manager = new ChatManager();
    const restored = manager.restoreSession(executor, { taskService, projectService }, storage, {
      toolRegistry,
    });
    expect(restored).toBeNull();
  });
});

describe("Context Injection", () => {
  it("gatherContext returns task statistics", async () => {
    const { taskService, projectService } = createTestServices();

    // Create some tasks
    await taskService.create({ title: "Buy milk", dueTime: false });
    await taskService.create({ title: "Urgent task", priority: 1, dueTime: false });

    const context = await gatherContext({ taskService, projectService });
    expect(context).toContain("Current Task Context");
    expect(context).toContain("Total pending tasks: 2");
    expect(context).toContain("High priority (P1/P2): 1");
  });

  it("gatherContext includes overdue tasks", async () => {
    const { taskService, projectService } = createTestServices();

    // Create an overdue task
    await taskService.create({
      title: "Overdue task",
      dueDate: "2020-01-01",
      dueTime: false,
    });

    const context = await gatherContext({ taskService, projectService });
    expect(context).toContain("OVERDUE tasks: 1");
    expect(context).toContain("Overdue task");
  });

  it("gatherContext includes projects", async () => {
    const { taskService, projectService } = createTestServices();

    await projectService.create("Work");
    await projectService.create("Personal");

    const context = await gatherContext({ taskService, projectService });
    expect(context).toContain("Projects: Work, Personal");
  });

  it("gatherContext handles empty state", async () => {
    const { taskService, projectService } = createTestServices();

    const context = await gatherContext({ taskService, projectService });
    expect(context).toContain("Total pending tasks: 0");
    expect(context).not.toContain("OVERDUE");
    expect(context).not.toContain("Projects:");
  });

  it("gatherContext compact mode returns short output", async () => {
    const { taskService, projectService } = createTestServices();

    await taskService.create({ title: "Task A", dueTime: false });
    await taskService.create({ title: "Task B", dueDate: "2020-01-01", dueTime: false });
    await projectService.create("Work");

    const compact = await gatherContext({ taskService, projectService }, { compact: true });
    expect(compact).toContain("Pending: 2");
    expect(compact).toContain("Overdue: 1");
    expect(compact).toContain("Projects: Work");
    // Compact should NOT contain verbose headers or tag stats
    expect(compact).not.toContain("## Current Task Context");
    expect(compact).not.toContain("without tags");
    expect(compact).not.toContain("without due dates");
    expect(compact.length).toBeLessThan(200);
  });

  it("gatherContext compact mode handles empty state", async () => {
    const { taskService, projectService } = createTestServices();

    const compact = await gatherContext({ taskService, projectService }, { compact: true });
    expect(compact).toContain("Pending: 0");
    expect(compact).not.toContain("Overdue");
    expect(compact).not.toContain("Projects");
  });

  it("system message includes context block", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const contextBlock = "## Current Task Context\n- Total pending tasks: 5";

    const msg = manager.buildSystemMessage({ taskService, projectService }, contextBlock);
    expect(msg.content).toContain("Total pending tasks: 5");
    expect(msg.content).toContain("Saydo");
  });

  it("system message includes date and time", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const msg = manager.buildSystemMessage({ taskService, projectService });
    expect(msg.content).toContain("Current date/time:");
  });

  it("full prompt includes tool sections and behavioral rules", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const msg = manager.buildSystemMessage({ taskService, projectService });
    expect(msg.content).toContain("Analytical Tools");
    expect(msg.content).toContain("Project Tools");
    expect(msg.content).toContain("Reminder Tools");
    expect(msg.content).toContain("Always use tools");
    expect(msg.content).toContain("Never invent data");
  });

  it("cloud provider returns full prompt", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const msg = manager.buildSystemMessage({ taskService, projectService }, "", "openai");
    expect(msg.content).toContain("Analytical Tools");
    expect(msg.content).toContain("Act, then confirm");
    expect(msg.content).toContain("No sycophancy");
  });

  it("ollama provider returns compact prompt", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const msg = manager.buildSystemMessage({ taskService, projectService }, "", "ollama");
    expect(msg.content).not.toContain("Analytical Tools");
    expect(msg.content).not.toContain("## Behavior");
    expect(msg.content).toContain("ONLY do what the user asked");
    expect(msg.content).toContain("Use tools to act");
    expect(msg.content.length).toBeLessThan(500);
  });

  it("lmstudio provider returns compact prompt", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const msg = manager.buildSystemMessage({ taskService, projectService }, "", "lmstudio");
    expect(msg.content).not.toContain("Analytical Tools");
    expect(msg.content).toContain("ONLY do what the user asked");
  });

  it("both prompts contain tool grounding rule", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const full = manager.buildSystemMessage({ taskService, projectService }, "", "openai");
    const compact = manager.buildSystemMessage({ taskService, projectService }, "", "ollama");
    expect(full.content).toContain("Always use tools");
    expect(compact.content).toContain("Use tools to act");
  });

  it("both prompts contain date/time info", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const full = manager.buildSystemMessage({ taskService, projectService }, "", "anthropic");
    const compact = manager.buildSystemMessage({ taskService, projectService }, "", "ollama");
    // Both should contain a year somewhere
    const year = new Date().getFullYear().toString();
    expect(full.content).toContain(year);
    expect(compact.content).toContain(year);
  });

  it("default (no provider) returns full prompt", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const msg = manager.buildSystemMessage({ taskService, projectService });
    expect(msg.content).toContain("Analytical Tools");
  });
});

describe("Tool Filtering for Local Providers", () => {
  function createCapturingExecutor(): {
    executor: LLMExecutor;
    getCapturedTools: () => string[];
  } {
    let capturedTools: string[] = [];
    const executor: LLMExecutor = {
      getCapabilities: () => ({ ...DEFAULT_CAPABILITIES }),
      execute: async (ctx: LLMExecutionContext): Promise<PipelineResult> => {
        capturedTools = (ctx.request.tools ?? []).map((t) => t.name);
        return {
          mode: "stream",
          events: (async function* (): AsyncGenerator<StreamEvent> {
            yield { type: "token", data: "OK" };
          })(),
        };
      },
    };
    return { executor, getCapturedTools: () => capturedTools };
  }

  it("local provider (ollama) receives only essential tools", async () => {
    const { taskService, projectService } = createTestServices();
    const { executor, getCapturedTools } = createCapturingExecutor();
    const toolRegistry = createDefaultToolRegistry();

    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "test" },
      { toolRegistry, providerName: "ollama" },
    );

    session.addUserMessage("hello");
    for await (const _event of session.run()) {
      // drain
    }

    const tools = getCapturedTools();
    expect(tools).toContain("query_tasks");
    expect(tools).toContain("create_task");
    expect(tools).toContain("complete_task");
    expect(tools).toContain("list_projects");
    expect(tools).not.toContain("analyze_workload");
    expect(tools).not.toContain("suggest_tags");
    expect(tools).not.toContain("set_reminder");
    expect(tools.length).toBeLessThanOrEqual(6);
  });

  it("local provider (lmstudio) receives only essential tools", async () => {
    const { taskService, projectService } = createTestServices();
    const { executor, getCapturedTools } = createCapturingExecutor();
    const toolRegistry = createDefaultToolRegistry();

    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "test" },
      { toolRegistry, providerName: "lmstudio" },
    );

    session.addUserMessage("hello");
    for await (const _event of session.run()) {
      // drain
    }

    const tools = getCapturedTools();
    expect(tools.length).toBeLessThanOrEqual(6);
    expect(tools).not.toContain("find_similar_tasks");
  });

  it("cloud provider receives all tools", async () => {
    const { taskService, projectService } = createTestServices();
    const { executor, getCapturedTools } = createCapturingExecutor();
    const toolRegistry = createDefaultToolRegistry();

    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "test" },
      { toolRegistry, providerName: "openai" },
    );

    session.addUserMessage("hello");
    for await (const _event of session.run()) {
      // drain
    }

    const tools = getCapturedTools();
    expect(tools.length).toBe(25);
    expect(tools).toContain("analyze_workload");
    expect(tools).toContain("suggest_tags");
    expect(tools).toContain("break_down_task");
    expect(tools).toContain("check_duplicates");
    expect(tools).toContain("check_overcommitment");
  });

  it("breaks out of duplicate tool call loops", async () => {
    const { taskService, projectService } = createTestServices();
    await taskService.create({ title: "Existing", dueTime: false });

    // Mock executor that always returns the same tool call (hallucination loop)
    let callCount = 0;
    const executor: LLMExecutor = {
      getCapabilities: () => ({ ...DEFAULT_CAPABILITIES }),
      execute: async (): Promise<PipelineResult> => {
        callCount++;
        return {
          mode: "stream",
          events: (async function* (): AsyncGenerator<StreamEvent> {
            yield {
              type: "tool_call",
              data: JSON.stringify([
                { id: `call_${callCount}`, name: "query_tasks", arguments: "{}" },
              ]),
            };
          })(),
        };
      },
    };

    const toolRegistry = createToolRegistry();
    const session = new ChatSession(
      executor,
      { taskService, projectService },
      { role: "system", content: "test" },
      { toolRegistry, providerName: "ollama" },
    );

    session.addUserMessage("list tasks");
    const events: StreamEvent[] = [];
    for await (const event of session.run()) {
      events.push(event);
    }

    // Should break after detecting duplicate, not run 10 iterations
    expect(callCount).toBe(2);
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
