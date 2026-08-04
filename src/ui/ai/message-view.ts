/**
 * Dumb presentational view-model for AI chat messages.
 * Produced only by the pure mapper — components do not parse DTOs.
 */

export type ChatToolProposal = {
  approvalId: string;
  tool: string;
  arguments: Record<string, unknown>;
  actionHash: string;
  expiresAt: string;
  /** Pending until user decides or stream records a decision. */
  decision: "pending" | "approved" | "rejected";
  /** True while an approve/reject request is in flight. */
  decisionPending?: boolean;
};

export type ChatToolResult = {
  tool: string;
  outcome: string;
  data: unknown;
  truncated: boolean;
  operationId: string | null;
  revision: number | null;
};

export type ChatSegment =
  | { kind: "text"; text: string }
  | { kind: "tool_proposed"; proposal: ChatToolProposal }
  | { kind: "tool_result"; result: ChatToolResult }
  | { kind: "tool_badge"; tool: string; arguments: unknown; complete: boolean };

export type ChatMessageView = {
  id: string;
  role: "user" | "assistant" | "system" | "error";
  status: "pending" | "streaming" | "completed" | "failed" | "cancelled";
  /** Plain text body (user) or full assistant text. */
  text: string;
  createdAt: string;
  sequence: number;
  turnId: string;
  focusedTaskId: string | null;
  briefingDate: string | null;
  /** Ordered render segments for assistant messages. */
  segments: ChatSegment[];
  /** Pending/decided proposals for approval UI. */
  proposals: ChatToolProposal[];
  isError: boolean;
  retryable: boolean;
  /** Optimistic client-only row (not yet confirmed by server). */
  optimistic?: boolean;
  /** Streaming overlay flag. */
  streaming?: boolean;
  /** Short reasoning status label only (never hidden CoT). */
  reasoningStatus?: string | null;
};

export type ChatSessionView = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  status: "active" | "archived";
};
