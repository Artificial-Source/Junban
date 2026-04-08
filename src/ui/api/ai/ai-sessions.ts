import {
  useDirectServices,
  BASE,
  handleResponse,
  handleVoidResponse,
  getServices,
} from "../helpers.js";
import type { AIChatMessage, ChatSessionInfo } from "./ai-types.js";
import { deserializeChatMessages } from "../../../ai/message-utils.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("ai-sessions");

export async function listChatSessions(): Promise<ChatSessionInfo[]> {
  if (useDirectServices()) {
    const svc = await getServices();
    return svc.storage.listChatSessions();
  }
  const res = await fetch(`${BASE}/ai/sessions`);
  return handleResponse<ChatSessionInfo[]>(res);
}

export async function renameChatSession(sessionId: string, title: string): Promise<void> {
  if (useDirectServices()) {
    const svc = await getServices();
    svc.storage.renameChatSession(sessionId, title);
    svc.save();
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/ai/sessions/${encodeURIComponent(sessionId)}/title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  if (useDirectServices()) {
    const svc = await getServices();
    svc.storage.deleteChatSession(sessionId);
    // Also remove the title override
    svc.storage.deleteAppSetting(`chat_session_title:${sessionId}`);
    svc.save();
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/ai/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }),
  );
}

export async function switchChatSession(sessionId: string): Promise<AIChatMessage[]> {
  if (useDirectServices()) {
    const svc = await getServices();
    const ai = await svc.getAIRuntime();
    // Fire-and-forget memory extraction from current session
    const currentSession = ai.chatManager.getSession();
    if (currentSession) {
      currentSession.extractMemories().catch((err: unknown) =>
        log.warn("Memory extraction failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    const providerSetting = svc.storage.getAppSetting("ai_provider");
    if (!providerSetting?.value) return [];

    const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
    const modelSetting = svc.storage.getAppSetting("ai_model");
    const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

    const executor = ai.aiProviderRegistry.createExecutor({
      provider: providerSetting.value as string,
      apiKey: apiKeySetting?.value,
      model: modelSetting?.value,
      baseUrl: baseUrlSetting?.value,
    });

    const rows = svc.storage.listChatMessages(sessionId);
    if (rows.length === 0) return [];

    const toolServices = {
      taskService: svc.taskService,
      projectService: svc.projectService,
      tagService: svc.tagService,
      statsService: svc.statsService,
      storage: svc.storage,
    };

    // Build system message and create a session from stored messages
    const systemMessage = ai.chatManager.buildSystemMessage(
      toolServices,
      "",
      providerSetting.value as string,
    );
    const { ChatSession } = await import("../../../ai/chat.js");
    const session = new ChatSession(executor, toolServices, systemMessage, {
      sessionId,
      queries: svc.storage,
      toolRegistry: ai.toolRegistry,
      model: modelSetting?.value ?? undefined,
      providerName: providerSetting.value as string,
    });

    session.restoreMessages(deserializeChatMessages(rows));

    ai.chatManager.setSession(session);
    return session.getMessages() as AIChatMessage[];
  }

  const res = await fetch(`${BASE}/ai/sessions/${encodeURIComponent(sessionId)}/switch`, {
    method: "POST",
  });
  return handleResponse<AIChatMessage[]>(res);
}

export async function createNewChatSession(): Promise<string> {
  if (useDirectServices()) {
    const svc = await getServices();
    const ai = await svc.getAIRuntime();
    // Fire-and-forget memory extraction from current session
    const currentSession = ai.chatManager.getSession();
    if (currentSession) {
      currentSession.extractMemories().catch((err: unknown) =>
        log.warn("Memory extraction failed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    // Clear current session without deleting from DB
    ai.chatManager.setSession(null);
    return "";
  }
  const res = await fetch(`${BASE}/ai/sessions/new`, { method: "POST" });
  const data = await handleResponse<{ sessionId: string }>(res);
  return data.sessionId;
}
