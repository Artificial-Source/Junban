import { isTauri } from "./tauri.js";

export type RuntimeMode = "default" | "remote-desktop";

export const JUNBAN_BACKEND_SERVICE = "junban-backend";
export const DESKTOP_RUNTIME_DESCRIPTOR_CHANGED_EVENT = "junban:desktop-runtime-descriptor-changed";
export const JUNBAN_RUNTIME_UPDATED_EVENT = "junban:runtime-updated";

const DESKTOP_RUNTIME_DESCRIPTOR_TIMEOUT_MS = 15000;
const DESKTOP_RUNTIME_DESCRIPTOR_RETRY_MS = 100;

export interface DesktopApiRuntimeConfig {
  apiBase: string;
  healthUrl: string;
  ready: boolean;
  service: string;
  error?: string | null;
}

export interface JunbanRuntimeConfig {
  mode?: RuntimeMode;
  desktop?: DesktopApiRuntimeConfig;
}

const DEFAULT_RUNTIME_CONFIG: Readonly<JunbanRuntimeConfig> = {
  mode: "default",
};

declare global {
  interface Window {
    __JUNBAN_RUNTIME__?: JunbanRuntimeConfig;
    __JUNBAN_RUNTIME_READY__?: Promise<JunbanRuntimeConfig>;
  }
}

let desktopRuntimeListenerSetup: Promise<void> | null = null;

function normalizeRuntimeConfig(config?: JunbanRuntimeConfig): JunbanRuntimeConfig {
  return {
    mode: config?.mode ?? DEFAULT_RUNTIME_CONFIG.mode,
    desktop: config?.desktop,
  };
}

export function getRuntimeConfig(): JunbanRuntimeConfig {
  if (typeof window === "undefined") {
    return DEFAULT_RUNTIME_CONFIG;
  }

  return normalizeRuntimeConfig(window.__JUNBAN_RUNTIME__);
}

function applyRuntimeConfig(config?: JunbanRuntimeConfig): JunbanRuntimeConfig {
  const normalized = normalizeRuntimeConfig(config);
  window.__JUNBAN_RUNTIME__ = normalized;
  window.__JUNBAN_RUNTIME_READY__ = Promise.resolve(normalized);
  return normalized;
}

function hasDesktopRuntimeDescriptor(config: JunbanRuntimeConfig): boolean {
  const desktop = config.desktop;
  if (!desktop) {
    return false;
  }

  return !desktop.ready || Boolean(desktop.apiBase && desktop.healthUrl);
}

function shouldListenForDesktopRuntimeChanges(): boolean {
  return isTauri() && import.meta.env.VITE_USE_BACKEND !== "true" && !import.meta.env.VITE_API_URL;
}

async function ensureDesktopRuntimeChangeListener(): Promise<void> {
  if (typeof window === "undefined" || !shouldListenForDesktopRuntimeChanges()) {
    return;
  }

  if (desktopRuntimeListenerSetup) {
    return desktopRuntimeListenerSetup;
  }

  desktopRuntimeListenerSetup = (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      await listen<JunbanRuntimeConfig>(DESKTOP_RUNTIME_DESCRIPTOR_CHANGED_EVENT, (event) => {
        const nextRuntime = applyRuntimeConfig(event.payload);
        window.dispatchEvent(
          new CustomEvent<JunbanRuntimeConfig>(JUNBAN_RUNTIME_UPDATED_EVENT, {
            detail: nextRuntime,
          }),
        );
      });
    } catch {
      // Degrade gracefully when Tauri event APIs are unavailable.
    }
  })();

  return desktopRuntimeListenerSetup;
}

async function readTauriRuntimeDescriptor(): Promise<JunbanRuntimeConfig | null> {
  if (!shouldListenForDesktopRuntimeChanges()) {
    return null;
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return normalizeRuntimeConfig(await invoke<JunbanRuntimeConfig>("desktop_runtime_descriptor"));
  } catch {
    return null;
  }
}

async function waitForDesktopRuntimeDescriptor(
  initialConfig: JunbanRuntimeConfig,
): Promise<JunbanRuntimeConfig> {
  if (!shouldListenForDesktopRuntimeChanges() || hasDesktopRuntimeDescriptor(initialConfig)) {
    return initialConfig;
  }

  const startedAt = Date.now();
  let currentConfig = initialConfig;

  while (Date.now() - startedAt < DESKTOP_RUNTIME_DESCRIPTOR_TIMEOUT_MS) {
    const eventConfig = getRuntimeConfig();
    if (hasDesktopRuntimeDescriptor(eventConfig)) {
      return eventConfig;
    }

    const nextConfig = await readTauriRuntimeDescriptor();
    if (nextConfig) {
      currentConfig = nextConfig;
      if (hasDesktopRuntimeDescriptor(currentConfig)) {
        return applyRuntimeConfig(currentConfig);
      }

      const updatedConfig = getRuntimeConfig();
      if (hasDesktopRuntimeDescriptor(updatedConfig)) {
        return updatedConfig;
      }
    }

    await new Promise((resolve) => window.setTimeout(resolve, DESKTOP_RUNTIME_DESCRIPTOR_RETRY_MS));
  }

  const finalConfig = getRuntimeConfig();
  return hasDesktopRuntimeDescriptor(finalConfig) ? finalConfig : currentConfig;
}

export async function waitForRuntimeConfig(): Promise<JunbanRuntimeConfig> {
  if (typeof window === "undefined") {
    return DEFAULT_RUNTIME_CONFIG;
  }

  await ensureDesktopRuntimeChangeListener();

  if (window.__JUNBAN_RUNTIME_READY__) {
    return waitForDesktopRuntimeDescriptor(
      applyRuntimeConfig(await window.__JUNBAN_RUNTIME_READY__),
    );
  }

  return waitForDesktopRuntimeDescriptor(applyRuntimeConfig(window.__JUNBAN_RUNTIME__));
}

export function getRuntimeMode(): RuntimeMode {
  return getRuntimeConfig().mode ?? "default";
}

export function getDesktopApiRuntime(): DesktopApiRuntimeConfig | null {
  return getRuntimeConfig().desktop ?? null;
}

export function isRemoteDesktopRuntime(): boolean {
  return !isTauri() && getRuntimeMode() === "remote-desktop";
}
