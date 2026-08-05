import { describe, expect, it } from "vitest";
import {
  shouldPlaySoundEvent,
  soundEventForTaskEvent,
  soundGain,
  type SoundPolicyInput,
} from "./soundPolicy";

const base = (overrides: Partial<SoundPolicyInput> = {}): SoundPolicyInput => ({
  sound_enabled: true,
  volume_percent: 70,
  task_completed_sound: true,
  task_created_sound: true,
  task_deleted_sound: true,
  reminder_sound: true,
  channels: ["in_app", "sound"],
  ...overrides,
});

describe("soundPolicy", () => {
  it("maps task committed events to sound events", () => {
    expect(soundEventForTaskEvent("task.created")).toBe("create");
    expect(soundEventForTaskEvent("task.completed")).toBe("complete");
    expect(soundEventForTaskEvent("task.deleted")).toBe("delete");
    expect(soundEventForTaskEvent("task.updated")).toBeNull();
    expect(soundEventForTaskEvent("settings.updated")).toBeNull();
  });

  it("gates on master toggle and volume", () => {
    expect(shouldPlaySoundEvent(base({ sound_enabled: false }), "create")).toBe(false);
    expect(shouldPlaySoundEvent(base({ volume_percent: 0 }), "create")).toBe(false);
    expect(shouldPlaySoundEvent(base(), "create")).toBe(true);
  });

  it("gates task events on their individual flags", () => {
    expect(shouldPlaySoundEvent(base({ task_created_sound: false }), "create")).toBe(false);
    expect(shouldPlaySoundEvent(base({ task_completed_sound: false }), "complete")).toBe(false);
    expect(shouldPlaySoundEvent(base({ task_deleted_sound: false }), "delete")).toBe(false);
    expect(shouldPlaySoundEvent(base({ task_created_sound: false }), "complete")).toBe(true);
  });

  it("requires the sound delivery channel only for reminders", () => {
    expect(
      shouldPlaySoundEvent(base({ channels: ["in_app"], reminder_sound: true }), "reminder"),
    ).toBe(false);
    expect(
      shouldPlaySoundEvent(
        base({ channels: ["in_app", "sound"], reminder_sound: false }),
        "reminder",
      ),
    ).toBe(false);
    expect(
      shouldPlaySoundEvent(
        base({ channels: ["in_app", "sound"], reminder_sound: true }),
        "reminder",
      ),
    ).toBe(true);
    // Task events do not require the sound channel.
    expect(shouldPlaySoundEvent(base({ channels: ["in_app"] }), "create")).toBe(true);
  });

  it("normalizes volume percent to oscillator gain", () => {
    expect(soundGain(70)).toBeCloseTo(0.7);
    expect(soundGain(0)).toBe(0);
    expect(soundGain(150)).toBe(1);
    expect(soundGain(Number.NaN)).toBe(0);
  });
});
