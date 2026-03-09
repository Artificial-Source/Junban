// Re-export facade — all implementations live in ai/ submodules.

export type {
  AIConfigInfo,
  AIChatMessage,
  ChatSessionInfo,
  AIProviderInfo,
  ModelDiscoveryInfo,
} from "./ai/ai-types.js";
export { listAIProviders, fetchModels, loadModel, unloadModel } from "./ai/ai-providers.js";
export { getAIConfig, updateAIConfig } from "./ai/ai-config.js";
export { sendChatMessage, getChatMessages, clearChat } from "./ai/ai-chat.js";
export {
  listChatSessions,
  renameChatSession,
  deleteChatSession,
  switchChatSession,
  createNewChatSession,
} from "./ai/ai-sessions.js";
export {
  getAiMemories,
  updateAiMemory,
  deleteAiMemory,
  deleteAllAiMemories,
} from "./ai/ai-memories.js";
