import { readFixture } from "./read-fixture";

export interface AIProviderInfo {
  name: string;
  displayName: string;
  needsApiKey: boolean;
  optionalApiKey?: boolean;
  supportsOAuth?: boolean;
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

export interface AIConfigInfo {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  authType?: "api-key" | "oauth";
  hasOAuthToken?: boolean;
}

const PROVIDERS: AIProviderInfo[] = [
  {
    name: "openai",
    displayName: "OpenAI",
    needsApiKey: true,
    supportsOAuth: true,
    defaultModel: "gpt-4o",
    suggestedModels: ["gpt-4o", "gpt-4o-mini"],
    pluginId: null,
  },
  {
    name: "anthropic",
    displayName: "Anthropic",
    needsApiKey: true,
    defaultModel: "claude-sonnet-4-5",
    pluginId: null,
  },
  {
    name: "ollama",
    displayName: "Ollama",
    needsApiKey: false,
    defaultModel: "llama3.2",
    defaultBaseUrl: "http://127.0.0.1:11434",
    showBaseUrl: true,
    pluginId: null,
  },
  {
    name: "lmstudio",
    displayName: "LM Studio",
    needsApiKey: false,
    optionalApiKey: true,
    defaultModel: "local-model",
    defaultBaseUrl: "http://127.0.0.1:1234",
    showBaseUrl: true,
    pluginId: null,
  },
];

export async function listAIProviders(): Promise<AIProviderInfo[]> {
  return PROVIDERS;
}

export async function fetchModels(
  _provider: string,
  _baseUrl?: string,
): Promise<ModelDiscoveryInfo[]> {
  const fixture = readFixture();
  if (!fixture.aiConfigured && !fixture.aiProvider) {
    return [];
  }
  // Deterministic offline catalog — no network.
  return [
    { id: "gpt-4o", label: "GPT-4o", loaded: true },
    { id: "gpt-4o-mini", label: "GPT-4o mini", loaded: false },
  ];
}

export async function loadModel(): Promise<void> {}
export async function unloadModel(): Promise<void> {}

export async function getAIConfig(): Promise<AIConfigInfo> {
  const fixture = readFixture();
  return {
    provider: fixture.aiConfigured ? fixture.aiProvider || "openai" : null,
    model: fixture.aiConfigured ? fixture.aiModel || "gpt-4o" : null,
    baseUrl: null,
    hasApiKey: fixture.aiHasApiKey,
    authType: "api-key",
    hasOAuthToken: false,
  };
}

export async function updateAIConfig(): Promise<void> {}

export async function sendChatMessage(): Promise<Response> {
  throw new Error("network disabled in Phase 6 visual harness");
}
export async function getChatMessages() {
  return [];
}
export async function clearChat() {}
export async function listChatSessions() {
  return [];
}
export async function renameChatSession() {}
export async function deleteChatSession() {}
export async function switchChatSession() {}
export async function createNewChatSession() {}
export async function getAiMemories() {
  return [];
}
export async function updateAiMemory() {}
export async function deleteAiMemory() {}
export async function deleteAllAiMemories() {}
