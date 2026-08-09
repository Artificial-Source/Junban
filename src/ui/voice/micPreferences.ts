/**
 * Browser-local, non-secret microphone preference storage.
 *
 * Device IDs are origin-specific and never leave the browser. Only the selected
 * device ID is retained — labels, streams, and permission diagnostics are not.
 */

export const MIC_PREFERENCES_STORAGE_KEY = "junban.voice.mic.v1";

export type MicPreferences = {
  version: 1;
  /** Empty string means system default. */
  deviceId: string;
};

const DEFAULT_PREFS: MicPreferences = {
  version: 1,
  deviceId: "",
};

export function readMicPreferences(
  storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): MicPreferences {
  if (!storage) return { ...DEFAULT_PREFS };
  try {
    const raw = storage.getItem(MIC_PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PREFS };
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return { ...DEFAULT_PREFS };
    const deviceId = typeof record.deviceId === "string" ? record.deviceId : "";
    // Reject values that look like secrets or oversized payloads.
    if (deviceId.length > 256 || /sk-|api[_-]?key|bearer\s/i.test(deviceId)) {
      return { ...DEFAULT_PREFS };
    }
    return { version: 1, deviceId };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writeMicPreferences(
  prefs: MicPreferences,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = typeof localStorage !== "undefined"
    ? localStorage
    : null,
): void {
  if (!storage) return;
  const deviceId = prefs.deviceId.trim();
  if (!deviceId) {
    try {
      storage.removeItem(MIC_PREFERENCES_STORAGE_KEY);
    } catch {
      // ignore quota / private-mode failures
    }
    return;
  }
  if (deviceId.length > 256) return;
  try {
    storage.setItem(MIC_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1 as const, deviceId }));
  } catch {
    // ignore quota / private-mode failures
  }
}

export type MicrophoneDevice = {
  deviceId: string;
  label: string;
};

export type MicPermissionOutcome =
  | { status: "granted"; devices: MicrophoneDevice[] }
  | { status: "denied" }
  | { status: "unsupported" }
  | { status: "failed" };

/** Stop every track on a media stream (best-effort). */
export function stopMediaStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // ignore
    }
  }
}

/**
 * Request microphone permission from an explicit user gesture, enumerate input
 * devices, then immediately release any opened tracks.
 */
export async function requestMicrophoneAccessAndEnumerate(
  mediaDevices: MediaDevices | null = typeof navigator !== "undefined"
    ? (navigator.mediaDevices ?? null)
    : null,
): Promise<MicPermissionOutcome> {
  if (!mediaDevices?.getUserMedia || !mediaDevices.enumerateDevices) {
    return { status: "unsupported" };
  }

  let stream: MediaStream | null = null;
  try {
    stream = await mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return { status: "denied" };
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      // Permission may still be granted with no devices.
      try {
        const devices = await listAudioInputs(mediaDevices);
        return { status: "granted", devices };
      } catch {
        return { status: "failed" };
      }
    }
    return { status: "failed" };
  } finally {
    stopMediaStream(stream);
    stream = null;
  }

  try {
    const devices = await listAudioInputs(mediaDevices);
    return { status: "granted", devices };
  } catch {
    return { status: "failed" };
  }
}

/** Enumerate audio inputs without opening a stream (labels need prior grant). */
export async function enumerateMicrophones(
  mediaDevices: MediaDevices | null = typeof navigator !== "undefined"
    ? (navigator.mediaDevices ?? null)
    : null,
): Promise<MicrophoneDevice[]> {
  if (!mediaDevices?.enumerateDevices) return [];
  return listAudioInputs(mediaDevices);
}

async function listAudioInputs(mediaDevices: MediaDevices): Promise<MicrophoneDevice[]> {
  const devices = await mediaDevices.enumerateDevices();
  const mics: MicrophoneDevice[] = [];
  let index = 0;
  for (const device of devices) {
    if (device.kind !== "audioinput") continue;
    index += 1;
    const deviceId = device.deviceId || `mic-${index}`;
    const label = device.label?.trim() || `Microphone ${index}`;
    mics.push({ deviceId, label });
  }
  return mics;
}
