import { isTauri } from "./tauri.js";

export type AppNotificationPermission = NotificationPermission | "unsupported";

export interface AppNotificationCopy {
  label: string;
  blockedMessage: string;
  unsupportedMessage: string;
  permissionHint: string;
}

function isNativeNotificationRuntime(): boolean {
  return isTauri();
}

function normalizePermission(permission: unknown): AppNotificationPermission {
  return permission === "granted" || permission === "denied" || permission === "default"
    ? permission
    : "unsupported";
}

export function getNotificationCopy(): AppNotificationCopy {
  if (isNativeNotificationRuntime()) {
    return {
      label: "App notifications",
      blockedMessage:
        "App notifications are blocked. Enable notifications for Junban in your system settings, then try again.",
      unsupportedMessage: "App notifications are not available in this desktop environment.",
      permissionHint: "Junban uses your operating system notification permissions.",
    };
  }

  return {
    label: "Browser notifications",
    blockedMessage:
      "Browser notifications are blocked. Update your browser settings to allow Junban.",
    unsupportedMessage: "Browser notifications are not supported in this environment.",
    permissionHint: "Your browser controls notification permissions for this site.",
  };
}

export async function getAppNotificationPermission(): Promise<AppNotificationPermission> {
  if (isNativeNotificationRuntime()) {
    try {
      const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
      // The Tauri API exposes only a granted/not-granted check here; a request attempt
      // below is the point where denied/default can be distinguished.
      return (await isPermissionGranted()) ? "granted" : "default";
    } catch {
      return "unsupported";
    }
  }

  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }

  return normalizePermission(Notification.permission);
}

export async function requestAppNotificationPermission(): Promise<AppNotificationPermission> {
  if (isNativeNotificationRuntime()) {
    try {
      const { isPermissionGranted, requestPermission } =
        await import("@tauri-apps/plugin-notification");
      if (await isPermissionGranted()) {
        return "granted";
      }

      return normalizePermission(await requestPermission());
    } catch {
      return "unsupported";
    }
  }

  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }

  return normalizePermission(await Notification.requestPermission());
}

export async function sendAppNotification(title: string, body: string): Promise<boolean> {
  if (isNativeNotificationRuntime()) {
    try {
      const { isPermissionGranted, sendNotification } =
        await import("@tauri-apps/plugin-notification");
      if (!(await isPermissionGranted())) {
        return false;
      }

      sendNotification({ title, body });
      return true;
    } catch {
      return false;
    }
  }

  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }

  if (Notification.permission !== "granted") {
    return false;
  }

  new Notification(title, { body });
  return true;
}
