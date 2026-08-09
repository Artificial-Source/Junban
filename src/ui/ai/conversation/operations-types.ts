/**
 * Narrow stream-result shapes for operation retention (avoids circular imports).
 */

import type { AiRunStreamState, AiRunTerminalView } from "../types";

export type { AiRunStreamState, AiRunTerminalView };

export type AiStreamResultLike = {
  operationId?: string;
  state?: AiRunStreamState;
};
