/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { createResourceBag, releaseVoiceResources } from "./resources";

describe("voice resource cleanup", () => {
  it("is idempotent and stops tracks/recognition/urls/contexts", () => {
    const bag = createResourceBag();
    const abort = vi.fn();
    const recognitionAbort = vi.fn();
    const recorderCancel = vi.fn();
    const vadDestroy = vi.fn(async () => undefined);
    const trackStop = vi.fn();
    const pause = vi.fn();
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const close = vi.fn(async () => undefined);
    const remove = vi.fn();
    const cloudStop = vi.fn();
    const ttsCancel = vi.fn();

    bag.abortControllers.push({ abort } as unknown as AbortController);
    bag.recognition = { abort: recognitionAbort } as never;
    bag.recorder = { cancel: recorderCancel } as never;
    bag.vad = { destroy: vadDestroy } as never;
    bag.mediaStreams.push({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
    bag.audioElements.push({
      pause,
      removeAttribute: vi.fn(),
      load: vi.fn(),
    } as unknown as HTMLAudioElement);
    bag.objectUrls.push("blob:x");
    bag.pcmChunks.push(new Float32Array([1]));
    bag.blobChunks.push(new Blob());
    bag.audioContexts.push({ close } as unknown as AudioContext);
    bag.removeListeners.push(remove);
    bag.cloudPlaybackStop = cloudStop;
    bag.browserTtsCancel = ttsCancel;

    releaseVoiceResources(bag);
    releaseVoiceResources(bag);

    expect(abort).toHaveBeenCalledTimes(1);
    expect(recognitionAbort).toHaveBeenCalledTimes(1);
    expect(recorderCancel).toHaveBeenCalledTimes(1);
    expect(vadDestroy).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:x");
    expect(close).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    expect(cloudStop).toHaveBeenCalled();
    expect(ttsCancel).toHaveBeenCalled();
    expect(bag.pcmChunks).toHaveLength(0);
    expect(bag.blobChunks).toHaveLength(0);
  });
});
