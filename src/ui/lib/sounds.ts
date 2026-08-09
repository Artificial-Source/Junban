/**
 * Short oscillator sound effects. AudioContext construction is deferred so
 * jsdom and visual fixtures never claim playback unless explicitly invoked.
 */
import type { SoundEvent } from "./soundPolicy";
import { soundGain } from "./soundPolicy";

export type { SoundEvent } from "./soundPolicy";

// Musical note frequencies (Hz)
const NOTE_C5 = 523.25;
const NOTE_E4 = 329.63;
const NOTE_A4 = 440;
const NOTE_D5 = 587.33;
const NOTE_G5 = 783.99;

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) {
    audioCtx = new Ctx();
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
  scheduleNote(ctx, NOTE_C5, now, 0.13, volume, "sine");
  scheduleNote(ctx, NOTE_G5, now + 0.13, 0.13, volume, "sine");
}

function playCreate(ctx: AudioContext, volume: number) {
  const now = ctx.currentTime;
  scheduleNote(ctx, NOTE_A4, now, 0.1, volume, "triangle");
}

function playDelete(ctx: AudioContext, volume: number) {
  const now = ctx.currentTime;
  scheduleNote(ctx, NOTE_A4, now, 0.115, volume, "sine");
  scheduleNote(ctx, NOTE_E4, now + 0.115, 0.115, volume, "sine");
}

function playReminder(ctx: AudioContext, volume: number) {
  const now = ctx.currentTime;
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

/**
 * Play a sound event at the given volume percent (0..100).
 * Returns whether audio was scheduled (not whether the OS emitted samples).
 */
export async function playSound(event: SoundEvent, volumePercent: number): Promise<boolean> {
  const volume = soundGain(volumePercent);
  if (volume <= 0) return false;
  try {
    const ctx = getAudioContext();
    if (!ctx) return false;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    if (ctx.state !== "running") return false;
    SOUND_MAP[event](ctx, Math.min(volume, 1));
    return true;
  } catch {
    return false;
  }
}

export async function previewSound(event: SoundEvent, volumePercent: number): Promise<boolean> {
  return playSound(event, volumePercent);
}

/** Exposed for testing only. */
export function _resetAudioContext(): void {
  audioCtx = null;
}
