/**
 * Phase 6 Wave 4b AI transport types.
 *
 * Raw OpenAPI DTOs are re-exported for transport callers. View-model shapes used
 * by the SSE reducer stay separate so UI code does not depend on wire quirks.
 */

import type { components, operations } from "../api/generated";

type Schemas = components["schemas"];

// ---------------------------------------------------------------------------
// Generated DTO aliases (wire contract)
// ---------------------------------------------------------------------------

export type AiConfigInput = Schemas["AiConfigInput"];
export type AiConfigPutRequest = Schemas["AiConfigPutRequest"];
export type AiConfigResponse = Schemas["AiConfigResponse"];
export type AiSettingsDto = Schemas["AiSettingsDto"];
export type VoiceConfigInput = Schemas["VoiceConfigInput"];
export type VoiceSettingsDto = Schemas["VoiceSettingsDto"];
export type SpeechProviderPresetDto = Schemas["SpeechProviderPresetDto"];
export type VoiceModeDto = Schemas["VoiceModeDto"];

export type AiCredentialTargetDto = Schemas["AiCredentialTargetDto"];
export type AiCredentialBindingsDto = Schemas["AiCredentialBindingsDto"];
export type AiCredentialBindingResponse = Schemas["AiCredentialBindingResponse"];
export type AiCredentialMetadataDto = Schemas["AiCredentialMetadataDto"];
export type PutAiCredentialRequest = Schemas["PutAiCredentialRequest"];
export type AiSecretKindDto = Schemas["AiSecretKindDto"];

export type AiProviderPresetDto = Schemas["AiProviderPresetDto"];
export type AiProviderRegistryEntry = Schemas["AiProviderRegistryEntry"];
export type AiProviderRegistryResponse = Schemas["AiProviderRegistryResponse"];
export type ModelDiscoveryResponse = Schemas["ModelDiscoveryResponse"];
export type DiscoveredModelDto = Schemas["DiscoveredModelDto"];
export type ProviderCapabilityDto = Schemas["ProviderCapabilityDto"];

export type AiSessionDto = Schemas["AiSessionDto"];
export type AiSessionListResponse = Schemas["AiSessionListResponse"];
export type AiSessionMutationResponse = Schemas["AiSessionMutationResponse"];
export type AiSessionStatusDto = Schemas["AiSessionStatusDto"];
export type CreateAiSessionHttpRequest = Schemas["CreateAiSessionHttpRequest"];
export type PatchAiSessionRequest = Schemas["PatchAiSessionRequest"];

export type AiMessageDto = Schemas["AiMessageDto"];
export type AiMessageListResponse = Schemas["AiMessageListResponse"];
export type AiMessageContentDto = Schemas["AiMessageContentDto"];
export type AiMessageRoleDto = Schemas["AiMessageRoleDto"];
export type AiMessageStatusDto = Schemas["AiMessageStatusDto"];
export type AiToolEventDto = Schemas["AiToolEventDto"];

export type CreateAiResponseRequest = Schemas["CreateAiResponseRequest"];
export type EditAiResponseRequest = Schemas["EditAiResponseRequest"];
export type EmptyAiResponseActionRequest = Schemas["EmptyAiResponseActionRequest"];
export type CancelAiRunResponse = Schemas["CancelAiRunResponse"];

export type AiMemoryDto = Schemas["AiMemoryDto"];
export type AiMemoryListResponse = Schemas["AiMemoryListResponse"];
export type AiMemoryMutationResponse = Schemas["AiMemoryMutationResponse"];
export type CreateAiMemoryHttpRequest = Schemas["CreateAiMemoryHttpRequest"];
export type PatchAiMemoryRequest = Schemas["PatchAiMemoryRequest"];

export type AiApprovalDto = Schemas["AiApprovalDto"];
export type AiApprovalResponse = Schemas["AiApprovalResponse"];
export type AiApprovalDecisionRequest = Schemas["AiApprovalDecisionRequest"];
export type AiApprovalMessageDto = Schemas["AiApprovalMessageDto"];
export type AiApprovalRunDto = Schemas["AiApprovalRunDto"];

export type AiRunSseEnvelope = Schemas["AiRunSseEnvelope"];
export type AiRunEventType = Schemas["AiRunEventType"];
export type AiContextMetadata = Schemas["AiContextMetadata"];

export type MutationResponse = Schemas["MutationResponse"];

export type ListAiSessionsParams = NonNullable<
  operations["list_ai_sessions"]["parameters"]["query"]
>;
export type ListAiMemoriesParams = NonNullable<
  operations["list_ai_memories"]["parameters"]["query"]
>;
export type ListAiMessagesParams = NonNullable<
  operations["list_ai_messages"]["parameters"]["query"]
