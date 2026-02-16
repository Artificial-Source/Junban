/**
 * Provider setup and default registry factory.
 * Creates the LLMProviderRegistry with all built-in providers registered.
 */

import { LLMProviderRegistry } from "./provider/registry.js";
import { openaiPlugin } from "./provider/adapters/openai.js";
import { anthropicPlugin } from "./provider/adapters/anthropic.js";
import { openrouterPlugin } from "./provider/adapters/openrouter.js";
import { ollamaPlugin } from "./provider/adapters/ollama.js";
import { lmstudioPlugin } from "./provider/adapters/lmstudio.js";
import { ToolRegistry } from "./tools/registry.js";
import { registerTaskCrudTools } from "./tools/builtin/task-crud.js";
import { registerQueryTasksTool } from "./tools/builtin/query-tasks.js";
import { registerAnalyzePatternsTool } from "./tools/builtin/analyze-patterns.js";
import { registerAnalyzeWorkloadTool } from "./tools/builtin/analyze-workload.js";
import { registerSmartOrganizeTools } from "./tools/builtin/smart-organize.js";
import { registerEnergyRecommendationsTool } from "./tools/builtin/energy-recommendations.js";

/** Create a provider registry with all built-in providers. */
export function createDefaultRegistry(): LLMProviderRegistry {
  const registry = new LLMProviderRegistry();
  registry.register(openaiPlugin);
  registry.register(anthropicPlugin);
  registry.register(openrouterPlugin);
  registry.register(ollamaPlugin);
  registry.register(lmstudioPlugin);
  return registry;
}

/** Create a tool registry with all built-in tools. */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerTaskCrudTools(registry);
  registerQueryTasksTool(registry);
  registerAnalyzePatternsTool(registry);
  registerAnalyzeWorkloadTool(registry);
  registerSmartOrganizeTools(registry);
  registerEnergyRecommendationsTool(registry);
  return registry;
}
