/**
 * Pure mapper: AiMessageDto → ChatMessageView.
 * Interleaves durable tool events at UTF-8 byte offsets without splitting text.
 */

import type { AiMessageDto, AiToolEventDto } from "./types";
import type {
  ChatMessageView,
  ChatSegment,
  ChatToolProposal,
  ChatToolResult,
} from "./message-view";
import { utf8ByteOffsetToStringIndex } from "./utf8";

type ToolProposedPayload = {
  approval_id?: unknown;
  tool?: unknown;
  arguments?: unknown;
  action_hash?: unknown;
  expires_at?: unknown;
};

type ToolDecisionPayload = {
  approval_id?: unknown;
  decision?: unknown;
};

type ToolResultPayload = {
  tool?: unknown;
  outcome?: unknown;
  data?: unknown;
  truncated?: unknown;
  operation_id?: unknown;
  revision?: unknown;
};

/**
 * Map one durable/server message DTO into a presentational view model.
 */
export function mapAiMessageDto(dto: AiMessageDto): ChatMessageView {
  const role = mapRole(dto.role, dto.status);
  const text = typeof dto.content.text === "string" ? dto.content.text : "";
  const focusedTaskId = dto.content.focused_task_id ?? null;
  const briefingDate = dto.content.briefing_date ?? null;
  const isError = dto.status === "failed" || role === "error";
  const retryable = dto.status === "failed" || dto.status === "cancelled";

  if (dto.role === "tool") {
    // Tool-role rows are not rendered as bubbles; skip body.
    return {
      id: dto.id,
      role: "system",
      status: dto.status,
      text: "",
      createdAt: dto.created_at,
      sequence: dto.sequence,
      turnId: dto.turn_id,
      focusedTaskId,
      briefingDate,
      segments: [],
      proposals: [],
      isError: false,
      retryable: false,
    };
  }

  if (dto.role === "user") {
    return {
      id: dto.id,
      role: "user",
      status: dto.status,
      text,
      createdAt: dto.created_at,
      sequence: dto.sequence,
      turnId: dto.turn_id,
      focusedTaskId,
      briefingDate,
      segments: text ? [{ kind: "text", text }] : [],
      proposals: [],
      isError: false,
      retryable: false,
    };
  }

  if (dto.role === "system") {
    return {
      id: dto.id,
      role: "system",
      status: dto.status,
      text,
      createdAt: dto.created_at,
      sequence: dto.sequence,
      turnId: dto.turn_id,
      focusedTaskId,
      briefingDate,
      segments: text ? [{ kind: "text", text }] : [],
      proposals: [],
      isError: false,
      retryable: false,
    };
  }

  // Assistant (and failed assistant rendered as error bubble).
  const { segments, proposals } = mapToolEventsToSegments(text, dto.content.tool_events ?? []);

  // Surface content.tool_name / tool_result_json when no structured events.
  if (segments.length === 0 && dto.content.tool_name) {
    segments.push({
      kind: "tool_badge",
      tool: dto.content.tool_name,
      arguments: parseJson(dto.content.tool_arguments_json),
      complete: true,
    });
    if (dto.content.tool_result_json) {
      segments.push({
        kind: "tool_result",
        result: {
          tool: dto.content.tool_name,
          outcome: "success",
          data: parseJson(dto.content.tool_result_json),
          truncated: false,
          operationId: null,
          revision: null,
        },
      });
    }
  }

  if (text && !segments.some((s) => s.kind === "text")) {
    // No offsets applied — append full text at end.
    segments.push({ kind: "text", text });
  }

  return {
    id: dto.id,
    role: isError ? "error" : "assistant",
    status: dto.status,
    text,
    createdAt: dto.created_at,
    sequence: dto.sequence,
    turnId: dto.turn_id,
    focusedTaskId,
    briefingDate,
    segments,
    proposals,
    isError,
    retryable,
  };
}

