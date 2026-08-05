/**
 * Public controller option/result types (stable API surface).
 */

import type { ChatMessageView } from "../ai/message-view";
import type {
  ConfirmedVoiceSettings,
  LocalSttAdapter,
  LocalTtsAdapter,
  VoiceButtonPresentationState,
  VoiceCallPresentationState,
  VoiceError,
  VoiceFixture,
  VoicePhase,
} from "./types";

export type UseVoiceControllerOptions = {
  settings: ConfirmedVoiceSettings;
  /** Confirmed AI auto-send — voice transcripts always send during a call. */
  autoSend: boolean;
  messages: ChatMessageView[];
  isStreaming: boolean;
  activeSessionId: string | null;
  sendMessage: (text: string) => void | Promise<void>;
  /** Durable conversation cancel; invoked before physical abort on Stop. */
  stopConversation: () => void | Promise<void>;
  enabled?: boolean;
  microphoneId?: string;
  fixture?: VoiceFixture | null;
  localStt?: LocalSttAdapter | null;
  localTts?: LocalTtsAdapter | null;
};

export type UseVoiceControllerResult = {
  phase: VoicePhase;
  error: VoiceError | null;
  isCallActive: boolean;
  callState: VoiceCallPresentationState | "idle";
  callDuration: number;
  isInGracePeriod: boolean;
  gracePeriodProgress: number;
  buttonState: VoiceButtonPresentationState;
  showPttButton: boolean;
  showCallButton: boolean;
  ttsAvailable: boolean;
  browserSttAvailable: boolean;
  privacyNote: string | null;
  recognitionError: string | null;
  /** Push-to-talk toggle (start/stop). */
  togglePushToTalk: () => void;
  startCall: () => void;
  endCall: () => void;
  /** Stop generating + speech (keeps call alive when in call). */
  stop: () => void;
  retryRecognition: () => void;
  dismissError: () => void;
};
