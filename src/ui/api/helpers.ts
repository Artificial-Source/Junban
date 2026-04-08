import { isTauri } from "../../utils/tauri.js";
import type { WebAppServices } from "../../bootstrap-web.js";

export { isTauri };

/**
 * Whether the frontend should use direct in-process service calls (WASM SQLite).
 * Returns true in packaged Tauri mode when no backend server is configured.
 *
 * When `VITE_USE_BACKEND=true` (set automatically by `pnpm dev:full` and Tauri
 * dev mode), or when `VITE_API_URL` is set, API calls go through fetch to the
 * backend server instead.
 */
export function useDirectServices(): boolean {
  // If explicitly told to use the backend server, never use direct services
  if (import.meta.env.VITE_USE_BACKEND === "true") return false;
  if (import.meta.env.VITE_API_URL) return false;
  // Packaged Tauri builds should be self-contained and not depend on Node.js.
  if (isTauri()) return true;
  // In plain browser dev (pnpm dev), use Vite's inline apiPlugin (fetch to /api)
  return false;
}

/**
 * Base URL for API requests.
 *
 * - In Tauri production: `http://localhost:4822/api` (sidecar server)
 * - In browser with `VITE_API_URL`: that URL
 * - Otherwise: `/api` (relative, handled by Vite proxy or inline apiPlugin)
 */
export const BASE: string = (() => {
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  if (isTauri()) return "http://localhost:4822/api";
  return "/api";
})();

export function buildApiUrl(path: string, params?: Record<string, string | undefined>): string {
  const base = BASE.endsWith("/") ? BASE.slice(0, -1) : BASE;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${normalizedPath}`;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) search.set(key, value);
  }

  const query = search.toString();
  return query ? `${url}?${query}` : url;
}

export async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      // Use status code message
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function handleVoidResponse(res: Response): Promise<void> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      // Use status code message
    }
    throw new Error(message);
  }
}

// Lazy-loaded services for browser WASM mode (only used when useDirectServices() is true)
export type WebServices = WebAppServices;
let _services: WebServices | null = null;
let _pending: Promise<WebServices> | null = null;

export async function getServices(): Promise<WebServices> {
  if (_services) return _services;
  if (_pending) return _pending;
  _pending = (async () => {
    const { bootstrapWeb } = await import("../../bootstrap-web.js");
    _services = await bootstrapWeb();
    _pending = null;
    return _services;
  })();
  return _pending;
}
