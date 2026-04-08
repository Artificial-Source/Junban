/**
 * Provider setup and default registry factory.
 * Creates the LLMProviderRegistry with all built-in providers registered.
 */

import { LLMProviderRegistry } from "./provider/registry.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("ai-provider");
import { openaiPlugin } from "./provider/adapters/openai.js";
import { anthropicPlugin } from "./provider/adapters/anthropic.js";
import { openrouterPlugin } from "./provider/adapters/openrouter.js";
import { ollamaPlugin } from "./provider/adapters/ollama.js";
import { lmstudioPlugin } from "./provider/adapters/lmstudio.js";
import { deepseekPlugin } from "./provider/adapters/deepseek.js";
import { geminiPlugin } from "./provider/adapters/gemini.js";
import { mistralPlugin } from "./provider/adapters/mistral.js";
import { kimiPlugin } from "./provider/adapters/kimi.js";
import { dashscopePlugin } from "./provider/adapters/dashscope.js";
import { groqPlugin } from "./provider/adapters/groq.js";
import { zaiPlugin } from "./provider/adapters/zai.js";

/** Create a provider registry with all built-in providers. */
export function createDefaultRegistry(): LLMProviderRegistry {
  const registry = new LLMProviderRegistry();
  registry.register(openaiPlugin);
  registry.register(anthropicPlugin);
  registry.register(openrouterPlugin);
  registry.register(ollamaPlugin);
  registry.register(lmstudioPlugin);
  registry.register(deepseekPlugin);
  registry.register(geminiPlugin);
  registry.register(mistralPlugin);
  registry.register(kimiPlugin);
  registry.register(dashscopePlugin);
  registry.register(groqPlugin);
  registry.register(zaiPlugin);
  logger.info("LLM provider registry initialized", { providers: 12 });
  return registry;
}
