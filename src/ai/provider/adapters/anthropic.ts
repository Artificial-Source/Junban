/**
 * Anthropic provider adapter — standalone implementation.
 * Uses the Anthropic SDK directly (different API format from OpenAI).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LLMProviderPlugin, LLMExecutor } from "../interface.js";
import type { LLMCapabilities, ModelDescriptor } from "../../core/capabilities.js";
import type { LLMExecutionContext, PipelineResult } from "../../core/context.js";
import type { AIProviderConfig, ChatMessage, StreamEvent, ToolDefinition } from "../../types.js";
import { classifyProviderError, type StreamErrorData } from "../../errors.js";
import { DEFAULT_CAPABILITIES } from "../../core/capabilities.js";

const ANTHROPIC_MODELS = [
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-6",
  "claude-haiku-4-5-20251001",
];

// ── Message/tool conversion helpers ──

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      const content: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.arguments),
        });
      }
      result.push({ role: "assistant", content });
      continue;
    }

    if (msg.role === "tool") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId!,
            content: msg.content,
          },
        ],
      });
      continue;
    }

    result.push({ role: msg.role as "user" | "assistant", content: msg.content });
  }

  return result;
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

// ── Executor ──

class AnthropicExecutor implements LLMExecutor {
  private client: Anthropic;
  private model: string;
  private providerName: string;

  constructor(client: Anthropic, model: string, providerName: string) {
    this.client = client;
    this.model = model;
    this.providerName = providerName;
  }

  getCapabilities(_modelId: string): LLMCapabilities {
    return { ...DEFAULT_CAPABILITIES, vision: true };
  }

  async execute(ctx: LLMExecutionContext): Promise<PipelineResult> {
    const { request } = ctx;
    const model = request.model || this.model;

    return {
      mode: "stream",
      events: this.streamResponse(model, request.messages, request.tools),
    };
  }

  private async *streamResponse(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    try {
      const systemMessage = messages.find((m) => m.role === "system");
      const anthropicTools = tools?.length ? toAnthropicTools(tools) : undefined;

      const stream = this.client.messages.stream({
        model,
        max_tokens: 4096,
        ...(systemMessage ? { system: systemMessage.content } : {}),
        messages: toAnthropicMessages(messages),
        ...(anthropicTools ? { tools: anthropicTools } : {}),
      });

      const toolCalls: { id: string; name: string; arguments: string }[] = [];
      let currentToolId = "";
      let currentToolName = "";
      let currentToolArgs = "";
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            currentToolArgs = "";
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "token", data: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            currentToolArgs += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          if (currentToolId) {
            toolCalls.push({
              id: currentToolId,
              name: currentToolName,
              arguments: currentToolArgs,
            });
            currentToolId = "";
          }
        }
      }

      // Check if response was truncated due to token limit
      const finalMessage = await stream.finalMessage();
      if (finalMessage.stop_reason === "max_tokens" && toolCalls.length === 0) {
        yield { type: "token", data: "\n\n_(Response truncated due to length limit)_" };
      }

      if (toolCalls.length > 0) {
        yield { type: "tool_call", data: JSON.stringify(toolCalls) };
      } else {
        yield { type: "done", data: "" };
      }
    } catch (err) {
      const aiError = classifyProviderError(err, this.providerName);
      const errorData: StreamErrorData = {
        message: aiError.message,
        category: aiError.category,
        retryable: aiError.retryable,
        ...(aiError.retryAfterMs !== undefined ? { retryAfterMs: aiError.retryAfterMs } : {}),
      };
      yield { type: "error", data: JSON.stringify(errorData) };
    }
  }
}

// ── Plugin ──

export const anthropicPlugin: LLMProviderPlugin = {
  name: "anthropic",
  displayName: "Anthropic",
  needsApiKey: true,
  defaultModel: "claude-sonnet-4-5-20250929",

  createExecutor(config: AIProviderConfig): LLMExecutor {
    const client = new Anthropic({ apiKey: config.apiKey });
    const model = config.model ?? "claude-sonnet-4-5-20250929";
    return new AnthropicExecutor(client, model, "anthropic");
  },

  async discoverModels(_config: AIProviderConfig): Promise<ModelDescriptor[]> {
    return ANTHROPIC_MODELS.map((id) => ({
      id,
      label: id,
      capabilities: { ...DEFAULT_CAPABILITIES, vision: true },
      loaded: true,
    }));
  },
};
