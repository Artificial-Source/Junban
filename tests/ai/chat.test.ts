import { describe, it, expect, vi } from "vitest";
import { ChatSession, ChatManager } from "../../src/ai/chat.js";
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

describe("ChatSession", () => {
  it("tracks message history", () => {
    const provider = createMockProvider([]);
    const { taskService, projectService } = createTestServices();
    const session = new ChatSession(
      provider,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
    );

    session.addUserMessage("Hello");
    const messages = session.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello");
  });

  it("appends assistant response after run", async () => {
    const provider = createMockProvider([{ content: "Hello! How can I help?" }]);
    const { taskService, projectService } = createTestServices();
    const session = new ChatSession(
      provider,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
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

  it("yields structured error event when provider streamChat errors", async () => {
    const { taskService, projectService } = createTestServices();

    const provider: AIProvider = {
      chat: vi.fn(),
      async *streamChat(): AsyncIterable<StreamEvent> {
        // Provider yields a structured error (as OpenAI/Anthropic wrappers now do)
        yield {
          type: "error",
          data: JSON.stringify({
            message: "Authentication failed. Please check your API key in Settings.",
            category: "auth",
            retryable: false,
          }),
        };
      },
    };

    const session = new ChatSession(
      provider,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
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

    const provider: AIProvider = {
      chat: vi.fn(),
      async *streamChat(): AsyncIterable<StreamEvent> {
        yield { type: "token", data: "Here is some partial " };
        yield { type: "token", data: "content" };
        // Then an error occurs
        yield {
          type: "error",
          data: JSON.stringify({
            message: "Stream interrupted",
            category: "network",
            retryable: true,
          }),
        };
      },
    };

    const session = new ChatSession(
      provider,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
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

    const provider: AIProvider = {
      chat: vi.fn(),
      async *streamChat(): AsyncIterable<StreamEvent> {
        yield { type: "token", data: "partial" };
        throw Object.assign(new Error("Server Error"), { status: 500 });
      },
    };

    const session = new ChatSession(
      provider,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
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

  it("emits structured error for too many iterations", async () => {
    const { taskService, projectService } = createTestServices();

    // Provider always returns tool calls, never text-only
    let callCount = 0;
    const provider: AIProvider = {
      chat: vi.fn(),
      async *streamChat(): AsyncIterable<StreamEvent> {
        callCount++;
        yield {
          type: "tool_call",
          data: JSON.stringify([
            { id: `call_${callCount}`, name: "list_tasks", arguments: "{}" },
          ]),
        };
      },
    };

    const session = new ChatSession(
      provider,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
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
    expect(parsed.category).toBe("unknown");
  });

  it("handles tool call loop", async () => {
    const { taskService, projectService } = createTestServices();

    const provider = createMockProvider([
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
      provider,
      { taskService, projectService },
      { role: "system", content: "You are helpful." },
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
    const provider = createMockProvider([]);
    const { taskService, projectService } = createTestServices();
    const services = { taskService, projectService };

    const s1 = manager.getOrCreateSession(provider, services);
    const s2 = manager.getOrCreateSession(provider, services);
    expect(s1).toBe(s2);
  });

  it("clearSession resets session", () => {
    const manager = new ChatManager();
    const provider = createMockProvider([]);
    const { taskService, projectService } = createTestServices();
    const services = { taskService, projectService };

    manager.getOrCreateSession(provider, services);
    manager.clearSession();
    expect(manager.getSession()).toBeNull();
  });

  it("resetWithProvider creates new session", () => {
    const manager = new ChatManager();
    const provider1 = createMockProvider([]);
    const provider2 = createMockProvider([]);
    const { taskService, projectService } = createTestServices();
    const services = { taskService, projectService };

    const s1 = manager.getOrCreateSession(provider1, services);
    const s2 = manager.resetWithProvider(provider2, services);
    expect(s1).not.toBe(s2);
  });
});
