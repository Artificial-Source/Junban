import {
  useDirectServices,
  BASE,
  handleResponse,
  handleVoidResponse,
  getServices,
} from "../helpers.js";
import type { AIConfigInfo } from "./ai-types.js";

export async function getAIConfig(): Promise<AIConfigInfo> {
  if (useDirectServices()) {
    const svc = await getServices();
    const providerSetting = svc.storage.getAppSetting("ai_provider");
    const modelSetting = svc.storage.getAppSetting("ai_model");
    const baseUrlSetting = svc.storage.getAppSetting("ai_base_url");
    const apiKeySetting = svc.storage.getAppSetting("ai_api_key");
    const authTypeSetting = svc.storage.getAppSetting("ai_auth_type");
    const oauthTokenSetting = svc.storage.getAppSetting("ai_oauth_token");
    return {
      provider: providerSetting?.value ?? null,
      model: modelSetting?.value ?? null,
      baseUrl: baseUrlSetting?.value ?? null,
      hasApiKey: !!apiKeySetting?.value,
      authType: (authTypeSetting?.value as "api-key" | "oauth") ?? undefined,
      hasOAuthToken: !!oauthTokenSetting?.value,
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
  authType?: string;
  oauthToken?: string;
}): Promise<void> {
  if (useDirectServices()) {
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
    if (config.authType !== undefined) {
      if (config.authType) {
        svc.storage.setAppSetting("ai_auth_type", config.authType);
      } else {
        svc.storage.deleteAppSetting("ai_auth_type");
      }
    }
    if (config.oauthToken) svc.storage.setAppSetting("ai_oauth_token", config.oauthToken);
    const ai = await svc.getAIRuntime();
    ai.chatManager.clearSession(svc.storage);
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
