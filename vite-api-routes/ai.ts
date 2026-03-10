import type { RouteRegistrar } from "./types.js";
import { parseBody } from "./types.js";

export const registerAIRoutes: RouteRegistrar = (server, getServices) => {
  // GET /api/ai/providers — list all registered AI providers
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/ai/providers" || req.method !== "GET") return next();

    const svc = await getServices();
    const registry = svc.aiProviderRegistry;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const providers = registry.getAll().map((r: any) => ({
      name: r.plugin.name,
      displayName: r.plugin.displayName,
      needsApiKey: r.plugin.needsApiKey,
      optionalApiKey: r.plugin.optionalApiKey ?? false,
      defaultModel: r.plugin.defaultModel,
      defaultBaseUrl: r.plugin.defaultBaseUrl,
      showBaseUrl: r.plugin.showBaseUrl ?? false,
      pluginId: r.pluginId,
    }));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(providers));
  });

  // GET/PUT /api/ai/config
  server.middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/ai/config")) return next();

    const svc = await getServices();

    if (req.method === "GET") {
      const providerSetting = svc.storage.getAppSetting("ai_provider");
      const modelSetting = svc.storage.getAppSetting("ai_model");
      const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
      const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          provider: providerSetting?.value ?? null,
          model: modelSetting?.value ?? null,
          baseUrl: baseUrlSetting?.value ?? null,
          hasApiKey: !!apiKeySetting?.value,
        }),
      );
      return;
    }

    if (req.method === "PUT") {
      const body = await parseBody(req);
      const { provider, apiKey, model, baseUrl } = body as {
        provider?: string;
        apiKey?: string;
        model?: string;
        baseUrl?: string;
      };
      if (provider) svc.storage.setAppSetting("ai_provider", provider);
      if (apiKey) svc.storage.setAppSetting("ai_api_key", apiKey);
      if (model !== undefined) {
        if (model) {
          svc.storage.setAppSetting("ai_model", model);
        } else {
          svc.storage.deleteAppSetting("ai_model");
        }
      }
      if (baseUrl !== undefined) {
        if (baseUrl) {
          svc.storage.setAppSetting("ai_base_url", baseUrl);
        } else {
          svc.storage.deleteAppSetting("ai_base_url");
        }
      }
      // Reset chat session when provider config changes
      svc.chatManager.clearSession(svc.storage);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    next();
  });

  // GET /api/ai/providers/:name/models — fetch available models for a provider
  server.middlewares.use(async (req, res, next) => {
    const modelsMatch = req.url?.match(/^\/api\/ai\/providers\/([^/]+)\/models(\?.*)?$/);
    if (!modelsMatch || req.method !== "GET") return next();

    try {
      const providerName = modelsMatch[1];
      const svc = await getServices();
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const baseUrlOverride = url.searchParams.get("baseUrl");

      const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
      const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

      const { fetchAvailableModels } = await import("../src/ai/model-discovery.js");
      const models = await fetchAvailableModels(providerName, {
        apiKey: apiKeySetting?.value,
        baseUrl: baseUrlOverride || baseUrlSetting?.value,
      });

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models }));
    } catch {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ models: [] }));
    }
  });

  // POST /api/ai/providers/:name/models/load — load a model (LM Studio)
  server.middlewares.use(async (req, res, next) => {
    const loadMatch = req.url?.match(/^\/api\/ai\/providers\/([^/]+)\/models\/load$/);
    if (!loadMatch || req.method !== "POST") return next();

    try {
      const providerName = loadMatch[1];
      const svc = await getServices();
      const body = await parseBody(req);
      const { model: modelKey, baseUrl: baseUrlOverride } = body as {
        model: string;
        baseUrl?: string;
      };
      const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
      const apiKeySetting = svc.storage.getAppSetting("ai_api_key");

      if (providerName === "lmstudio") {
        const { loadLMStudioModel } = await import("../src/ai/model-discovery.js");
        await loadLMStudioModel(
          modelKey,
          (baseUrlOverride as string) || baseUrlSetting?.value || "http://localhost:1234/v1",
          apiKeySetting?.value,
        );
      }

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load model";
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: message }));
    }
  });

  // POST /api/ai/chat — SSE streaming chat
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/ai/chat" || req.method !== "POST") return next();

    const svc = await getServices();
    const body = await parseBody(req);
    const message = (body as { message: string; voiceCall?: boolean; focusedTaskId?: string })
      .message;
    const voiceCall = (body as { voiceCall?: boolean }).voiceCall;
    const focusedTaskId = (body as { focusedTaskId?: string }).focusedTaskId;

    if (!message) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "message is required" }));
      return;
    }

    // Load provider config
    const providerSetting = svc.storage.getAppSetting("ai_provider");
    if (!providerSetting?.value) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(
        `data: ${JSON.stringify({ type: "error", data: "No AI provider configured. Go to Settings to set one up." })}\n\n`,
      );
      res.end();
      return;
    }

    try {
      const { gatherContext } = await import("../src/ai/chat.js");
      const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
      const modelSetting = svc.storage.getAppSetting("ai_model");
      const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");

      const providerConfig = {
        provider: providerSetting.value as string,
        apiKey: apiKeySetting?.value,
        model: modelSetting?.value,
        baseUrl: baseUrlSetting?.value,
      };

      const executor = svc.aiProviderRegistry.createExecutor(providerConfig);

      const toolServices = {
        taskService: svc.taskService,
        projectService: svc.projectService,
        tagService: svc.tagService,
        statsService: svc.statsService,
        storage: svc.storage,
      };

      // Gather context for new sessions
      const isLocalProvider =
        providerSetting.value === "ollama" || providerSetting.value === "lmstudio";
      const contextBlock = await gatherContext(toolServices, {
        compact: isLocalProvider,
        voiceCall,
        focusedTaskId,
      });

      const session = svc.chatManager.getOrCreateSession(executor, toolServices, {
        queries: svc.storage,
        contextBlock,
        toolRegistry: svc.toolRegistry,
        model: modelSetting?.value ?? undefined,
        providerName: providerSetting.value as string,
      });

      session.addUserMessage(message);

      // SSE response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      for await (const event of session.run()) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      res.end();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(
        `data: ${JSON.stringify({ type: "error", data: err.message ?? "Unknown error" })}\n\n`,
      );
      res.end();
    }
  });

  // GET /api/ai/messages — current chat history (from memory or DB)
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/ai/messages" || req.method !== "GET") return next();

    const svc = await getServices();
    let session = svc.chatManager.getSession();

    // Try to restore from DB if no in-memory session
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
              statsService: svc.statsService,
              storage: svc.storage,
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
        // Non-critical — just return empty messages
      }
    }

    const messages = session ? session.getMessages() : [];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(messages));
  });

  // POST /api/ai/clear — reset chat session
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/ai/clear" || req.method !== "POST") return next();

    const svc = await getServices();
    svc.chatManager.clearSession(svc.storage);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  // ── AI Session Endpoints ──────────────────────────

  // GET /api/ai/sessions — list all chat sessions
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/ai/sessions" || req.method !== "GET") return next();

    const svc = await getServices();
    const sessions = svc.storage.listChatSessions();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(sessions));
  });

  // POST /api/ai/sessions/new — start a new chat session
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/ai/sessions/new" || req.method !== "POST") return next();

    const svc = await getServices();
    // Fire-and-forget memory extraction from current session
    const currentSession = svc.chatManager.getSession();
    if (currentSession) {
      currentSession.extractMemories().catch(() => {});
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc.chatManager as any).session = null;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sessionId: "" }));
  });

  // AI session operations: rename, delete, switch, unload
  server.middlewares.use(async (req, res, next) => {
    // PUT /api/ai/sessions/:id/title — rename a session
    const titleMatch = req.url?.match(/^\/api\/ai\/sessions\/([^/]+)\/title$/);
    if (titleMatch && req.method === "PUT") {
      try {
        const svc = await getServices();
        const sessionId = decodeURIComponent(titleMatch[1]);
        const body = await parseBody(req);
        const title = (body as { title: string }).title;
        svc.storage.renameChatSession(sessionId, title);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal server error";
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    // POST /api/ai/sessions/:id/switch — switch to a session
    const switchMatch = req.url?.match(/^\/api\/ai\/sessions\/([^/]+)\/switch$/);
    if (switchMatch && req.method === "POST") {
      try {
        const svc = await getServices();
        // Fire-and-forget memory extraction from current session
        const currentSession = svc.chatManager.getSession();
        if (currentSession) {
          currentSession.extractMemories().catch(() => {});
        }
        const sessionId = decodeURIComponent(switchMatch[1]);
        const providerSetting = svc.storage.getAppSetting("ai_provider");
        if (!providerSetting?.value) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify([]));
          return;
        }

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
        if (rows.length === 0) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify([]));
          return;
        }

        const toolServices = {
          taskService: svc.taskService,
          projectService: svc.projectService,
          tagService: svc.tagService,
          statsService: svc.statsService,
          storage: svc.storage,
        };

        const systemMessage = svc.chatManager.buildSystemMessage(
          toolServices,
          "",
          providerSetting.value as string,
        );
        const { ChatSession } = await import("../src/ai/chat.js");
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (session as any).messages.push(msg);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (svc.chatManager as any).session = session;
        const messages = session.getMessages();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(messages));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal server error";
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    // DELETE /api/ai/sessions/:id — delete a session
    const deleteMatch = req.url?.match(/^\/api\/ai\/sessions\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      try {
        const svc = await getServices();
        const sessionId = decodeURIComponent(deleteMatch[1]);
        svc.storage.deleteChatSession(sessionId);
        svc.storage.deleteAppSetting(`chat_session_title:${sessionId}`);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal server error";
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    // POST /api/ai/providers/:name/models/unload — unload a model
    const unloadMatch = req.url?.match(/^\/api\/ai\/providers\/([^/]+)\/models\/unload$/);
    if (unloadMatch && req.method === "POST") {
      try {
        const providerName = decodeURIComponent(unloadMatch[1]);
        const svc = await getServices();
        const body = await parseBody(req);
        const { model: modelKey, baseUrl: baseUrlOverride } = body as {
          model: string;
          baseUrl?: string;
        };
        const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
        const apiKeySetting = svc.storage.getAppSetting("ai_api_key");

        if (providerName === "lmstudio") {
          const { unloadLMStudioModel } = await import("../src/ai/model-discovery.js");
          await unloadLMStudioModel(
            modelKey,
            (baseUrlOverride as string) || baseUrlSetting?.value || "http://localhost:1234/v1",
            apiKeySetting?.value,
          );
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to unload model";
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    next();
  });

  // ── AI Memory Endpoints ──────────────────────────

  // GET /api/ai/memories — list all AI memories
  server.middlewares.use(async (req, res, next) => {
    if (req.url !== "/api/ai/memories" || req.method !== "GET") return next();

    const svc = await getServices();
    const memories = svc.storage.listAiMemories();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(memories));
  });

  // AI memory operations: update, delete
  server.middlewares.use(async (req, res, next) => {
    // PUT /api/ai/memories/:id — update a memory
    const updateMatch = req.url?.match(/^\/api\/ai\/memories\/([^/]+)$/);
    if (updateMatch && req.method === "PUT") {
      try {
        const svc = await getServices();
        const id = decodeURIComponent(updateMatch[1]);
        const body = await parseBody(req);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { content, category } = body as { content: string; category: string };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        svc.storage.updateAiMemory(id, content, category as any);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal server error";
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    // DELETE /api/ai/memories/:id — delete a memory
    const deleteMatch = req.url?.match(/^\/api\/ai\/memories\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      try {
        const svc = await getServices();
        const id = decodeURIComponent(deleteMatch[1]);
        svc.storage.deleteAiMemory(id);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Internal server error";
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    next();
  });
};
