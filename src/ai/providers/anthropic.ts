import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider } from "../provider.js";
import type {
  AIProviderConfig,
  ChatMessage,
  ChatResponse,
  StreamEvent,
  ToolDefinition,
} from "../types.js";
import { classifyProviderError, type StreamErrorData } from "../errors.js";

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // system is handled separately

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
      // Anthropic expects tool results as user messages
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

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;

  constructor(config: AIProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
    this.model = config.model ?? "claude-sonnet-4-5-20250929";
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    const systemMessage = messages.find((m) => m.role === "system");

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      ...(systemMessage ? { system: systemMessage.content } : {}),
      messages: toAnthropicMessages(messages),
      ...(tools?.length ? { tools: toAnthropicTools(tools) } : {}),
    });

    let content = "";
    const toolCalls: { id: string; name: string; arguments: string }[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  async *streamChat(messages: ChatMessage[], tools?: ToolDefinition[]): AsyncIterable<StreamEvent> {
    try {
      const systemMessage = messages.find((m) => m.role === "system");

      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 4096,
        ...(systemMessage ? { system: systemMessage.content } : {}),
        messages: toAnthropicMessages(messages),
        ...(tools?.length ? { tools: toAnthropicTools(tools) } : {}),
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

      if (toolCalls.length > 0) {
        yield { type: "tool_call", data: JSON.stringify(toolCalls) };
      } else {
        yield { type: "done", data: "" };
      }
    } catch (err) {
      const aiError = classifyProviderError(err);
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
