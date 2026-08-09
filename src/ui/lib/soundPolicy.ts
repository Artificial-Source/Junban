/**
 * Pure sound gating helpers. Keep audio I/O out of this module so jsdom tests
 * can assert policy without claiming playback.
 */

export type SoundEvent = "complete" | "create" | "delete" | "reminder";

export type SoundPolicyInput = {
  sound_enabled: boolean;
  volume_percent: number;
  task_completed_sound: boolean;
  task_created_sound: boolean;
  task_deleted_sound: boolean;
  reminder_sound: boolean;
  /** Delivery channels; only reminder playback requires the `sound` channel. */
  channels: readonly string[];
};

/** Map a committed task event type to a playable sound event, if any. */
export function soundEventForTaskEvent(eventType: string): SoundEvent | null {
  switch (eventType) {
    case "task.created":
      return "create";
    case "task.completed":
      return "complete";
    case "task.deleted":
      return "delete";
    default:
      return null;
  }
}

/** Normalize a stored volume percent into a 0..1 oscillator gain. */
export function soundGain(volumePercent: number): number {
  if (!Number.isFinite(volumePercent) || volumePercent <= 0) return 0;
  return Math.min(volumePercent, 100) / 100;
}

/**
 * Whether the given sound event should play under server-confirmed settings.
 * Reminder playback additionally requires the app-wide `sound` delivery channel.
 */
export function shouldPlaySoundEvent(settings: SoundPolicyInput, event: SoundEvent): boolean {
  if (!settings.sound_enabled) return false;
  if (soundGain(settings.volume_percent) <= 0) return false;
  switch (event) {
    case "complete":
      return settings.task_completed_sound;
    case "create":
      return settings.task_created_sound;
    case "delete":
      return settings.task_deleted_sound;
    case "reminder":
      return settings.reminder_sound && settings.channels.includes("sound");
  }
}
