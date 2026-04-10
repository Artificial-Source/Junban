import { useDirectServices, BASE, handleResponse, handleVoidResponse } from "../helpers.js";
import { getServices } from "../direct-services.js";
import type { AIChatMessage } from "./ai-types.js";
import { getSecureSetting } from "../../../storage/encrypted-settings.js";

function normalizeAuthType(value: string | undefined): "api-key" | "oauth" | undefined {
  return value === "api-key" || value === "oauth" ? value : undefined;
}

export async function sendChatMessage(
  message: string,
  options?: { voiceCall?: boolean; focusedTaskId?: string },
): Promise<ReadableStream<Uint8Array> | null> {
  if (useDirectServices()) {
    const svc = await getServices();
    const ai = await svc.getAIRuntime();
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
      const { gatherContext } = await import("../../../ai/chat.js");
      const apiKey = await getSecureSetting(svc.storage, "ai_api_key");
      const modelSetting = svc.storage.getAppSetting("ai_model");
      const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
      const authTypeSetting = svc.storage.getAppSetting("ai_auth_type");
      const oauthToken = await getSecureSetting(svc.storage, "ai_oauth_token");

      const executor = ai.aiProviderRegistry.createExecutor({
        provider: providerSetting.value as string,
        apiKey: apiKey ?? undefined,
        model: modelSetting?.value,
        baseUrl: baseUrlSetting?.value,
        authType: normalizeAuthType(authTypeSetting?.value),
        oauthToken: oauthToken ?? undefined,
      });

      const toolServices = {
        taskService: svc.taskService,
        projectService: svc.projectService,
        tagService: svc.tagService,
        statsService: svc.statsService,
        storage: svc.storage,
      };

      const isLocalProvider =
        providerSetting.value === "ollama" || providerSetting.value === "lmstudio";
      const contextBlock = await gatherContext(toolServices, {
        compact: isLocalProvider,
        voiceCall: options?.voiceCall,
        focusedTaskId: options?.focusedTaskId,
      });
      const session = ai.chatManager.getOrCreateSession(executor, toolServices, {
        queries: svc.storage,
        contextBlock,
        toolRegistry: ai.toolRegistry,
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
    body: JSON.stringify({
      message,
      voiceCall: options?.voiceCall,
      focusedTaskId: options?.focusedTaskId,
    }),
  });
  return res.body;
}

export async function getChatMessages(): Promise<AIChatMessage[]> {
  if (useDirectServices()) {
    const svc = await getServices();
    const ai = await svc.getAIRuntime();
    let session = ai.chatManager.getSession();

    if (!session) {
      try {
        const providerSetting = svc.storage.getAppSetting("ai_provider");
        if (providerSetting?.value) {
          const apiKey = await getSecureSetting(svc.storage, "ai_api_key");
          const modelSetting = svc.storage.getAppSetting("ai_model");
          const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
          const authTypeSetting = svc.storage.getAppSetting("ai_auth_type");
          const oauthToken = await getSecureSetting(svc.storage, "ai_oauth_token");

          const executor = ai.aiProviderRegistry.createExecutor({
            provider: providerSetting.value as string,
            apiKey: apiKey ?? undefined,
            model: modelSetting?.value,
            baseUrl: baseUrlSetting?.value,
            authType: normalizeAuthType(authTypeSetting?.value),
            oauthToken: oauthToken ?? undefined,
          });

          session = ai.chatManager.restoreSession(
            executor,
            {
              taskService: svc.taskService,
              projectService: svc.projectService,
              tagService: svc.tagService,
              statsService: svc.statsService,
              storage: svc.storage,
            },
            svc.storage,
            {
              toolRegistry: ai.toolRegistry,
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
  if (useDirectServices()) {
    const svc = await getServices();
    const ai = await svc.getAIRuntime();
    ai.chatManager.clearSession(svc.storage);
    svc.save();
    return;
  }
  await handleVoidResponse(await fetch(`${BASE}/ai/clear`, { method: "POST" }));
}
