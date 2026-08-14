/**
 * Conversation lifecycle owners (Wave 4d).
 *
 * Public React entry remains `../useAiConversation`.
 */

export { ActionKeys, ConversationOperations, digestUtf8, isDefinitiveTerminal } from "./operations";
export { mapSession, toError, proposalFromStream } from "./helpers";
export {
  AI_USER_INPUT_BYTES_MAX,
  type ConversationError,
  type UseAiConversationOptions,
  type UseAiConversationResult,
  type StreamActionKind,
  type ActiveRun,
} from "./types";
