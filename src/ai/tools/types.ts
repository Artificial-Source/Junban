/**
 * Tool system types for the extensible tool registry.
 * Both built-in tools and plugin-contributed tools use these types.
 */

import type { TaskService } from "../../core/tasks.js";
import type { ProjectService } from "../../core/projects.js";
import type { TagService } from "../../core/tags.js";

/** JSON Schema tool definition passed to LLM providers. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Services available to tool executors. */
export interface ToolContext {
  taskService: TaskService;
  projectService: ProjectService;
  tagService?: TagService;
}

/** Function that executes a tool and returns a JSON string result. */
export type ToolExecutor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

/** A tool as stored in the registry. */
export interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
  source: string; // "builtin" or plugin ID
}
