import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { playSound, previewSound, _resetAudioContext } from "../../src/utils/sounds.js";

let mockState: string;
let mockCurrentTime: number;
let createdOscillators: any[];
let createdGains: any[];
let mockResume: ReturnType<typeof vi.fn>;
let constructorSpy: ReturnType<typeof vi.fn>;

function installMockAudioContext() {
  mockState = "running";
  mockCurrentTime = 0;
  createdOscillators = [];
  createdGains = [];
  mockResume = vi.fn().mockImplementation(function () {
    mockState = "running";
    return Promise.resolve();
  });
  constructorSpy = vi.fn();

  (globalThis as any).AudioContext = class {
    state = mockState;
    currentTime = mockCurrentTime;
    destination = {};
    resume = mockResume;

    constructor() {
      constructorSpy();
      // Use getters so state is read dynamically
      Object.defineProperty(this, "state", { get: () => mockState });
      Object.defineProperty(this, "currentTime", { get: () => mockCurrentTime });
    }

    createOscillator() {
      const osc = {
        type: "sine",
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      createdOscillators.push(osc);
      return osc;
    }

    createGain() {
      const g = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      };
      createdGains.push(g);
      return g;
    }
  };
}

describe("sounds", () => {
  beforeEach(() => {
    _resetAudioContext();
    installMockAudioContext();
  });

  afterEach(() => {
    delete (globalThis as any).AudioContext;
    delete (globalThis as any).webkitAudioContext;
  });

  it("creates AudioContext on first playSound call", async () => {
    await playSound("create", 0.5);
    expect(constructorSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses AudioContext across calls", async () => {
    await playSound("create", 0.5);
    await playSound("complete", 0.5);
    expect(constructorSpy).toHaveBeenCalledTimes(1);
  });

  it("short-circuits when volume is 0", async () => {
    await playSound("create", 0);
    expect(constructorSpy).not.toHaveBeenCalled();
    expect(createdOscillators).toHaveLength(0);
  });

  it("resumes suspended context", async () => {
    mockState = "suspended";
    await playSound("create", 0.5);
    expect(mockResume).toHaveBeenCalled();
  });

  it("uses the WebKit-prefixed AudioContext fallback", async () => {
    const audioContextConstructor = (globalThis as any).AudioContext;
    delete (globalThis as any).AudioContext;
    (globalThis as any).webkitAudioContext = audioContextConstructor;

    await playSound("create", 0.5);

    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(createdOscillators).toHaveLength(1);
  });

  it("reports blocked audio when the context stays suspended", async () => {
    mockState = "suspended";
    mockResume.mockResolvedValueOnce(undefined);

    await expect(playSound("create", 0.5)).rejects.toThrow("Audio output is blocked");
  });

  it("does not call resume when context is running", async () => {
    mockState = "running";
    await playSound("create", 0.5);
    expect(mockResume).not.toHaveBeenCalled();
  });

  it("complete sound creates 2 oscillators (C5 → G5)", async () => {
    await playSound("complete", 0.7);
    expect(createdOscillators).toHaveLength(2);
    expect(createdOscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(
      523.25,
      expect.any(Number),
    );
    expect(createdOscillators[1].frequency.setValueAtTime).toHaveBeenCalledWith(
      783.99,
      expect.any(Number),
    );
  });

  it("create sound creates 1 oscillator (A4 triangle)", async () => {
    await playSound("create", 0.7);
    expect(createdOscillators).toHaveLength(1);
    expect(createdOscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(
      440,
      expect.any(Number),
    );
    expect(createdOscillators[0].type).toBe("triangle");
  });

  it("delete sound creates 2 oscillators (A4 → E4)", async () => {
    await playSound("delete", 0.7);
    expect(createdOscillators).toHaveLength(2);
    expect(createdOscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(
      440,
      expect.any(Number),
    );
    expect(createdOscillators[1].frequency.setValueAtTime).toHaveBeenCalledWith(
      329.63,
      expect.any(Number),
    );
  });

  it("reminder sound creates 4 oscillators (D5+G5 x2)", async () => {
    await playSound("reminder", 0.7);
    expect(createdOscillators).toHaveLength(4);
    expect(createdOscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(
      587.33,
      expect.any(Number),
    );
    expect(createdOscillators[1].frequency.setValueAtTime).toHaveBeenCalledWith(
      783.99,
      expect.any(Number),
    );
  });

  it("clamps volume to 1", async () => {
    await playSound("create", 1.5);
    expect(createdGains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      1,
      expect.any(Number),
    );
  });

  it("previewSound delegates to playSound", async () => {
    await previewSound("complete", 0.5);
    expect(createdOscillators).toHaveLength(2);
  });

  it("gain nodes connect to destination", async () => {
    await playSound("create", 0.5);
    expect(createdGains[0].connect).toHaveBeenCalled();
  });
});