>;

// ---------------------------------------------------------------------------
// Wire constants (server / domain bounds)
// ---------------------------------------------------------------------------

/** Local SSE envelope version accepted by the Wave 3e contract. */
export const AI_SSE_ENVELOPE_VERSION = 1;

/** Match junban-ai provider stream frame ceiling for local envelope frames. */
export const AI_SSE_MAX_FRAME_BYTES = 64 * 1024;

/** Undecoded carry + partial frame bound. */
export const AI_SSE_MAX_BUFFER_BYTES = 128 * 1024;

/** Domain `AI_ASSISTANT_TEXT_BYTES_MAX`. */
export const AI_ASSISTANT_TEXT_BYTES_MAX = 512 * 1024;

/** Domain `AI_TOOL_ARGUMENTS_BYTES_MAX`. */
export const AI_TOOL_ARGUMENTS_BYTES_MAX = 128 * 1024;

/** Domain `AI_TOOL_RESULT_BYTES_MAX`. */
export const AI_TOOL_RESULT_BYTES_MAX = 256 * 1024;

/** Domain `AI_TOOL_EVENT_TRANSCRIPT_BYTES_MAX`. */
export const AI_TOOL_EVENT_TRANSCRIPT_BYTES_MAX = 2 * 1024 * 1024;

/** Stable diagnostic / status / error string ceiling. */
export const AI_DIAGNOSTIC_STRING_BYTES_MAX = 1024;

/** Known local run event types (Wave 3e). */
export const AI_RUN_EVENT_TYPES = [
  "run_started",
  "text_delta",
  "reasoning_status",
  "usage",
  "tool_proposed",
  "tool_approved",
  "tool_rejected",
  "tool_result",
  "run_completed",
  "run_cancelled",
  "run_failed",
] as const;

export type AiRunEventTypeName = (typeof AI_RUN_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Reducer view-model (not raw DTOs)
// ---------------------------------------------------------------------------

export type AiRunUsageView = {
  inputTokens: number;
  outputTokens: number;
};

export type AiToolProposalView = {
  approvalId: string;
  tool: string;
  /** Canonical JSON object arguments from the local envelope. */
  arguments: Record<string, unknown>;
  actionHash: string;
  expiresAt: string;
};

export type AiToolDecisionView = {
  approvalId: string;
  decision: "approved" | "rejected";
};

export type AiToolResultView = {
  tool: string;
  outcome: "success" | "error" | "unavailable" | string;
  data: unknown;
  truncated: boolean;
  operationId: string | null;
  revision: number | null;
};

export type AiRunTerminalView =
  | {
      kind: "completed";
      assistantMessageId: string;
    }
  | {
      kind: "cancelled";
      assistantMessageId: string;
    }
  | {
      kind: "failed";
      assistantMessageId: string | null;
      error: string;
    }
  | {
      kind: "interrupted";
      reason: "eof_without_terminal" | "aborted" | "protocol";
      message: string;
    };

export type AiRunStreamState = {
  runId: string | null;
  generation: number | null;
  lastSequence: number | null;
  lastEventId: string | null;
  /** Visible assistant UTF-8 text only (no hidden reasoning). */
  visibleText: string;
  /** Provider-neutral reasoning status label only. */
  reasoningStatus: string | null;
  usage: AiRunUsageView | null;
  context: AiContextMetadata | null;
  replay: boolean;
  proposals: AiToolProposalView[];
  decisions: AiToolDecisionView[];
  results: AiToolResultView[];
  /** Exactly one terminal once set; never replaced. */
  terminal: AiRunTerminalView | null;
  /** Increments when `visibleText` changes; for pull/raf batching. */
  textRevision: number;
};

export type AiSseErrorCode =
  | "version"
  | "identity"
  | "sequence"
  | "event_type"
  | "payload"
  | "vendor_field"
  | "malformed_json"
  | "frame_bound"
  | "buffer_bound"
  | "text_bound"
  | "tool_bound"
  | "diagnostic_bound"
  | "utf8"
  | "duplicate_terminal"
  | "protocol";

/** Stable typed stream protocol error (never carries tokens/secrets). */
export class AiSseError extends Error {
  readonly code: AiSseErrorCode;

  constructor(code: AiSseErrorCode, message: string) {
    super(message);
    this.name = "AiSseError";
    this.code = code;
  }
}

export function createInitialAiRunStreamState(): AiRunStreamState {
  return {
    runId: null,
    generation: null,
    lastSequence: null,
    lastEventId: null,
    visibleText: "",
    reasoningStatus: null,
    usage: null,
    context: null,
    replay: false,
    proposals: [],
    decisions: [],
    results: [],
    terminal: null,
    textRevision: 0,
  };
}
