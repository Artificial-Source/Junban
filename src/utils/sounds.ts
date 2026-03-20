export type SoundEvent = "complete" | "create" | "delete" | "reminder";

// Musical note frequencies (Hz)
const NOTE_C5 = 523.25;
const NOTE_E4 = 329.63;
const NOTE_A4 = 440;
const NOTE_D5 = 587.33;
const NOTE_G5 = 783.99;

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function scheduleNote(
  ctx: AudioContext,
  frequency: number,
  startTime: number,
  duration: number,
  volume: number,
  waveType: OscillatorType,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = waveType;
  osc.frequency.setValueAtTime(frequency, startTime);
  gain.gain.setValueAtTime(volume, startTime);
  // Quick fade-out to avoid clicks
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playComplete(ctx: AudioContext, volume: number) {
  const now = ctx.currentTime;
  // C5 → G5, ascending major fifth = "success"
  scheduleNote(ctx, NOTE_C5, now, 0.13, volume, "sine");
  scheduleNote(ctx, NOTE_G5, now + 0.13, 0.13, volume, "sine");
}

function playCreate(ctx: AudioContext, volume: number) {
  const now = ctx.currentTime;
  // A4, triangle, short tick = "acknowledged"
  scheduleNote(ctx, NOTE_A4, now, 0.1, volume, "triangle");
}

function playDelete(ctx: AudioContext, volume: number) {
  const now = ctx.currentTime;
  // A4 → E4, descending fourth = "going away"
  scheduleNote(ctx, NOTE_A4, now, 0.115, volume, "sine");
  scheduleNote(ctx, NOTE_E4, now + 0.115, 0.115, volume, "sine");
}

function playReminder(ctx: AudioContext, volume: number) {
  const now = ctx.currentTime;
  // D5+G5 chord × 2 pulses = "attention"
  const pulseVol = volume * 0.7;
  scheduleNote(ctx, NOTE_D5, now, 0.12, pulseVol, "sine");
  scheduleNote(ctx, NOTE_G5, now, 0.12, pulseVol, "sine");
  scheduleNote(ctx, NOTE_D5, now + 0.21, 0.12, pulseVol, "sine");
  scheduleNote(ctx, NOTE_G5, now + 0.21, 0.12, pulseVol, "sine");
}

const SOUND_MAP: Record<SoundEvent, (ctx: AudioContext, volume: number) => void> = {
  complete: playComplete,
  create: playCreate,
  delete: playDelete,
  reminder: playReminder,
};

export async function playSound(event: SoundEvent, volume: number): Promise<void> {
  if (volume <= 0) return;
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
  SOUND_MAP[event](ctx, Math.min(volume, 1));
}

export async function previewSound(event: SoundEvent, volume: number): Promise<void> {
  return playSound(event, volume);
}

/** Exposed for testing only. */
export function _resetAudioContext(): void {
  audioCtx = null;
}
