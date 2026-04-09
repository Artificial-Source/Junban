const BLOCKED_HOSTNAMES = new Set(["localhost", "0.0.0.0"]);

export interface NetworkUrlValidationOptions {
  context: string;
  requireHttps?: boolean;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;

  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function firstIpv6Hextet(host: string): number | null {
  const segments = host.split(":");
  const first = segments.find((segment) => segment.length > 0);
  if (!first || !/^[0-9a-f]{1,4}$/i.test(first)) return null;

  const parsed = Number.parseInt(first, 16);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xffff) return null;
  return parsed;
}

function mappedIpv4FromIpv6(host: string): string | null {
  const lower = host.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;

  const mapped = lower.slice("::ffff:".length);
  if (!mapped) return null;

  if (mapped.includes(".")) {
    return isPrivateIpv4(mapped) ? mapped : null;
  }

  const hexParts = mapped.split(":");
  if (hexParts.length !== 2) return null;
  if (!hexParts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) return null;

  const hi = Number.parseInt(hexParts[0], 16);
  const lo = Number.parseInt(hexParts[1], 16);
  if ([hi, lo].some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;

  const a = (hi >> 8) & 0xff;
  const b = hi & 0xff;
  const c = (lo >> 8) & 0xff;
  const d = lo & 0xff;
  const ipv4 = `${a}.${b}.${c}.${d}`;
  return isPrivateIpv4(ipv4) ? ipv4 : null;
}

function isBlockedIpv6(host: string): boolean {
  if (host === "::1" || host === "::") return true;

  const firstHextet = firstIpv6Hextet(host);
  if (firstHextet !== null) {
    // Link-local: fe80::/10
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;
    // ULA: fc00::/7
    if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true;
  }

  if (mappedIpv4FromIpv6(host)) {
    return true;
  }

  return false;
}

function blockedHostReason(host: string): string | null {
  if (!host) return "missing hostname";
  if (BLOCKED_HOSTNAMES.has(host)) return "local hostnames are not allowed";
  if (host.endsWith(".localhost")) return "localhost subdomains are not allowed";
  if (host.endsWith(".local") || host.endsWith(".internal")) {
    return "internal hostnames are not allowed";
  }
  if (isPrivateIpv4(host)) return "private IPv4 ranges are not allowed";
  if (isBlockedIpv6(host)) return "local/private IPv6 ranges are not allowed";
  return null;
}

export function validateOutboundNetworkUrl(
  rawUrl: string,
  options: NetworkUrlValidationOptions,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Blocked ${options.context}: invalid URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Blocked ${options.context}: URL scheme "${parsed.protocol}" is not allowed (http/https only)`,
    );
  }

  if (options.requireHttps && parsed.protocol !== "https:") {
    throw new Error(`Blocked ${options.context}: HTTPS is required`);
  }

  const host = normalizeHostname(parsed.hostname);
  const reason = blockedHostReason(host);
  if (reason) {
    throw new Error(`Blocked ${options.context}: host "${host}" is not allowed (${reason})`);
  }

  return parsed;
}
