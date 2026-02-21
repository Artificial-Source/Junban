import { isTauri, BASE, handleResponse, handleVoidResponse, getServices } from "./helpers.js";

export interface AIConfigInfo {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
}

export interface AIChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
  toolResults?: { toolName: string; data: string }[];
  isError?: boolean;
  errorCategory?: string;
  retryable?: boolean;
}

export interface ChatSessionInfo {
  sessionId: string;
  title: string;
  createdAt: string;
  messageCount: number;
}

export interface AIProviderInfo {
  name: string;
  displayName: string;
  needsApiKey: boolean;
  optionalApiKey?: boolean;
  defaultModel: string;
  suggestedModels?: string[];
  defaultBaseUrl?: string;
  showBaseUrl?: boolean;
  pluginId: string | null;
}

export interface ModelDiscoveryInfo {
  id: string;
  label: string;
  loaded: boolean;
}

export async function listAIProviders(): Promise<AIProviderInfo[]> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.aiProviderRegistry.getAll().map((r) => ({
      name: r.plugin.name,
      displayName: r.plugin.displayName,
      needsApiKey: r.plugin.needsApiKey,
      optionalApiKey: r.plugin.optionalApiKey ?? false,
      defaultModel: r.plugin.defaultModel,
      defaultBaseUrl: r.plugin.defaultBaseUrl,
      showBaseUrl: r.plugin.showBaseUrl ?? false,
      pluginId: r.pluginId,
    }));
  }
  const res = await fetch(`${BASE}/ai/providers`);
  return handleResponse<AIProviderInfo[]>(res);
}

export async function fetchModels(
  providerName: string,
  baseUrl?: string,
): Promise<ModelDiscoveryInfo[]> {
  if (isTauri()) {
    const svc = await getServices();
    const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
    const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
    const { fetchAvailableModels } = await import("../../ai/model-discovery.js");
    return fetchAvailableModels(providerName, {
      apiKey: apiKeySetting?.value,
      baseUrl: baseUrl || baseUrlSetting?.value,
    });
  }
  const url = new URL(
    `${BASE}/ai/providers/${encodeURIComponent(providerName)}/models`,
    window.location.origin,
  );
  if (baseUrl) url.searchParams.set("baseUrl", baseUrl);
  const res = await fetch(url.toString());
  const data = await handleResponse<{ models: ModelDiscoveryInfo[] }>(res);
  return data.models;
}

export async function loadModel(
  providerName: string,
  modelKey: string,
  baseUrl?: string,
): Promise<void> {
  if (isTauri()) {
    const svc = await getServices();
    const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
    const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
    if (providerName === "lmstudio") {
      const { loadLMStudioModel } = await import("../../ai/model-discovery.js");
      await loadLMStudioModel(
        modelKey,
        baseUrl || baseUrlSetting?.value || "http://localhost:1234/v1",
        apiKeySetting?.value,
      );
    }
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/ai/providers/${encodeURIComponent(providerName)}/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelKey, baseUrl }),
    }),
  );
}

export async function unloadModel(
  providerName: string,
  modelKey: string,
  baseUrl?: string,
): Promise<void> {
  if (isTauri()) {
    const svc = await getServices();
    const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
    const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
    if (providerName === "lmstudio") {
      const { unloadLMStudioModel } = await import("../../ai/model-discovery.js");
      await unloadLMStudioModel(
        modelKey,
        baseUrl || baseUrlSetting?.value || "http://localhost:1234/v1",
        apiKeySetting?.value,
      );
    }
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/ai/providers/${encodeURIComponent(providerName)}/models/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelKey, baseUrl }),
    }),
  );
}

export async function getAIConfig(): Promise<AIConfigInfo> {
  if (isTauri()) {
    const svc = await getServices();
    const providerSetting = svc.storage.getAppSetting("ai_provider");
    const modelSetting = svc.storage.getAppSetting("ai_model");
    const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
    const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
    return {
      provider: providerSetting?.value ?? null,
      model: modelSetting?.value ?? null,
      baseUrl: baseUrlSetting?.value ?? null,
      hasApiKey: !!apiKeySetting?.value,
    };
  }
  const res = await fetch(`${BASE}/ai/config`);
  return handleResponse<AIConfigInfo>(res);
}

