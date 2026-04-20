import { isTauri } from "../../utils/tauri.js";
import {
  type DesktopApiRuntimeConfig,
  getDesktopApiRuntime,
  isRemoteDesktopRuntime,
  JUNBAN_BACKEND_SERVICE,
  waitForRuntimeConfig,
} from "../../utils/runtime.js";

export { isTauri };

const DESKTOP_BACKEND_READY_TIMEOUT_MS = 15000;
const DESKTOP_BACKEND_READY_RETRY_MS = 200;

interface DesktopHealthResponse {
  ok?: boolean;
  service?: string;
}

function isTauriSidecarMode(): boolean {
  return isTauri() && import.meta.env.VITE_USE_BACKEND !== "true" && !import.meta.env.VITE_API_URL;
}

function getDesktopRuntimeOrThrow() {
  const runtime = getDesktopApiRuntime();
  if (!runtime) {
    throw new Error("Packaged desktop runtime descriptor is missing the local API base.");
  }
  return runtime;
}

function createDesktopRuntimeError(runtime: DesktopApiRuntimeConfig, fallback: string): Error {
  const detail = runtime.error?.trim();
  return new Error(detail || fallback);
}

function isJunbanBackendHealth(
  payload: unknown,
  expectedService: string,
): payload is Required<DesktopHealthResponse> {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const candidate = payload as DesktopHealthResponse;
  return candidate.ok === true && candidate.service === expectedService;
}

export function getApiBase(): string {
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  if (import.meta.env.VITE_USE_BACKEND === "true") return "/api";

  const desktopRuntime = getDesktopApiRuntime();
  if (desktopRuntime) {
    if (!desktopRuntime.ready) {
      throw createDesktopRuntimeError(
        desktopRuntime,
        "Packaged desktop runtime descriptor reported an unready local backend.",
      );
    }
    if (!desktopRuntime.apiBase) {
      throw new Error("Packaged desktop runtime descriptor is missing the local API base.");
    }
    return desktopRuntime.apiBase;
  }

  if (isTauriSidecarMode()) {
    throw new Error("Packaged desktop runtime descriptor is missing the local API base.");
  }

  return "/api";
}

const BASE_ACCESSOR = {
  [Symbol.toPrimitive](): string {
    return getApiBase();
  },
  toString(): string {
    return getApiBase();
  },
  valueOf(): string {
    return getApiBase();
  },
};

/**
 * Whether the frontend should use direct in-process service calls (WASM SQLite).
 * Returns true only for browser-side embedded runtimes that still own
 * persistence in-browser.
 *
 * When `VITE_USE_BACKEND=true` (set automatically by `pnpm dev:full` and Tauri
 * dev mode), or when `VITE_API_URL` is set, API calls go through fetch to the
 * backend server instead.
 */
export function useDirectServices(): boolean {
  // If explicitly told to use the backend server, never use direct services
  if (import.meta.env.VITE_USE_BACKEND === "true") return false;
  if (import.meta.env.VITE_API_URL) return false;
  if (isRemoteDesktopRuntime()) return false;
  if (isTauri()) return false;
  // In plain browser dev (pnpm dev), use Vite's inline apiPlugin (fetch to /api)
  return false;
}

/**
 * Base URL for API requests.
 *
 * - In packaged Tauri: runtime-provided localhost sidecar base (local Node backend)
 * - In Tauri/browser dev with `VITE_USE_BACKEND=true`: `/api` (Vite proxy)
 * - In browser with `VITE_API_URL`: that URL
 * - Otherwise: `/api` (relative, handled by Vite proxy or inline apiPlugin)
 */
export const BASE = BASE_ACCESSOR as unknown as string;

let desktopBackendReady: Promise<void> | null = null;

export async function waitForDesktopApiReady(): Promise<void> {
  await waitForRuntimeConfig();

  if (!isTauriSidecarMode()) {
    return;
  }

  const desktopRuntime = getDesktopRuntimeOrThrow();
  if (!desktopRuntime.ready) {
    throw createDesktopRuntimeError(
      desktopRuntime,
      "Packaged desktop runtime descriptor reported an unready local backend.",
    );
  }
  if (!desktopRuntime.healthUrl) {
    throw new Error("Packaged desktop runtime descriptor is missing the local health URL.");
  }

  if (desktopBackendReady) {
    return desktopBackendReady;
  }

  desktopBackendReady = (async () => {
    const startedAt = Date.now();
    let lastError: unknown = null;

    while (Date.now() - startedAt < DESKTOP_BACKEND_READY_TIMEOUT_MS) {
      try {
        const response = await fetch(desktopRuntime.healthUrl);
        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status}`);
        } else {
          const payload: unknown = await response.json();
          if (isJunbanBackendHealth(payload, desktopRuntime.service)) {
            return;
          }

          lastError = new Error(
            `health endpoint did not identify ${desktopRuntime.service || JUNBAN_BACKEND_SERVICE}`,
          );
        }
      } catch (error) {
        lastError = error;
      }

      await new Promise((resolve) => window.setTimeout(resolve, DESKTOP_BACKEND_READY_RETRY_MS));
    }

    desktopBackendReady = null;
    throw new Error(
      `Desktop backend did not become ready in time${
        lastError instanceof Error ? `: ${lastError.message}` : ""
      }`,
    );
  })();

  return desktopBackendReady;
}

export function buildApiUrl(path: string, params?: Record<string, string | undefined>): string {
  const resolvedBase = getApiBase();
  const base = resolvedBase.endsWith("/") ? resolvedBase.slice(0, -1) : resolvedBase;
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
