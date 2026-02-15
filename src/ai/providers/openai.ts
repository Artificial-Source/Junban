import OpenAI from "openai";
import type { AIProvider } from "../provider.js";
import type {
  AIProviderConfig,
  ChatMessage,
  ChatResponse,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from "../types.js";
import { classifyProviderError, type StreamErrorData } from "../errors.js";

function toOpenAIMessages(messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool" as const,
        content: msg.content,
        tool_call_id: msg.toolCallId!,
      };
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant" as const,
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return { role: msg.role, content: msg.content } as OpenAI.ChatCompletionMessageParam;
  });
}

function toOpenAITools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function parseToolCalls(choices: OpenAI.ChatCompletion.Choice[]): ToolCall[] | undefined {
  const calls = choices[0]?.message?.tool_calls;
  if (!calls?.length) return undefined;
  return calls
    .filter(
      (tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: "function" } =>
        tc.type === "function",
    )
    .map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
}

export class OpenAIProvider implements AIProvider {
  protected client: OpenAI;
  protected model: string;

  constructor(config: AIProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? "not-needed",
      baseURL: config.baseUrl,
    });
    this.model = config.model ?? "gpt-4o";
  }

  async chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAIMessages(messages),
      ...(tools?.length ? { tools: toOpenAITools(tools) } : {}),
    });

    const choice = response.choices[0];
    return {
      content: choice?.message?.content ?? "",
      toolCalls: parseToolCalls(response.choices),
    };
  }

  async *streamChat(messages: ChatMessage[], tools?: ToolDefinition[]): AsyncIterable<StreamEvent> {
    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: toOpenAIMessages(messages),
        stream: true,
        ...(tools?.length ? { tools: toOpenAITools(tools) } : {}),
      });

      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        // Stream text tokens
        if (delta.content) {
          yield { type: "token", data: delta.content };
        }

        // Accumulate tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (existing) {
              existing.arguments += tc.function?.arguments ?? "";
            } else {
              toolCalls.set(tc.index, {
                id: tc.id ?? "",
                name: tc.function?.name ?? "",
                arguments: tc.function?.arguments ?? "",
              });
            }
          }
        }
      }

      // Emit accumulated tool calls
      if (toolCalls.size > 0) {
        const calls = Array.from(toolCalls.values());
        yield { type: "tool_call", data: JSON.stringify(calls) };
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
