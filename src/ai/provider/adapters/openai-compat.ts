/**
 * Shared base for OpenAI-compatible providers.
 * OpenAI, OpenRouter, Ollama, and LM Studio all use the OpenAI API format.
 * This factory creates a full LLMProviderPlugin with customizable config.
 */

import OpenAI from "openai";
import type { LLMProviderPlugin, LLMExecutor } from "../interface.js";
import type { LLMCapabilities, ModelDescriptor } from "../../core/capabilities.js";
import type { LLMExecutionContext, PipelineResult } from "../../core/context.js";
import type {
  AIProviderConfig,
  ChatMessage,
  StreamEvent,
  ToolCall,
  ToolDefinition,
} from "../../types.js";
import { classifyProviderError, type StreamErrorData } from "../../errors.js";
import { DEFAULT_CAPABILITIES } from "../../core/capabilities.js";

// ── Message/tool conversion helpers ──

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

// ── Executor ──

class OpenAICompatExecutor implements LLMExecutor {
  private client: OpenAI;
  private model: string;
  private providerName: string;

  constructor(client: OpenAI, model: string, providerName: string) {
    this.client = client;
    this.model = model;
    this.providerName = providerName;
  }

  getCapabilities(_modelId: string): LLMCapabilities {
    return { ...DEFAULT_CAPABILITIES };
  }

  async execute(ctx: LLMExecutionContext): Promise<PipelineResult> {
    const { request } = ctx;
    const model = request.model || this.model;
    const messages = toOpenAIMessages(request.messages);
    const tools = request.tools?.length ? toOpenAITools(request.tools) : undefined;

    return {
      mode: "stream",
      events: this.streamResponse(model, messages, tools),
    };
  }

  private async *streamResponse(
    model: string,
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
  ): AsyncGenerator<StreamEvent> {
    try {
      const stream = await this.client.chat.completions.create({
        model,
        max_tokens: 4096,
        messages,
        stream: true,
        ...(tools ? { tools } : {}),
      });

      const toolCalls: Map<number, ToolCall> = new Map();
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: "token", data: delta.content };
        }

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

      // If truncated due to token limit, append indicator
      if (finishReason === "length" && toolCalls.size === 0) {
        yield { type: "token", data: "\n\n_(Response truncated due to length limit)_" };
      }

      if (toolCalls.size > 0) {
        yield { type: "tool_call", data: JSON.stringify(Array.from(toolCalls.values())) };
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

// ── Plugin factory ──

export interface OpenAICompatConfig {
  name: string;
  displayName: string;
  needsApiKey: boolean;
  /** When true, shows API key field but doesn't require it (e.g., LM Studio remote). */
  optionalApiKey?: boolean;
  defaultModel: string;
  defaultBaseUrl?: string;
  showBaseUrl?: boolean;
  /** Override API key for providers that don't need real keys (Ollama, LM Studio). */
  fakeApiKey?: string;
  /** Custom default headers (e.g., OpenRouter requires HTTP-Referer). */
  defaultHeaders?: Record<string, string>;
  /** Filter function for model discovery. */
  modelFilter?: (id: string) => boolean;
  /** Custom model discovery function (e.g., Ollama's native /api/tags). */
  discoverModels?: (config: AIProviderConfig) => Promise<ModelDescriptor[]>;
  /** Custom model loader (e.g., LM Studio). */
  loadModel?: (modelKey: string, config: AIProviderConfig) => Promise<void>;
  /** Custom model unloader (e.g., LM Studio). */
  unloadModel?: (modelKey: string, config: AIProviderConfig) => Promise<void>;
}

const FETCH_TIMEOUT_MS = 5000;

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Default OpenAI-compatible model discovery via GET /v1/models. */
async function defaultDiscoverModels(
  _config: AIProviderConfig,
  baseUrl: string,
  apiKey: string,
  modelFilter?: (id: string) => boolean,
): Promise<ModelDescriptor[]> {
  const res = await fetchWithTimeout(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { data?: { id: string }[] };
  let models = (data.data ?? []).map((m) => m.id);
  if (modelFilter) models = models.filter(modelFilter);
  return models.sort().map((id) => ({
    id,
    label: id,
    capabilities: { ...DEFAULT_CAPABILITIES },
    loaded: true,
  }));
}

/**
 * Factory function that creates an LLMProviderPlugin for any OpenAI-compatible API.
 * Used by openai.ts, openrouter.ts, ollama.ts, and lmstudio.ts.
 */
export function createOpenAICompatPlugin(cfg: OpenAICompatConfig): LLMProviderPlugin {
  return {
    name: cfg.name,
    displayName: cfg.displayName,
    needsApiKey: cfg.needsApiKey,
    optionalApiKey: cfg.optionalApiKey,
    defaultModel: cfg.defaultModel,
    defaultBaseUrl: cfg.defaultBaseUrl,
    showBaseUrl: cfg.showBaseUrl,

    createExecutor(config: AIProviderConfig): LLMExecutor {
      const apiKey = config.apiKey ?? cfg.fakeApiKey ?? "not-needed";
      const baseURL = config.baseUrl ?? cfg.defaultBaseUrl;
      const client = new OpenAI({
        apiKey,
        baseURL,
        ...(cfg.defaultHeaders ? { defaultHeaders: cfg.defaultHeaders } : {}),
      });
      const model = config.model ?? cfg.defaultModel;
      return new OpenAICompatExecutor(client, model, cfg.name);
    },

    async discoverModels(config: AIProviderConfig): Promise<ModelDescriptor[]> {
      if (cfg.discoverModels) {
        return cfg.discoverModels(config);
      }
      const apiKey = config.apiKey ?? cfg.fakeApiKey ?? "";
      if (cfg.needsApiKey && !apiKey) return [];
      const baseUrl = config.baseUrl ?? cfg.defaultBaseUrl ?? "https://api.openai.com/v1";
      return defaultDiscoverModels(config, baseUrl, apiKey, cfg.modelFilter);
    },

    ...(cfg.loadModel ? { loadModel: cfg.loadModel } : {}),
    ...(cfg.unloadModel ? { unloadModel: cfg.unloadModel } : {}),
  };
}
