/**
 * Explicit fixture props for immutable Phase 6 visual scenes 10–14.
 * Fixtures never touch mic, network, VAD, or audio.
 */

import type { VoiceFixture } from "./types";
import { MICROPHONE_PERMISSION_GUIDANCE } from "./types";

/** Scene 10 — PTT listening. */
export const FIXTURE_PTT_LISTENING: VoiceFixture = {
  buttonState: "listening",
  hideCallButton: true,
};

/** Scene 11 — PTT transcribing. */
export const FIXTURE_PTT_TRANSCRIBING: VoiceFixture = {
  buttonState: "transcribing",
  hideCallButton: true,
};

/** Scene 12 — PTT permission error. */
export const FIXTURE_PTT_ERROR: VoiceFixture = {
  buttonState: "error",
  buttonPermissionError: MICROPHONE_PERMISSION_GUIDANCE,
  hideCallButton: true,
};

/** Scene 13 — VAD grace period during call. */
export const FIXTURE_VAD_GRACE: VoiceFixture = {
  callActive: true,
  callState: "listening",
  callDuration: 42,
  isInGracePeriod: true,
  gracePeriodProgress: 0.55,
  hidePttButton: true,
};

/** Scene 14 — voice-call state grid cells (compose per cell). */
export const FIXTURE_CALL_LISTENING: VoiceFixture = {
  callActive: true,
  callState: "listening",
  callDuration: 12,
  hidePttButton: true,
};

export const FIXTURE_CALL_PROCESSING: VoiceFixture = {
  callActive: true,
  callState: "processing",
  callDuration: 18,
  hidePttButton: true,
};

export const FIXTURE_CALL_SPEAKING: VoiceFixture = {
  callActive: true,
  callState: "speaking",
  callDuration: 27,
  hidePttButton: true,
};

export const FIXTURE_CALL_RECOGNITION_ERROR: VoiceFixture = {
  callActive: true,
  callState: "listening",
  callDuration: 33,
  recognitionError: "Microphone access was denied. Allow microphone access, then retry.",
  hidePttButton: true,
};
