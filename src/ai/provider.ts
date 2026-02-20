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
import { ToolRegistry } from "./tools/registry.js";
import { registerTaskCrudTools } from "./tools/builtin/task-crud.js";
import { registerQueryTasksTool } from "./tools/builtin/query-tasks.js";
import { registerAnalyzePatternsTool } from "./tools/builtin/analyze-patterns.js";
import {
  registerAnalyzeWorkloadTool,
  registerCheckOvercommitmentTool,
} from "./tools/builtin/analyze-workload.js";
import {
  registerSmartOrganizeTools,
  registerCheckDuplicatesTool,
} from "./tools/builtin/smart-organize.js";
import { registerEnergyRecommendationsTool } from "./tools/builtin/energy-recommendations.js";
import { registerProjectCrudTools } from "./tools/builtin/project-crud.js";
import { registerReminderTools } from "./tools/builtin/reminder-tools.js";
import { registerTaskBreakdownTool } from "./tools/builtin/task-breakdown.js";
import { registerTagCrudTools } from "./tools/builtin/tag-crud.js";

/** Create a provider registry with all built-in providers. */
export function createDefaultRegistry(): LLMProviderRegistry {
  const registry = new LLMProviderRegistry();
  registry.register(openaiPlugin);
  registry.register(anthropicPlugin);
  registry.register(openrouterPlugin);
  registry.register(ollamaPlugin);
  registry.register(lmstudioPlugin);
  logger.info("LLM provider registry initialized", { providers: 5 });
  return registry;
}

/** Create a tool registry with all built-in tools. */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerTaskCrudTools(registry);
  registerQueryTasksTool(registry);
  registerProjectCrudTools(registry);
  registerReminderTools(registry);
  registerAnalyzePatternsTool(registry);
  registerAnalyzeWorkloadTool(registry);
  registerCheckOvercommitmentTool(registry);
  registerSmartOrganizeTools(registry);
  registerCheckDuplicatesTool(registry);
  registerEnergyRecommendationsTool(registry);
  registerTaskBreakdownTool(registry);
  registerTagCrudTools(registry);
  logger.info("Tool registry initialized", { tools: registry.size });
  return registry;
}
