/**
 * Narrow redirect / final-URL policy for Hugging Face model delivery.
 *
 * Manifest entries always start at https://huggingface.co/<repo>/resolve/<rev>/...
 * In practice HF answers with HTTPS redirects onto Hugging Face-owned hosts:
 *   - huggingface.co (including /api/resolve-cache/...)
 *   - *.hf.co content bridges such as us.aws.cdn.hf.co
 *
 * Junban never attaches credentials or query parameters. The SHA-256 digest of
 * the downloaded bytes remains the trust anchor; host policy only limits where
 * bytes may come from during transport.
 */

export const HF_MANIFEST_HOST = "huggingface.co";

/** Hosts observed (2026-08-02) for HF resolve delivery; keep the allowlist tight. */
const ALLOWED_EXACT_HOSTS = new Set(["huggingface.co", "hf.co"]);

function isHfOwnedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (ALLOWED_EXACT_HOSTS.has(host)) return true;
  // Content CDN / Xet bridge hosts, e.g. us.aws.cdn.hf.co, cas-bridge.xethub.hf.co
  if (host.endsWith(".hf.co")) return true;
  // Legacy LFS-style hosts if still encountered.
  if (host.endsWith(".huggingface.co")) return true;
  return false;
}

export type UrlPolicyResult = { ok: true; url: URL } | { ok: false; reason: string };

/** Validate a manifest entry URL before fetch. */
export function validateManifestUrl(urlString: string): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "non-HTTPS scheme" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials present" };
  }
  // Manifest entries themselves must not carry query/fragment.
  if (url.search || url.hash) {
    return { ok: false, reason: "query or fragment on manifest URL" };
  }
  if (url.hostname.toLowerCase() !== HF_MANIFEST_HOST) {
    return { ok: false, reason: `unsupported manifest host ${url.hostname}` };
  }
  if (url.pathname.includes("/resolve/main/") || urlString.includes("resolve/main")) {
    return { ok: false, reason: "mutable resolve/main path" };
  }
  return { ok: true, url };
}

/**
 * Validate the final response URL after the browser follows redirects.
 * HF may add cache etag query params on resolve-cache URLs; those are server-
 * authored delivery parameters, not Junban credentials.
 */
export function validateFinalDeliveryUrl(urlString: string): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, reason: "invalid final URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "non-HTTPS final URL" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials on final URL" };
  }
  if (!isHfOwnedHost(url.hostname)) {
    return { ok: false, reason: `disallowed final host ${url.hostname}` };
  }
  return { ok: true, url };
}

/** True when a candidate redirect/final host would be rejected. */
export function isDisallowedDeliveryHost(hostname: string): boolean {
  return !isHfOwnedHost(hostname);
}
