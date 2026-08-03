/**
 * Browser/cloud voice surface (Wave 4f).
 *
 * Does not statically import local engine packages. VAD loads only through the
 * lazy `./local` boundary after an explicit Start Call gesture.
 */

export type {
  AcceptedAudioMime,
  ConfirmedVoiceSettings,
  LocalAdapterStatus,
  LocalSttAdapter,
  LocalTtsAdapter,
  VoiceButtonPresentationState,
  VoiceCallPresentationState,
  VoiceError,
  VoiceErrorCode,
  VoiceFixture,
  VoiceGenerations,
  VoiceMode,
  VoicePhase,
  SpeechProvider,
} from "./types";

export {
  ACCEPTED_AUDIO_MIME_TYPES,
  ACCEPTED_TTS_RESPONSE_MIME,
  BROWSER_STT_PRIVACY_NOTE,
  CLOUD_STT_FIELD_NAME,
  MAX_SPEECH_AUDIO_BYTES,
  MAX_SPEECH_TEXT_BYTES,
  MICROPHONE_PERMISSION_GUIDANCE,
  VOICE_SPEECH_PATH,
  VOICE_TRANSCRIPTIONS_PATH,
  createVoiceGenerations,
} from "./types";

export {
  isPermissionVoiceError,
  isSpeechRecognitionPermissionError,
  mapDomException,
  mapSpeechRecognitionError,
  scrubDiagnostic,
  voiceError,
} from "./speech-errors";

export {
  concatFloat32,
  filenameForAudioMime,
  float32ToWav,
  normalizeAcceptedAudioMime,
  pcmExceedsAudioCeiling,
  selectMediaRecorderMime,
  stripMimeParameters,
  validateAudioBlob,
} from "./audio-utils";

export {
  detectSpeechRecognitionCtor,
  isBrowserSttAvailable,
  startBrowserStt,
  type BrowserSttHandle,
  type BrowserSttResult,
  type StartBrowserSttOptions,
} from "./browser-stt";

export {
  cancelBrowserTts,
  isBrowserTtsAvailable,
  listBrowserTtsVoices,
  speakBrowserTts,
  whenBrowserVoicesReady,
  type BrowserTtsPlayback,
  type BrowserTtsSpeakOptions,
  type BrowserTtsVoice,
} from "./browser-tts";

export {
  createPttCapture,
  type CreatePttCaptureOptions,
  type PttCaptureHandle,
  type PttCaptureResult,
} from "./media-recorder";

export {
  createVoiceSpeech,
  createVoiceTranscription,
  playCloudAudioBlob,
  type CloudAudioPlayback,
  type CloudSpeechAudioResult,
  type CloudSpeechTransportOptions,
  type CloudTranscriptionResult,
} from "./cloud-speech";

export {
  createVadSession,
  type MicVadLike,
  type VadEngineHandleLike,
  type VadSession,
  type VadSessionCallbacks,
  type VadSessionOptions,
} from "./vad-session";

export { createResourceBag, releaseVoiceResources, type VoiceResourceBag } from "./resources";

export {
  useVoiceController,
  type UseVoiceControllerOptions,
  type UseVoiceControllerResult,
} from "./useVoiceController";

export type {
  UseVoiceControllerOptions as VoiceControllerOptions,
  UseVoiceControllerResult as VoiceControllerResult,
} from "./controller-types";

export { VoiceButton, type VoiceButtonProps } from "./VoiceButton";
export { VoiceCallOverlay, type VoiceCallOverlayProps } from "./VoiceCallOverlay";

export {
  FIXTURE_CALL_LISTENING,
  FIXTURE_CALL_PROCESSING,
  FIXTURE_CALL_RECOGNITION_ERROR,
  FIXTURE_CALL_SPEAKING,
  FIXTURE_PTT_ERROR,
  FIXTURE_PTT_LISTENING,
  FIXTURE_PTT_TRANSCRIBING,
  FIXTURE_VAD_GRACE,
} from "./fixtures";

export {
  enumerateMicrophones,
  MIC_PREFERENCES_STORAGE_KEY,
  readMicPreferences,
  requestMicrophoneAccessAndEnumerate,
  stopMediaStream,
  writeMicPreferences,
  type MicPermissionOutcome,
  type MicPreferences,
  type MicrophoneDevice,
} from "./micPreferences";

export {
  LOCAL_STT_PACKAGE_IDS,
  LOCAL_TTS_PACKAGE_IDS,
  LOCAL_VOICE_PREFERENCES_EVENT,
  LOCAL_VOICE_PREFERENCES_MAX_BYTES,
  LOCAL_VOICE_PREFERENCES_STORAGE_KEY,
  isLocalSttPackageId,
  isLocalTtsPackageId,
  parseLocalVoicePreferences,
  readLocalVoicePreferences,
  subscribeLocalVoicePreferences,
  writeLocalVoicePreferences,
  type LocalSttPackageId,
  type LocalSttPreference,
  type LocalTtsPackageId,
  type LocalTtsPreference,
  type LocalVoicePreferences,
} from "./localPreferences";

export {
  useLocalVoiceAdapters,
  type UseLocalVoiceAdaptersOptions,
  type UseLocalVoiceAdaptersResult,
} from "./useLocalVoiceAdapters";
