import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Mic: (props: any) => <svg data-testid="mic-icon" {...props} />,
  RefreshCw: (props: any) => <svg data-testid="refresh-icon" {...props} />,
  AlertCircle: (props: any) => <svg data-testid="alert-icon" {...props} />,
  CheckCircle2: (props: any) => <svg data-testid="check-icon" {...props} />,
  Download: (props: any) => <svg data-testid="download-icon" {...props} />,
  Loader2: (props: any) => <svg data-testid="loader-icon" {...props} />,
  Play: (props: any) => <svg data-testid="play-icon" {...props} />,
  Trash2: (props: any) => <svg data-testid="trash-icon" {...props} />,
}));

vi.mock("../../../src/ui/context/VoiceContext.js", () => ({
  VoiceProvider: ({ children }: any) => children,
  useVoiceContext: () => ({
    settings: {
      sttProviderId: "browser-stt",
      ttsProviderId: "browser-tts",
      ttsEnabled: false,
      ttsVoice: "",
      ttsModel: "",
      voiceMode: "off",
      autoSend: false,
      microphoneId: "",
      smartEndpoint: false,
      gracePeriodMs: 1500,
      groqApiKey: "",
      inworldApiKey: "",
    },
    updateSettings: vi.fn(),
    registry: {
      listSTT: () => [
        { id: "browser-stt", name: "Browser Speech Recognition", needsApiKey: false },
      ],
      listTTS: () => [{ id: "browser-tts", name: "Browser Speech Synthesis", needsApiKey: false }],
    },
    ttsVoices: [],
    ttsModels: [],
    sttProvider: null,
    ttsProvider: null,
    isSpeaking: false,
    speak: vi.fn(),
    cancelSpeech: vi.fn(),
    transcribeAudio: vi.fn(),
    localProvidersLoaded: true,
    ensureLocalProvidersLoaded: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../../src/ai/voice/audio-utils.js", () => ({
  enumerateMicrophones: vi.fn().mockResolvedValue([]),
  triggerMicPermissionPrompt: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../src/ai/voice/registry.js", () => ({}));
vi.mock("../../../src/ai/voice/adapters/whisper-local-stt.js", () => ({}));

import { VoiceTab } from "../../../src/ui/views/settings/VoiceTab.js";

describe("VoiceTab", () => {
  it("renders Voice heading", () => {
    render(<VoiceTab />);
    expect(screen.getByText("Voice")).toBeDefined();
  });

  it("renders STT provider selector", () => {
    render(<VoiceTab />);
    expect(screen.getByText("Speech-to-Text")).toBeDefined();
    expect(screen.getByText("STT Provider")).toBeDefined();
  });

  it("renders TTS provider selector", () => {
    render(<VoiceTab />);
    expect(screen.getByText("Text-to-Speech")).toBeDefined();
    expect(screen.getByText("TTS Provider")).toBeDefined();
  });

  it("renders interaction mode radio buttons", () => {
    render(<VoiceTab />);
    expect(screen.getByText("Interaction Mode")).toBeDefined();
    expect(screen.getByText("Off")).toBeDefined();
    expect(screen.getByText("Push-to-Talk")).toBeDefined();
    expect(screen.getByText("VAD (Hands-free)")).toBeDefined();
  });

  it("renders TTS enabled checkbox", () => {
    render(<VoiceTab />);
    expect(screen.getByText("Read AI responses aloud")).toBeDefined();
  });

  it("renders auto-send checkbox", () => {
    render(<VoiceTab />);
    expect(screen.getByText("Auto-send transcribed text to AI")).toBeDefined();
  });

  it("renders Microphone section", () => {
    render(<VoiceTab />);
    expect(screen.getByText("Microphone")).toBeDefined();
  });

  it("renders STT provider options", () => {
    render(<VoiceTab />);
    expect(screen.getByText("Browser Speech Recognition")).toBeDefined();
  });

  it("renders TTS provider options", () => {
    render(<VoiceTab />);
    expect(screen.getByText("Browser Speech Synthesis")).toBeDefined();
  });
});
