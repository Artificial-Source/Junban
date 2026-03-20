import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppServices } from "../bootstrap.js";
import type { ProviderRegistration } from "../ai/provider/registry.js";
import type { ChatMessage } from "../ai/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("api:ai");

export function aiRoutes(services: AppServices): Hono {
  const app = new Hono();

  // GET /ai/providers
  app.get("/providers", async (c) => {
    const providers = services.aiProviderRegistry.getAll().map((r: ProviderRegistration) => ({
      name: r.plugin.name,
      displayName: r.plugin.displayName,
      needsApiKey: r.plugin.needsApiKey,
      optionalApiKey: r.plugin.optionalApiKey ?? false,
      supportsOAuth: r.plugin.supportsOAuth ?? false,
      defaultModel: r.plugin.defaultModel,
      defaultBaseUrl: r.plugin.defaultBaseUrl,
      showBaseUrl: r.plugin.showBaseUrl ?? false,
      pluginId: r.pluginId,
    }));
    return c.json(providers);
  });

  // GET /ai/config
  app.get("/config", async (c) => {
    const providerSetting = services.storage.getAppSetting("ai_provider");
    const modelSetting = services.storage.getAppSetting("ai_model");
    const baseUrlSetting = services.storage.getAppSetting("ai_base_url");
    const apiKeySetting = services.storage.getAppSetting("ai_api_key");
    const authTypeSetting = services.storage.getAppSetting("ai_auth_type");
    const oauthTokenSetting = services.storage.getAppSetting("ai_oauth_token");
    return c.json({
      provider: providerSetting?.value ?? null,
      model: modelSetting?.value ?? null,
      baseUrl: baseUrlSetting?.value ?? null,
      hasApiKey: !!apiKeySetting?.value,
      authType: authTypeSetting?.value ?? undefined,
      hasOAuthToken: !!oauthTokenSetting?.value,
    });
  });

  // PUT /ai/config
  app.put("/config", async (c) => {
    const body = await c.req.json();
    const { provider, apiKey, model, baseUrl, authType, oauthToken } = body as {
      provider?: string;
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      authType?: string;
      oauthToken?: string;
    };
    if (provider) services.storage.setAppSetting("ai_provider", provider);
    if (apiKey) services.storage.setAppSetting("ai_api_key", apiKey);
    if (model !== undefined) {
      if (model) {
        services.storage.setAppSetting("ai_model", model);
      } else {
        services.storage.deleteAppSetting("ai_model");
      }
    }
    if (baseUrl !== undefined) {
      if (baseUrl) {
        services.storage.setAppSetting("ai_base_url", baseUrl);
      } else {
        services.storage.deleteAppSetting("ai_base_url");
      }
    }
    if (authType !== undefined) {
      if (authType) {
        services.storage.setAppSetting("ai_auth_type", authType);
      } else {
        services.storage.deleteAppSetting("ai_auth_type");
      }
    }
    if (oauthToken) services.storage.setAppSetting("ai_oauth_token", oauthToken);
    services.chatManager.clearSession(services.storage);
    return c.json({ ok: true });
  });

  // GET /ai/providers/:name/models
  app.get("/providers/:name/models", async (c) => {
    try {
      const providerName = c.req.param("name");
      const baseUrlOverride = c.req.query("baseUrl");

      // Validate baseUrl override — only allow HTTP(S) on localhost or known provider domains
      if (baseUrlOverride) {
        try {
          const parsed = new URL(baseUrlOverride);
          if (!["http:", "https:"].includes(parsed.protocol)) {
            return c.json({ models: [] });
          }
          const host = parsed.hostname.toLowerCase();
          const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
          const isKnownProvider =
            host.endsWith(".openai.com") ||
            host.endsWith(".anthropic.com") ||
            host.endsWith(".openrouter.ai") ||
            host.endsWith(".groq.com");
          if (!isLocalhost && !isKnownProvider) {
            return c.json({ models: [] });
          }
        } catch {
          return c.json({ models: [] });
        }
      }

      const apiKeySetting = services.storage.getAppSetting("ai_api_key");
      const baseUrlSetting = services.storage.getAppSetting("ai_base_url");

      const { fetchAvailableModels } = await import("../ai/model-discovery.js");
      const models = await fetchAvailableModels(providerName, {
        apiKey: apiKeySetting?.value,
        baseUrl: baseUrlOverride || baseUrlSetting?.value,
      });
      return c.json({ models });
    } catch {
      return c.json({ models: [] });
    }
  });

  // POST /ai/providers/:name/models/load
  app.post("/providers/:name/models/load", async (c) => {
    const providerName = c.req.param("name");
    const body = await c.req.json();
    const { model: modelKey, baseUrl: baseUrlOverride } = body as {
      model: string;
      baseUrl?: string;
    };
    const baseUrlSetting = services.storage.getAppSetting("ai_base_url");
    const apiKeySetting = services.storage.getAppSetting("ai_api_key");

    if (providerName === "lmstudio") {
      const { loadLMStudioModel } = await import("../ai/model-discovery.js");
      await loadLMStudioModel(
        modelKey,
        (baseUrlOverride as string) || baseUrlSetting?.value || "http://localhost:1234/v1",
        apiKeySetting?.value,
      );
    }
    return c.json({ ok: true });
  });

  // POST /ai/providers/:name/models/unload
  app.post("/providers/:name/models/unload", async (c) => {
    const providerName = decodeURIComponent(c.req.param("name"));
    const body = await c.req.json();
    const { model: modelKey, baseUrl: baseUrlOverride } = body as {
      model: string;
      baseUrl?: string;
    };
    const baseUrlSetting = services.storage.getAppSetting("ai_base_url");
    const apiKeySetting = services.storage.getAppSetting("ai_api_key");

    if (providerName === "lmstudio") {
      const { unloadLMStudioModel } = await import("../ai/model-discovery.js");
      await unloadLMStudioModel(
        modelKey,
        (baseUrlOverride as string) || baseUrlSetting?.value || "http://localhost:1234/v1",
        apiKeySetting?.value,
      );
    }
    return c.json({ ok: true });
  });

  // POST /ai/chat — SSE streaming chat
  app.post("/chat", async (c) => {
    const body = await c.req.json();
    const message = body.message as string;
    const voiceCall = body.voiceCall as boolean | undefined;
    const focusedTaskId = body.focusedTaskId as string | undefined;

    if (!message) {
      return c.json({ error: "message is required" }, 400);
    }

    const providerSetting = services.storage.getAppSetting("ai_provider");
    if (!providerSetting?.value) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          data: JSON.stringify({
            type: "error",
            data: "No AI provider configured. Go to Settings to set one up.",
          }),
        });
      });
    }

    try {
      const { gatherContext } = await import("../ai/chat.js");
      const apiKeySetting = services.storage.getAppSetting("ai_api_key");
      const modelSetting = services.storage.getAppSetting("ai_model");
      const baseUrlSetting = services.storage.getAppSetting("ai_base_url");
      const authTypeSetting = services.storage.getAppSetting("ai_auth_type");
      const oauthTokenSetting = services.storage.getAppSetting("ai_oauth_token");

      const executor = services.aiProviderRegistry.createExecutor({
        provider: providerSetting.value as string,
        apiKey: apiKeySetting?.value,
        model: modelSetting?.value,
        baseUrl: baseUrlSetting?.value,
        authType: authTypeSetting?.value as "api-key" | "oauth" | undefined,
        oauthToken: oauthTokenSetting?.value,
      });

      const toolServices = {
        taskService: services.taskService,
        projectService: services.projectService,
        tagService: services.tagService,
        statsService: services.statsService,
        storage: services.storage,
      };

      const isLocalProvider =
        providerSetting.value === "ollama" || providerSetting.value === "lmstudio";
      const contextBlock = await gatherContext(toolServices, {
        compact: isLocalProvider,
        voiceCall,
        focusedTaskId,
      });

      const session = services.chatManager.getOrCreateSession(executor, toolServices, {
        queries: services.storage,
        contextBlock,
        toolRegistry: services.toolRegistry,
        model: modelSetting?.value ?? undefined,
        providerName: providerSetting.value as string,
      });

      session.addUserMessage(message);

      return streamSSE(c, async (stream) => {
        try {
          for await (const event of session.run()) {
            await stream.writeSSE({ data: JSON.stringify(event) });
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : "Unknown error";
          await stream.writeSSE({
            data: JSON.stringify({ type: "error", data: errorMsg }),
          });
        }
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          data: JSON.stringify({ type: "error", data: errorMsg }),
        });
      });
    }
  });

  // GET /ai/messages
  app.get("/messages", async (c) => {
    let session = services.chatManager.getSession();

    if (!session) {
      try {
        const providerSetting = services.storage.getAppSetting("ai_provider");
        if (providerSetting?.value) {
          const apiKeySetting = services.storage.getAppSetting("ai_api_key");
          const modelSetting = services.storage.getAppSetting("ai_model");
          const baseUrlSetting = services.storage.getAppSetting("ai_base_url");

          const executor = services.aiProviderRegistry.createExecutor({
            provider: providerSetting.value as string,
            apiKey: apiKeySetting?.value,
            model: modelSetting?.value,
            baseUrl: baseUrlSetting?.value,
          });

          session = services.chatManager.restoreSession(
            executor,
            {
              taskService: services.taskService,
              projectService: services.projectService,
              tagService: services.tagService,
              statsService: services.statsService,
              storage: services.storage,
            },
            services.storage,
            {
              toolRegistry: services.toolRegistry,
              model: modelSetting?.value ?? undefined,
              providerName: providerSetting.value as string,
            },
          );
        }
      } catch {
        // Non-critical
      }
    }

    const messages = session ? session.getMessages() : [];
    return c.json(messages);
  });

  // POST /ai/clear
  app.post("/clear", async (c) => {
    services.chatManager.clearSession(services.storage);
    return c.json({ ok: true });
  });

  // GET /ai/sessions
  app.get("/sessions", async (c) => {
    const sessions = services.storage.listChatSessions();
    return c.json(sessions);
  });

  // POST /ai/sessions/new
  app.post("/sessions/new", async (c) => {
    const currentSession = services.chatManager.getSession();
    if (currentSession) {
      currentSession
        .extractMemories()
        .catch((err: unknown) =>
          logger.warn(`Memory extraction failed: ${err instanceof Error ? err.message : err}`),
        );
    }
    services.chatManager.setSession(null);
    return c.json({ sessionId: "" });
  });

  // PUT /ai/sessions/:id/title
  app.put("/sessions/:id/title", async (c) => {
    const sessionId = decodeURIComponent(c.req.param("id"));
    const body = await c.req.json();
    const title = (body as { title: string }).title;
    services.storage.renameChatSession(sessionId, title);
    return c.json({ ok: true });
  });

  // POST /ai/sessions/:id/switch
  app.post("/sessions/:id/switch", async (c) => {
    const currentSession = services.chatManager.getSession();
    if (currentSession) {
      currentSession
        .extractMemories()
        .catch((err: unknown) =>
          logger.warn(`Memory extraction failed: ${err instanceof Error ? err.message : err}`),
        );
    }
    const sessionId = decodeURIComponent(c.req.param("id"));
    const providerSetting = services.storage.getAppSetting("ai_provider");
    if (!providerSetting?.value) {
      return c.json([]);
    }

    const apiKeySetting = services.storage.getAppSetting("ai_api_key");
    const modelSetting = services.storage.getAppSetting("ai_model");
    const baseUrlSetting = services.storage.getAppSetting("ai_base_url");
    const authTypeSetting = services.storage.getAppSetting("ai_auth_type");
    const oauthTokenSetting = services.storage.getAppSetting("ai_oauth_token");

    const executor = services.aiProviderRegistry.createExecutor({
      provider: providerSetting.value as string,
      apiKey: apiKeySetting?.value,
      model: modelSetting?.value,
      baseUrl: baseUrlSetting?.value,
      authType: authTypeSetting?.value as "api-key" | "oauth" | undefined,
      oauthToken: oauthTokenSetting?.value,
    });

    const rows = services.storage.listChatMessages(sessionId);
    if (rows.length === 0) {
      return c.json([]);
    }

    const toolServices = {
      taskService: services.taskService,
      projectService: services.projectService,
      tagService: services.tagService,
      statsService: services.statsService,
      storage: services.storage,
    };

    const systemMessage = services.chatManager.buildSystemMessage(
      toolServices,
      "",
      providerSetting.value as string,
    );
    const { ChatSession } = await import("../ai/chat.js");
    const session = new ChatSession(executor, toolServices, systemMessage, {
      sessionId,
      queries: services.storage,
      toolRegistry: services.toolRegistry,
      model: modelSetting?.value ?? undefined,
      providerName: providerSetting.value as string,
    });

    const restoredMessages: ChatMessage[] = [];
    for (const row of rows) {
      if (row.role === "system") continue;
      restoredMessages.push({
        role: row.role as "user" | "assistant" | "tool",
        content: row.content,
        ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
        ...(row.toolCalls ? { toolCalls: JSON.parse(row.toolCalls) } : {}),
      });
    }
    session.restoreMessages(restoredMessages);

    services.chatManager.setSession(session);
    const messages = session.getMessages();
    return c.json(messages);
  });

  // DELETE /ai/sessions/:id
  app.delete("/sessions/:id", async (c) => {
    const sessionId = decodeURIComponent(c.req.param("id"));
    services.storage.deleteChatSession(sessionId);
    services.storage.deleteAppSetting(`chat_session_title:${sessionId}`);
    return c.json({ ok: true });
  });

  // GET /ai/memories
  app.get("/memories", async (c) => {
    const memories = services.storage.listAiMemories();
    return c.json(memories);
  });

  // PUT /ai/memories/:id
  app.put("/memories/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const body = await c.req.json();
    const { content, category } = body as {
      content: string;
      category: "preference" | "habit" | "context" | "instruction" | "pattern";
    };
    services.storage.updateAiMemory(id, content, category);
    return c.json({ ok: true });
  });

  // DELETE /ai/memories/:id
  app.delete("/memories/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    services.storage.deleteAiMemory(id);
    return c.json({ ok: true });
  });

  return app;
}
