/**
 * Validate user-supplied AI provider base URLs.
 *
 * Used by API/Vite route layers to reduce SSRF risk:
 * - allow localhost URLs for local providers (ollama/lmstudio)
 * - allow known cloud provider domains (exact or subdomain)
 */
export function isAllowedAIBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    if (!parsed.protocol || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return false;
    }

    const host = parsed.hostname.toLowerCase();

    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
      return true;
    }

    return (
      matchesHostOrSubdomain(host, "openai.com") ||
      matchesHostOrSubdomain(host, "anthropic.com") ||
      matchesHostOrSubdomain(host, "openrouter.ai") ||
      matchesHostOrSubdomain(host, "groq.com")
    );
  } catch {
    return false;
  }
}

function matchesHostOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