export function mapAiMessageDtos(dtos: readonly AiMessageDto[]): ChatMessageView[] {
  return dtos
    .map(mapAiMessageDto)
    .filter((m) => m.role !== "system" || m.text.length > 0)
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * Build ordered segments from assistant text + durable tool events.
 * Offsets are UTF-8 byte positions into `text`.
 */
export function mapToolEventsToSegments(
  text: string,
  events: readonly AiToolEventDto[],
): { segments: ChatSegment[]; proposals: ChatToolProposal[] } {
  if (!events.length) {
    return {
      segments: text ? [{ kind: "text", text }] : [],
      proposals: [],
    };
  }

  const ordered = [...events].sort((a, b) => a.assistant_utf8_offset - b.assistant_utf8_offset);

  const segments: ChatSegment[] = [];
  const proposals: ChatToolProposal[] = [];
  const proposalById = new Map<string, ChatToolProposal>();
  let cursor = 0; // JS string index

  for (const event of ordered) {
    const at = utf8ByteOffsetToStringIndex(text, event.assistant_utf8_offset);
    if (at > cursor) {
      const slice = text.slice(cursor, at);
      if (slice) segments.push({ kind: "text", text: slice });
      cursor = at;
    }

    const eventType = event.event_type;
    if (eventType === "tool_proposed") {
      const proposal = parseProposal(event.payload);
      if (proposal) {
        proposalById.set(proposal.approvalId, proposal);
        proposals.push(proposal);
        segments.push({ kind: "tool_proposed", proposal });
        segments.push({
          kind: "tool_badge",
          tool: proposal.tool,
          arguments: proposal.arguments,
          complete: false,
        });
      }
    } else if (eventType === "tool_approved" || eventType === "tool_rejected") {
      const decisionKind = eventType === "tool_approved" ? "approved" : "rejected";
      const decision = parseDecision(event.payload, decisionKind);
      if (decision) {
        const existing = proposalById.get(decision.approvalId);
        if (existing) {
          existing.decision = decision.decision;
        }
      }
    } else if (eventType === "tool_result") {
      const result = parseResult(event.payload);
      if (result) {
        segments.push({ kind: "tool_result", result });
        // Mark prior badges for this tool complete.
        for (let i = segments.length - 1; i >= 0; i -= 1) {
          const seg = segments[i];
          if (seg?.kind === "tool_badge" && seg.tool === result.tool && !seg.complete) {
            seg.complete = true;
            break;
          }
        }
      }
    }
  }

  if (cursor < text.length) {
    const slice = text.slice(cursor);
    if (slice) segments.push({ kind: "text", text: slice });
  }

  return { segments, proposals };
}

function mapRole(
  role: AiMessageDto["role"],
  status: AiMessageDto["status"],
): ChatMessageView["role"] {
  if (status === "failed" && role === "assistant") return "error";
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  return "system";
}

function parseProposal(payload: unknown): ChatToolProposal | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as ToolProposedPayload;
  if (typeof p.approval_id !== "string" || !p.approval_id) return null;
  if (typeof p.tool !== "string" || !p.tool) return null;
  if (typeof p.action_hash !== "string" || !p.action_hash) return null;
  if (typeof p.expires_at !== "string" || !p.expires_at) return null;
  const args =
    p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments)
      ? (p.arguments as Record<string, unknown>)
      : {};
  return {
    approvalId: p.approval_id,
    tool: p.tool,
    arguments: args,
    actionHash: p.action_hash,
    expiresAt: p.expires_at,
    decision: "pending",
  };
}

function parseDecision(
  payload: unknown,
  fallback: "approved" | "rejected",
): { approvalId: string; decision: "approved" | "rejected" } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as ToolDecisionPayload;
  if (typeof p.approval_id !== "string" || !p.approval_id) return null;
  const decision = p.decision === "approved" || p.decision === "rejected" ? p.decision : fallback;
  return { approvalId: p.approval_id, decision };
}

function parseResult(payload: unknown): ChatToolResult | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as ToolResultPayload;
  if (typeof p.tool !== "string" || !p.tool) return null;
  return {
    tool: p.tool,
    outcome: typeof p.outcome === "string" ? p.outcome : "success",
    data: p.data ?? null,
    truncated: Boolean(p.truncated),
    operationId: typeof p.operation_id === "string" ? p.operation_id : null,
    revision: typeof p.revision === "number" ? p.revision : null,
  };
}

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
