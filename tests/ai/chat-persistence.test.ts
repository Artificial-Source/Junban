import { describe, it, expect, vi } from "vitest";
import { ChatSession, ChatManager, gatherContext } from "../../src/ai/chat.js";
import type { AIProvider } from "../../src/ai/provider.js";
import type { ChatResponse, StreamEvent } from "../../src/ai/types.js";
import { createTestServices } from "../integration/helpers.js";

function createMockProvider(
  responses: Array<{ content: string; toolCalls?: ChatResponse["toolCalls"] }>,
): AIProvider {
  let callCount = 0;
  return {
    chat: vi.fn(),
    async *streamChat(): AsyncIterable<StreamEvent> {
      const response = responses[callCount++];
      if (!response) return;

      if (response.content) {
        yield { type: "token", data: response.content };
      }
      if (response.toolCalls?.length) {
        yield { type: "tool_call", data: JSON.stringify(response.toolCalls) };
      } else {
        yield { type: "done", data: "" };
      }
    },
  };
}

describe("Chat Persistence", () => {
  it("persists messages to SQLite", async () => {
    const { taskService, projectService, storage } = createTestServices();
    const provider = createMockProvider([{ content: "Hi there!" }]);
    const session = new ChatSession(
      provider,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      undefined,
      storage,
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
    const provider = createMockProvider([
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "list_tasks", arguments: "{}" }],
      },
      { content: "You have no tasks." },
    ]);

    const session = new ChatSession(
      provider,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
      undefined,
      storage,
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
    const provider = createMockProvider([{ content: "Hello!" }]);
    const services = { taskService, projectService };

    // Create and populate a session
    const manager1 = new ChatManager();
    const session1 = manager1.getOrCreateSession(provider, services, storage);
    session1.addUserMessage("Hi");
    for await (const _event of session1.run()) {
      // drain
    }
    const sessionId = session1.sessionId;

    // Now restore from a fresh manager
    const manager2 = new ChatManager();
    const provider2 = createMockProvider([]);
    const restored = manager2.restoreSession(provider2, services, storage);

    expect(restored).not.toBeNull();
    expect(restored!.sessionId).toBe(sessionId);
    const messages = restored!.getMessages();
    expect(messages.some((m) => m.role === "user" && m.content === "Hi")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.content === "Hello!")).toBe(true);
  });

  it("clearSession deletes from DB", async () => {
    const { taskService, projectService, storage } = createTestServices();
    const provider = createMockProvider([{ content: "Hello!" }]);
    const services = { taskService, projectService };

    const manager = new ChatManager();
    const session = manager.getOrCreateSession(provider, services, storage);
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
    const provider = createMockProvider([]);
    const manager = new ChatManager();
    const restored = manager.restoreSession(provider, { taskService, projectService }, storage);
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

  it("system message includes context block", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const contextBlock = "## Current Task Context\n- Total pending tasks: 5";

    const msg = manager.buildSystemMessage({ taskService, projectService }, contextBlock);
    expect(msg.content).toContain("Total pending tasks: 5");
    expect(msg.content).toContain("Docket's AI assistant");
  });

  it("system message includes date and time", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const msg = manager.buildSystemMessage({ taskService, projectService });
    expect(msg.content).toContain("Current date and time:");
  });

  it("system message includes follow-up question guidelines", () => {
    const { taskService, projectService } = createTestServices();
    const manager = new ChatManager();
    const msg = manager.buildSystemMessage({ taskService, projectService });
    expect(msg.content).toContain("Ask Before Acting");
    expect(msg.content).toContain("Daily Planning");
    expect(msg.content).toContain("Priority Suggestions");
  });
});
