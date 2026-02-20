/**
 * Provider plugin and executor interfaces.
 * Each AI provider implements LLMProviderPlugin (registration + factory)
 * and LLMExecutor (runtime execution).
 */

import type { LLMCapabilities, ModelDescriptor } from "../core/capabilities.js";
import type { LLMExecutionContext, PipelineResult } from "../core/context.js";
import type { AIProviderConfig } from "../types.js";

/**
 * Registration interface for an LLM provider.
 * Provides metadata, executor factory, and model discovery.
 */
export interface LLMProviderPlugin {
  readonly name: string;
  readonly displayName: string;
  readonly needsApiKey: boolean;
  /** When true, shows the API key field in the UI but doesn't require it. */
  readonly optionalApiKey?: boolean;
  readonly defaultModel: string;
  readonly defaultBaseUrl?: string;
  readonly showBaseUrl?: boolean;

  /** Create an executor instance for the given config. */
  createExecutor(config: AIProviderConfig): LLMExecutor;

  /** Discover available models from this provider. */
  discoverModels(config: AIProviderConfig): Promise<ModelDescriptor[]>;

  /** Load a model (for local providers like LM Studio). */
  loadModel?(modelKey: string, config: AIProviderConfig): Promise<void>;

  /** Unload a model (for local providers like LM Studio). */
  unloadModel?(modelKey: string, config: AIProviderConfig): Promise<void>;
}

/**
 * Runtime execution interface for LLM requests.
 * Created by LLMProviderPlugin.createExecutor().
 */
export interface LLMExecutor {
  /** Execute a request and return either a complete response or a stream. */
  execute(ctx: LLMExecutionContext): Promise<PipelineResult>;

  /** Report capabilities for a given model. */
  getCapabilities(modelId: string): LLMCapabilities;
}
