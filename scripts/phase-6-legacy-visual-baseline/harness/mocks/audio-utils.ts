export type MicrophoneInfo = {
  deviceId: string;
  label: string;
};

export async function enumerateMicrophones(): Promise<MicrophoneInfo[]> {
  // Offline fixture — no real device enumeration or labels from the host.
  return [{ deviceId: "default", label: "System default microphone" }];
}

export async function triggerMicPermissionPrompt(): Promise<boolean> {
  return false;
}

export function createAudioRecorder(_deviceId?: string) {
  return {
    start: async () => undefined,
    stop: async () => new Blob(),
  };
}