export async function updateAIConfig(config: {
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}): Promise<void> {
  if (isTauri()) {
    const svc = await getServices();
    if (config.provider) svc.storage.setAppSetting("ai_provider", config.provider);
    if (config.apiKey) svc.storage.setAppSetting("ai_api_key", config.apiKey);
    if (config.model !== undefined) {
      if (config.model) {
        svc.storage.setAppSetting("ai_model", config.model);
      } else {
        svc.storage.deleteAppSetting("ai_model");
      }
    }
    if (config.baseUrl !== undefined) {
      if (config.baseUrl) {
        svc.storage.setAppSetting("ai_base_url", config.baseUrl);
      } else {
        svc.storage.deleteAppSetting("ai_base_url");
      }
    }
    svc.chatManager.clearSession(svc.storage);
    svc.save();
    return;
  }
  await handleVoidResponse(
    await fetch(`${BASE}/ai/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }),
  );
}

export async function sendChatMessage(
  message: string,
  options?: { voiceCall?: boolean },
): Promise<ReadableStream<Uint8Array> | null> {
  if (isTauri()) {
    const svc = await getServices();
    const providerSetting = svc.storage.getAppSetting("ai_provider");
    if (!providerSetting?.value) {
      // Return a stream with an error event, matching SSE format
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "error", data: "No AI provider configured. Go to Settings to set one up." })}\n\n`,
            ),
          );
          controller.close();
        },
      });
    }

    try {
      const { gatherContext } = await import("../../ai/chat.js");
      const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
      const modelSetting = svc.storage.getAppSetting("ai_model");
      const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

      const executor = svc.aiProviderRegistry.createExecutor({
        provider: providerSetting.value as string,
        apiKey: apiKeySetting?.value,
        model: modelSetting?.value,
        baseUrl: baseUrlSetting?.value,
      });

      const toolServices = {
        taskService: svc.taskService,
        projectService: svc.projectService,
        tagService: svc.tagService,
      };

      const isLocalProvider =
        providerSetting.value === "ollama" || providerSetting.value === "lmstudio";
      const contextBlock = await gatherContext(toolServices, {
        compact: isLocalProvider,
        voiceCall: options?.voiceCall,
      });
      const session = svc.chatManager.getOrCreateSession(executor, toolServices, {
        queries: svc.storage,
        contextBlock,
        toolRegistry: svc.toolRegistry,
        model: modelSetting?.value ?? undefined,
        providerName: providerSetting.value as string,
      });

      session.addUserMessage(message);

      const encoder = new TextEncoder();
      return new ReadableStream({
        async start(controller) {
          try {
            for await (const event of session.run()) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : "Unknown error";
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "error", data: errorMsg })}\n\n`),
            );
          }
          svc.save();
          controller.close();
        },
      });
    } catch (err: unknown) {
      const encoder = new TextEncoder();
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      return new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "error", data: errorMsg })}\n\n`),
          );
          controller.close();
        },
      });
    }
  }

  const res = await fetch(`${BASE}/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, voiceCall: options?.voiceCall }),
  });
  return res.body;
}

export async function getChatMessages(): Promise<AIChatMessage[]> {
  if (isTauri()) {
    const svc = await getServices();
    let session = svc.chatManager.getSession();

    if (!session) {
      try {
        const providerSetting = svc.storage.getAppSetting("ai_provider");
        if (providerSetting?.value) {
          const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
          const modelSetting = svc.storage.getAppSetting("ai_model");
          const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

          const executor = svc.aiProviderRegistry.createExecutor({
            provider: providerSetting.value as string,
            apiKey: apiKeySetting?.value,
            model: modelSetting?.value,
            baseUrl: baseUrlSetting?.value,
          });

          session = svc.chatManager.restoreSession(
            executor,
            {
              taskService: svc.taskService,
              projectService: svc.projectService,
              tagService: svc.tagService,
            },
            svc.storage,
            {
              toolRegistry: svc.toolRegistry,
              model: modelSetting?.value ?? undefined,
              providerName: providerSetting.value as string,
            },
          );
        }
      } catch {
        // Non-critical
      }
    }

    return session ? (session.getMessages() as AIChatMessage[]) : [];
  }

  const res = await fetch(`${BASE}/ai/messages`);
  return handleResponse<AIChatMessage[]>(res);
}

export async function clearChat(): Promise<void> {
  if (isTauri()) {
    const svc = await getServices();
    svc.chatManager.clearSession(svc.storage);
    svc.save();
    return;
  }
  await handleVoidResponse(await fetch(`${BASE}/ai/clear`, { method: "POST" }));
}

export async function listChatSessions(): Promise<ChatSessionInfo[]> {
  if (isTauri()) {
    const svc = await getServices();
    return svc.storage.listChatSessions();
  }
  const res = await fetch(`${BASE}/ai/sessions`);
  return handleResponse<ChatSessionInfo[]>(res);
}

export async function renameChatSession(sessionId: string, title: string): Promise<void> {
  if (isTauri()) {
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
  if (isTauri()) {
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
  if (isTauri()) {
    const svc = await getServices();
    const providerSetting = svc.storage.getAppSetting("ai_provider");
    if (!providerSetting?.value) return [];

    const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
    const modelSetting = svc.storage.getAppSetting("ai_model");
    const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

    const executor = svc.aiProviderRegistry.createExecutor({
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
    };

    // Build system message and create a session from stored messages
    const systemMessage = svc.chatManager.buildSystemMessage(toolServices, "", providerSetting.value as string);
    const { ChatSession } = await import("../../ai/chat.js");
    const session = new ChatSession(executor, toolServices, systemMessage, {
      sessionId,
      queries: svc.storage,
      toolRegistry: svc.toolRegistry,
      model: modelSetting?.value ?? undefined,
      providerName: providerSetting.value as string,
    });

    for (const row of rows) {
      if (row.role === "system") continue;
      const msg = {
        role: row.role as "user" | "assistant" | "tool",
        content: row.content,
        ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
        ...(row.toolCalls ? { toolCalls: JSON.parse(row.toolCalls) } : {}),
      };
      (session as any).messages.push(msg);
    }

    (svc.chatManager as any).session = session;
    return session.getMessages() as AIChatMessage[];
  }

  const res = await fetch(`${BASE}/ai/sessions/${encodeURIComponent(sessionId)}/switch`, {
    method: "POST",
  });
  return handleResponse<AIChatMessage[]>(res);
}

export async function createNewChatSession(): Promise<string> {
  if (isTauri()) {
    const svc = await getServices();
    // Clear current session without deleting from DB
    (svc.chatManager as any).session = null;
    return "";
  }
  const res = await fetch(`${BASE}/ai/sessions/new`, { method: "POST" });
  const data = await handleResponse<{ sessionId: string }>(res);
  return data.sessionId;
}
