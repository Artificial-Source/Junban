/**
 * Pure presentation mapping for controller result (including fixtures).
 */

import { isBrowserSttAvailable } from "./browser-stt";
import { isPermissionVoiceError, voiceError } from "./speech-errors";
import {
  BROWSER_STT_PRIVACY_NOTE,
  MICROPHONE_PERMISSION_GUIDANCE,
  type ConfirmedVoiceSettings,
  type VoiceError,
  type VoiceFixture,
  type VoicePhase,
} from "./types";
import {
  phaseToButtonState,
  phaseToCallState,
  resolveSttReady,
  resolveTtsAvailable,
} from "./voice-capabilities";
import type { UseVoiceControllerResult } from "./controller-types";
import type { LocalSttAdapter, LocalTtsAdapter } from "./types";

export type PresentationInput = {
  settings: ConfirmedVoiceSettings;
  enabled: boolean;
  fixture: VoiceFixture | null;
  phase: VoicePhase;
  error: VoiceError | null;
  isCallActive: boolean;
  callDuration: number;
  isInGracePeriod: boolean;
  gracePeriodProgress: number;
  localStt: LocalSttAdapter | null;
  localTts: LocalTtsAdapter | null;
  actions: Pick<
    UseVoiceControllerResult,
    "togglePushToTalk" | "startCall" | "endCall" | "stop" | "retryRecognition" | "dismissError"
  >;
};

export function mapControllerPresentation(input: PresentationInput): UseVoiceControllerResult {
  const { settings, fixture, actions } = input;
  const browserSttAvailable = fixture ? true : isBrowserSttAvailable();
  const ttsAvailable = resolveTtsAvailable(settings, input.localTts, Boolean(fixture));
  const sttReady = resolveSttReady(settings, input.localStt, Boolean(fixture));

  const showPttButton =
    input.enabled && !fixture?.hidePttButton && settings.voice_mode === "push_to_talk" && sttReady;
  const showCallButton =
    input.enabled && !fixture?.hideCallButton && sttReady && ttsAvailable && !fixture?.callActive;
  const privacyNote = settings.stt_provider === "browser" ? BROWSER_STT_PRIVACY_NOTE : null;

  const fixturePhase = fixture?.callActive
    ? fixture.callState === "processing"
      ? "thinking"
      : fixture.callState === "greeting"
        ? "arming"
        : (fixture.callState ?? "listening")
    : input.phase;

  const effectivePhase = fixture ? (fixturePhase as VoicePhase) : input.phase;
  const effectiveError =
    fixture?.buttonPermissionError || fixture?.recognitionError
      ? voiceError(
          "permission_denied",
          fixture.buttonPermissionError ??
            fixture.recognitionError ??
            MICROPHONE_PERMISSION_GUIDANCE,
        )
      : input.error;
  const buttonState = fixture?.buttonState
    ? fixture.buttonState
    : phaseToButtonState(effectivePhase, effectiveError);
  const callState = fixture?.callActive
    ? (fixture.callState ?? "listening")
    : phaseToCallState(effectivePhase);

  return {
    phase: effectivePhase,
    error: effectiveError,
    isCallActive: fixture?.callActive ?? input.isCallActive,
    callState: fixture?.callActive ? (fixture.callState ?? "listening") : callState,
    callDuration: fixture?.callDuration ?? input.callDuration,
    isInGracePeriod: fixture?.isInGracePeriod ?? input.isInGracePeriod,
    gracePeriodProgress: fixture?.gracePeriodProgress ?? input.gracePeriodProgress,
    buttonState,
    showPttButton: fixture
      ? !fixture.hidePttButton && settings.voice_mode === "push_to_talk"
      : showPttButton,
    showCallButton: fixture ? !fixture.hideCallButton && !fixture.callActive : showCallButton,
    ttsAvailable,
    browserSttAvailable,
    privacyNote,
    recognitionError:
      fixture?.recognitionError ??
      (isPermissionVoiceError(effectiveError) ? (effectiveError?.message ?? null) : null),
    ...actions,
  };
}

export function resolveCapabilityFlags(
  settings: ConfirmedVoiceSettings,
  localStt: LocalSttAdapter | null,
  localTts: LocalTtsAdapter | null,
  fixture: VoiceFixture | null,
): { browserSttAvailable: boolean; ttsAvailable: boolean; sttReady: boolean } {
  const browserSttAvailable = fixture ? true : isBrowserSttAvailable();
  return {
    browserSttAvailable,
    ttsAvailable: resolveTtsAvailable(settings, localTts, Boolean(fixture)),
    sttReady: resolveSttReady(settings, localStt, Boolean(fixture)),
  };
}
