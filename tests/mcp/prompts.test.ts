import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMcpTestEnv } from "./helpers.js";

let env: Awaited<ReturnType<typeof createMcpTestEnv>>;

describe("MCP Prompts", () => {
  beforeEach(async () => {
    env = await createMcpTestEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("lists all prompts", async () => {
    const result = await env.client.listPrompts();
    const names = result.prompts.map((p) => p.name);
    expect(names).toContain("plan-my-day");
    expect(names).toContain("daily-review");
    expect(names).toContain("quick-capture");
  });

  it("plan-my-day returns well-formed messages", async () => {
    const result = await env.client.getPrompt({
      name: "plan-my-day",
      arguments: { energy_level: "high" },
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");

    const content = result.messages[0].content;
    expect(content).toBeDefined();
    const text =
      typeof content === "string" ? content : (content as { type: string; text: string }).text;
    expect(text).toContain("high");
    expect(text).toContain("Plan my day");
  });

  it("plan-my-day defaults energy to medium", async () => {
    const result = await env.client.getPrompt({
      name: "plan-my-day",
      arguments: {},
    });
    const content = result.messages[0].content;
    const text =
      typeof content === "string" ? content : (content as { type: string; text: string }).text;
    expect(text).toContain("medium");
  });

  it("daily-review returns well-formed messages", async () => {
    const result = await env.client.getPrompt({
      name: "daily-review",
      arguments: { date: "2026-02-25" },
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");

    const content = result.messages[0].content;
    const text =
      typeof content === "string" ? content : (content as { type: string; text: string }).text;
    expect(text).toContain("2026-02-25");
    expect(text).toContain("Review my day");
  });

  it("daily-review defaults to today", async () => {
    const result = await env.client.getPrompt({
      name: "daily-review",
      arguments: {},
    });
    const content = result.messages[0].content;
    const text =
      typeof content === "string" ? content : (content as { type: string; text: string }).text;
    const today = new Date().toISOString().split("T")[0];
    expect(text).toContain(today);
  });

  it("quick-capture returns well-formed messages", async () => {
    const result = await env.client.getPrompt({
      name: "quick-capture",
      arguments: { task: "Buy milk tomorrow p2 #groceries" },
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");

    const content = result.messages[0].content;
    const text =
      typeof content === "string" ? content : (content as { type: string; text: string }).text;
    expect(text).toContain("Buy milk tomorrow p2 #groceries");
    expect(text).toContain("create_task");
  });

  it("all prompts have descriptions", async () => {
    const result = await env.client.listPrompts();
    for (const prompt of result.prompts) {
      expect(prompt.description).toBeTruthy();
    }
  });
});
