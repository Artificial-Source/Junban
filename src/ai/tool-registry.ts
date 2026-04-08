import { createLogger } from "../utils/logger.js";
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
import { registerPlanMyDayTool, registerDailyReviewTool } from "./tools/builtin/daily-planning.js";
import { registerProductivityStatsTool } from "./tools/builtin/productivity-stats.js";
import { registerMemoryTools } from "./tools/builtin/memory-tools.js";
import { registerBulkOperationTools } from "./tools/builtin/bulk-operations.js";
import { registerTimeEstimationTools } from "./tools/builtin/time-estimation.js";
import { registerWeeklyReviewTool } from "./tools/builtin/weekly-review.js";
import { registerExtractTasksFromTextTool } from "./tools/builtin/extract-tasks-from-text.js";

const logger = createLogger("ai-tool-registry");

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
  registerPlanMyDayTool(registry);
  registerDailyReviewTool(registry);
  registerProductivityStatsTool(registry);
  registerMemoryTools(registry);
  registerBulkOperationTools(registry);
  registerTimeEstimationTools(registry);
  registerWeeklyReviewTool(registry);
  registerExtractTasksFromTextTool(registry);
  logger.info("Tool registry initialized", { tools: registry.size });
  return registry;
}
