export type AIErrorCategory = "auth" | "rate_limit" | "network" | "server" | "timeout" | "unknown";

export class AIError extends Error {
  readonly category: AIErrorCategory;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    category: AIErrorCategory,
    retryable: boolean,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AIError";
    this.category = category;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface StreamErrorData {
  message: string;
  category: AIErrorCategory;
  retryable: boolean;
  retryAfterMs?: number;
}

/** Shape of errors from AI provider SDKs (OpenAI, Anthropic, etc.). */
interface ProviderErrorShape {
  status?: number;
  headers?: Record<string, string>;
  code?: string;
}

/** Extract provider error fields via duck-typing. */
function asProviderError(err: unknown): ProviderErrorShape {
  const obj = err as Record<string, unknown>;
  return {
    status: typeof obj?.status === "number" ? obj.status : undefined,
    headers:
      obj?.headers && typeof obj.headers === "object"
        ? (obj.headers as Record<string, string>)
        : undefined,
    code: typeof obj?.code === "string" ? obj.code : undefined,
  };
}

export function classifyProviderError(err: unknown, providerName?: string): AIError {
  if (err instanceof AIError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const { status, headers, code } = asProviderError(err);

  if (status === 401 || status === 403) {
    return new AIError(
      "Authentication failed. Please check your API key in Settings.",
      "auth",
      false,
    );
  }

  if (status === 429) {
    let retryAfterMs: number | undefined;
    const retryAfter = headers?.["retry-after"];
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds)) retryAfterMs = seconds * 1000;
    }
    return new AIError(
      "Rate limit exceeded. Please wait a moment and try again.",
      "rate_limit",
      true,
      retryAfterMs,
    );
  }

  if (status && status >= 500) {
    return new AIError("The AI provider is experiencing issues. Please try again.", "server", true);
  }

  // Network errors (ECONNREFUSED, ENOTFOUND, fetch failures, etc.)
  const isNetworkError =
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("Failed to fetch");

  if (isNetworkError) {
    const isLocal = providerName === "ollama" || providerName === "lmstudio";
    const isLocalFromMessage = message.includes("localhost") || message.includes("127.0.0.1");

    if (isLocal || isLocalFromMessage) {
      const appName =
        providerName === "ollama"
          ? "Ollama"
          : providerName === "lmstudio"
            ? "LM Studio"
            : "the local AI app";
      const connectionRefused = code === "ECONNREFUSED" || message.includes("ECONNREFUSED");
      if (connectionRefused) {
        return new AIError(
          `Could not connect to ${appName}. Make sure ${appName} is running and its local server is started.`,
          "network",
          true,
        );
      }
      return new AIError(
        `Lost connection to ${appName}. Check that it's still running.`,
        "network",
        true,
      );
    }

    return new AIError(
      "Could not connect to the AI provider. Check your network connection and API settings.",
      "network",
      true,
    );
  }

  return new AIError(message || "An unexpected error occurred.", "unknown", true);
}
