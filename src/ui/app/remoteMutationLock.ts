export function shouldBlockLocalMutations(
  tauriRuntime: boolean,
  remoteStatusKnown: boolean,
  remoteServerRunning: boolean,
): boolean {
  if (!tauriRuntime) {
    return false;
  }

  return !remoteStatusKnown || remoteServerRunning;
}

export function getRemoteStatusFailureFallback(remoteStatusKnown: boolean): {
  remoteStatusKnown: boolean;
  remoteServerRunning: boolean;
} | null {
  if (remoteStatusKnown) {
    return null;
  }

  return {
    remoteStatusKnown: true,
    remoteServerRunning: false,
  };
}
