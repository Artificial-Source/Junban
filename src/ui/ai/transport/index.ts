/**
 * Typed Wave 3 AI HTTP transport (endpoint-family modules).
 *
 * Streaming uses authenticated fetch (never EventSource), retains caller
 * operation ids across same-action retries, and never auto-replays POSTs after
 * ambiguous dispatch.
 */

export {
  type AiTransportOptions,
  type AiStreamTransportOptions,
  type AiStreamResult,
  sanitizeTransportError,
} from "./core";

export {
  listAiProviders,
  discoverAiProviderModels,
  getAiConfig,
  putAiConfig,
  deleteAiConfig,
  putAiCredential,
  deleteAiCredential,
} from "./config";

export {
  listAiSessions,
  createAiSession,
  getAiSession,
  updateAiSession,
  deleteAiSession,
  clearAiSession,
  listAiMessages,
  getAiMessage,
} from "./sessions";

export {
  createAiResponse,
  createAiDailyBriefing,
  editAiResponse,
  retryAiResponse,
  regenerateAiResponse,
  cancelAiRun,
} from "./responses";

export {
  listAiMemories,
  createAiMemory,
  getAiMemory,
  updateAiMemory,
  deleteAiMemory,
} from "./memories";

export { getAiApproval, approveAiApproval, rejectAiApproval } from "./approvals";
