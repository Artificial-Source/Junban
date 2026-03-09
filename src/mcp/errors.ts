/**
 * Error mapping for MCP tool responses.
 * Converts Saydo error classes to MCP-compatible error content.
 */

import { NotFoundError, ValidationError, StorageError } from "../core/errors.js";

export interface McpErrorContent {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

/** Map a caught error to an MCP error response with isError: true. */
export function toMcpError(err: unknown): McpErrorContent {
  if (err instanceof NotFoundError) {
    return {
      content: [{ type: "text", text: err.message }],
      isError: true,
    };
  }

  if (err instanceof ValidationError) {
    return {
      content: [{ type: "text", text: `Validation error: ${err.message}` }],
      isError: true,
    };
  }

  if (err instanceof StorageError) {
    return {
      content: [{ type: "text", text: `Storage error: ${err.message}` }],
      isError: true,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}
