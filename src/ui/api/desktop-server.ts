import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../utils/tauri.js";

export interface DesktopRemoteServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  localUrl: string | null;
}

export interface DesktopRemoteServerConfig {
  port: number;
  autoStart: boolean;
  passwordEnabled: boolean;
  hasPassword: boolean;
}

export interface RemoteSessionStatus {
  authorized: boolean;
  requiresPassword: boolean;
  sessionLocked: boolean;
}

export const DESKTOP_REMOTE_SERVER_STATUS_CHANGED_EVENT =
  "junban:desktop-remote-server-status-changed";

const UNAVAILABLE_STATUS: DesktopRemoteServerStatus = {
  available: false,
  running: false,
  port: null,
  localUrl: null,
};

function emitDesktopRemoteServerStatus(status: DesktopRemoteServerStatus) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<DesktopRemoteServerStatus>(DESKTOP_REMOTE_SERVER_STATUS_CHANGED_EVENT, {
      detail: status,
    }),
  );
}

export async function getDesktopRemoteServerStatus(): Promise<DesktopRemoteServerStatus> {
  if (!isTauri()) {
    emitDesktopRemoteServerStatus(UNAVAILABLE_STATUS);
    return UNAVAILABLE_STATUS;
  }

  const status = await invoke<DesktopRemoteServerStatus>("remote_server_status");
  emitDesktopRemoteServerStatus(status);
  return status;
}

export async function getDesktopRemoteServerConfig(): Promise<DesktopRemoteServerConfig> {
  if (!isTauri()) {
    return {
      port: 4822,
      autoStart: false,
      passwordEnabled: false,
      hasPassword: false,
    };
  }

  return invoke<DesktopRemoteServerConfig>("remote_server_get_config");
}

export async function updateDesktopRemoteServerConfig(input: {
  port: number;
  autoStart: boolean;
  passwordEnabled: boolean;
  password?: string;
}): Promise<DesktopRemoteServerConfig> {
  if (!isTauri()) {
    return {
      port: input.port,
      autoStart: input.autoStart,
      passwordEnabled: input.passwordEnabled,
      hasPassword: Boolean(input.passwordEnabled && input.password),
    };
  }

  return invoke<DesktopRemoteServerConfig>("remote_server_update_config", input);
}

export async function startDesktopRemoteServer(port: number): Promise<DesktopRemoteServerStatus> {
  if (!isTauri()) {
    emitDesktopRemoteServerStatus(UNAVAILABLE_STATUS);
    return UNAVAILABLE_STATUS;
  }

  const status = await invoke<DesktopRemoteServerStatus>("remote_server_start", { port });
  emitDesktopRemoteServerStatus(status);
  return status;
}

export async function stopDesktopRemoteServer(): Promise<DesktopRemoteServerStatus> {
  if (!isTauri()) {
    emitDesktopRemoteServerStatus(UNAVAILABLE_STATUS);
    return UNAVAILABLE_STATUS;
  }

  const status = await invoke<DesktopRemoteServerStatus>("remote_server_stop");
  emitDesktopRemoteServerStatus(status);
  return status;
}

export async function getRemoteSessionStatus(): Promise<RemoteSessionStatus> {
  const response = await fetch("/_junban/session", { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to fetch remote session status: HTTP ${response.status}`);
  }
  return response.json() as Promise<RemoteSessionStatus>;
}

export async function claimRemoteSession(): Promise<RemoteSessionStatus> {
  const response = await fetch("/_junban/session/claim", {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error("Remote access request was rejected by same-origin protection");
    }
    if (response.status === 401) {
      throw new Error("Remote access requires a password");
    }
    if (response.status === 409) {
      throw new Error("Another remote browser session is already connected");
    }
    throw new Error(`Failed to claim remote access: HTTP ${response.status}`);
  }

  return response.json() as Promise<RemoteSessionStatus>;
}

export async function loginRemoteSession(password: string): Promise<RemoteSessionStatus> {
  const response = await fetch("/_junban/session/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    if (response.status === 403) {
      throw new Error("Remote access request was rejected by same-origin protection");
    }
    if (response.status === 429) {
      throw new Error("Too many failed attempts. Try again shortly.");
    }
    if (response.status === 401) {
      throw new Error("Incorrect password");
    }
    if (response.status === 409) {
      throw new Error("Another remote browser session is already connected");
    }
    throw new Error(`Failed to unlock remote access: HTTP ${response.status}`);
  }

  return response.json() as Promise<RemoteSessionStatus>;
}
