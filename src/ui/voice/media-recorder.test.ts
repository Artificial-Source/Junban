/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { createPttCapture } from "./media-recorder";

function mockStream() {
  const stop = vi.fn();
  return {
    stream: { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream,
    stop,
  };
}

describe("media-recorder PTT capture", () => {
  it("selects MIME, collects chunks, stops tracks on stop", async () => {
    const { stream, stop } = mockStream();
    const getUserMedia = vi.fn(async () => stream);

    let ondata: ((ev: BlobEvent) => void) | null = null;
    let onstop: (() => void) | null = null;
    const recorderStop = vi.fn(() => {
      ondata?.({
        data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
      } as BlobEvent);
      onstop?.();
    });

    class FakeRecorder {
      state = "recording";
      mimeType = "audio/webm";
      stream = stream;
      start = vi.fn();
      stop = recorderStop;
      requestData = vi.fn();
      set ondataavailable(fn: ((ev: BlobEvent) => void) | null) {
        ondata = fn;
      }
      set onerror(_fn: unknown) {}
      set onstop(fn: (() => void) | null) {
        onstop = fn;
      }
      static isTypeSupported = (m: string) => m === "audio/webm";
    }

    const capture = createPttCapture({
      mediaDevices: { getUserMedia } as unknown as MediaDevices,
      MediaRecorderImpl: FakeRecorder as unknown as typeof MediaRecorder,
      preferredMimeType: "audio/webm",
    });

    await capture.start();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ channelCount: 1 }),
      video: false,
    });
    const result = await capture.stop();
    expect(result).toMatchObject({ status: "blob" });
    if (result.status === "blob") {
      expect(result.blob.type).toBe("audio/webm");
      expect(result.blob.size).toBe(3);
    }
    expect(stop).toHaveBeenCalled();
  });

  it("maps permission errors and always releases tracks on cancel", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    const capture = createPttCapture({
      mediaDevices: { getUserMedia } as unknown as MediaDevices,
      MediaRecorderImpl: class {
        static isTypeSupported = () => true;
      } as unknown as typeof MediaRecorder,
    });
    await expect(capture.start()).rejects.toMatchObject({ code: "permission_denied" });

    const { stream, stop } = mockStream();
    const okGet = vi.fn(async () => stream);
    let onstop: (() => void) | null = null;
    class FakeRecorder {
      state = "recording";
      mimeType = "audio/webm";
      stream = stream;
      start = vi.fn();
      stop = vi.fn(() => onstop?.());
      requestData = vi.fn();
      set ondataavailable(_fn: unknown) {}
      set onerror(_fn: unknown) {}
      set onstop(fn: (() => void) | null) {
        onstop = fn;
      }
      static isTypeSupported = () => true;
    }
    const c2 = createPttCapture({
      mediaDevices: { getUserMedia: okGet } as unknown as MediaDevices,
      MediaRecorderImpl: FakeRecorder as unknown as typeof MediaRecorder,
      preferredMimeType: "audio/webm",
    });
    await c2.start();
    c2.cancel();
    expect(stop).toHaveBeenCalled();
  });

  it("rejects empty recordings", async () => {
    const { stream } = mockStream();
    let onstop: (() => void) | null = null;
    class FakeRecorder {
      state = "recording";
      mimeType = "audio/webm";
      stream = stream;
      start = vi.fn();
      stop = vi.fn(() => onstop?.());
      requestData = vi.fn();
      set ondataavailable(_fn: unknown) {}
      set onerror(_fn: unknown) {}
      set onstop(fn: (() => void) | null) {
        onstop = fn;
      }
      static isTypeSupported = () => true;
    }
    const capture = createPttCapture({
      mediaDevices: { getUserMedia: async () => stream } as unknown as MediaDevices,
      MediaRecorderImpl: FakeRecorder as unknown as typeof MediaRecorder,
      preferredMimeType: "audio/webm",
    });
    await capture.start();
    await expect(capture.stop()).resolves.toEqual({ status: "empty" });
  });
});
