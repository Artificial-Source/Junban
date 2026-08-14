/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enumerateMicrophones,
  MIC_PREFERENCES_STORAGE_KEY,
  readMicPreferences,
  requestMicrophoneAccessAndEnumerate,
  stopMediaStream,
  writeMicPreferences,
} from "./micPreferences";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    dump: () => Object.fromEntries(map),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("micPreferences", () => {
  it("reads and writes only a versioned device id", () => {
    const storage = memoryStorage();
    expect(readMicPreferences(storage)).toEqual({ version: 1, deviceId: "" });

    writeMicPreferences({ version: 1, deviceId: "dev-1" }, storage);
    expect(storage.dump()[MIC_PREFERENCES_STORAGE_KEY]).toBe(
      JSON.stringify({ version: 1, deviceId: "dev-1" }),
    );
    expect(readMicPreferences(storage)).toEqual({ version: 1, deviceId: "dev-1" });

    writeMicPreferences({ version: 1, deviceId: "" }, storage);
    expect(storage.dump()[MIC_PREFERENCES_STORAGE_KEY]).toBeUndefined();
  });

  it("rejects secret-looking or invalid stored values", () => {
    const storage = memoryStorage({
      [MIC_PREFERENCES_STORAGE_KEY]: JSON.stringify({
        version: 1,
        deviceId: "sk-not-a-device",
      }),
    });
    expect(readMicPreferences(storage).deviceId).toBe("");
  });

  it("stops every media track", () => {
    const stop = vi.fn();
    stopMediaStream({
      getTracks: () => [{ stop }, { stop }],
    } as unknown as MediaStream);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("enumerates after permission and always stops opened tracks", async () => {
    const stop = vi.fn();
    const track = { stop };
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [track],
    }));
    const enumerateDevices = vi.fn(async () => [
      { kind: "audioinput", deviceId: "a", label: "Built-in" },
      { kind: "videoinput", deviceId: "cam", label: "Camera" },
      { kind: "audioinput", deviceId: "b", label: "" },
    ]);
    const mediaDevices = { getUserMedia, enumerateDevices } as unknown as MediaDevices;

    const result = await requestMicrophoneAccessAndEnumerate(mediaDevices);
    expect(result).toEqual({
      status: "granted",
      devices: [
        { deviceId: "a", label: "Built-in" },
        { deviceId: "b", label: "Microphone 2" },
      ],
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
  });

  it("maps permission denial without raw diagnostics", async () => {
    const mediaDevices = {
      getUserMedia: vi.fn(async () => {
        throw new DOMException("Permission denied by user agent detail", "NotAllowedError");
      }),
      enumerateDevices: vi.fn(),
    } as unknown as MediaDevices;

    await expect(requestMicrophoneAccessAndEnumerate(mediaDevices)).resolves.toEqual({
      status: "denied",
    });
  });

  it("reports unsupported when mediaDevices is missing", async () => {
    await expect(requestMicrophoneAccessAndEnumerate(null)).resolves.toEqual({
      status: "unsupported",
    });
  });

  it("enumerates without opening a stream", async () => {
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        { kind: "audioinput", deviceId: "x", label: "USB Mic" },
      ]),
    } as unknown as MediaDevices;
    await expect(enumerateMicrophones(mediaDevices)).resolves.toEqual([
      { deviceId: "x", label: "USB Mic" },
    ]);
  });
});
