/**
 * Extensible tool registry.
 * Built-in tools are registered at startup; plugins can add tools at runtime.
 */

import type { ToolDefinition, ToolExecutor, ToolContext, RegisteredTool } from "./types.js";
import { createLogger } from "../../utils/logger.js";
import { TOOL_EXECUTION_TIMEOUT_MS } from "../../config/defaults.js";

const logger = createLogger("tool-registry");

export interface ToolRegistryOptions {
  executionTimeoutMs?: number;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private executionTimeoutMs: number;

  constructor(options: ToolRegistryOptions = {}) {
    this.executionTimeoutMs = options.executionTimeoutMs ?? TOOL_EXECUTION_TIMEOUT_MS;
  }

  /** Register a tool. Throws if a tool with the same name already exists. */
  register(definition: ToolDefinition, executor: ToolExecutor, source = "builtin"): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered`);
    }
    this.tools.set(definition.name, { definition, executor, source });
    logger.debug("Tool registered", { name: definition.name, source });
  }

  /** Unregister a tool by name. */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** Unregister all tools from a given source (e.g., a plugin ID). */
  unregisterBySource(source: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.source === source) {
        this.tools.delete(name);
      }
    }
  }

  /** Remove all registered tools. */
  clear(): void {
    this.tools.clear();
  }

  /** Get all tool definitions (for passing to LLM providers). */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** Get a single registered tool by name. */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get the number of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  /** Execute a tool by name. Throws if the tool is not found. */
  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      logger.warn("Unknown tool requested", { name });
      throw new Error(`Unknown tool: ${name}`);
    }
    logger.debug("Executing tool", { name });
    const timeoutMs = this.executionTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return tool.executor(args, ctx);
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        tool.executor(args, ctx),
        new Promise<string>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
