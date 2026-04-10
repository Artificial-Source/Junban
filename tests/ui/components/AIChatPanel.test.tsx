import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  X: (props: any) => <svg data-testid="x-icon" {...props} />,
  Bot: (props: any) => <svg data-testid="bot-icon" {...props} />,
  Settings: (props: any) => <svg data-testid="settings-icon" {...props} />,
  Trash2: (props: any) => <svg data-testid="trash-icon" {...props} />,
}));

const mockSendMessage = vi.fn();
const mockClearChat = vi.fn();

vi.mock("../../../src/ui/context/AIContext.js", () => ({
  useAIContext: () => ({
    messages: [],
    isStreaming: false,
    isConfigured: false,
    sendMessage: (...args: any[]) => mockSendMessage(...args),
    clearChat: (...args: any[]) => mockClearChat(...args),
    restoreMessages: vi.fn(),
    retryLastMessage: vi.fn(),
    setVoiceCallMode: vi.fn(),
    editAndResend: vi.fn(),
    regenerateLastResponse: vi.fn(),
    sessions: [],
    activeSessionId: null,
    setFocusedTaskId: vi.fn(),
    createNewSession: vi.fn(),
    switchSession: vi.fn(),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
  }),
}));

vi.mock("../../../src/ui/context/VoiceContext.js", () => ({
  useVoiceContext: () => ({
    sttProvider: null,
    ttsProvider: null,
    isSpeaking: false,
    speak: vi.fn(),
    cancelSpeech: vi.fn(),
    transcribeAudio: vi.fn(),
    settings: {
      autoSend: false,
      voiceMode: "off",
      ttsEnabled: false,
      microphoneId: "",
      smartEndpoint: false,
      gracePeriodMs: 1500,
    },
    updateSettings: vi.fn(),
    registry: { listSTT: vi.fn().mockReturnValue([]), listTTS: vi.fn().mockReturnValue([]) },
    ttsVoices: [],
    ttsModels: [],
    ensureRegistryLoaded: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../../src/ui/hooks/useVAD.js", () => ({
  useVAD: () => ({
    isSupported: false,
    isListening: false,
    isInGracePeriod: false,
    gracePeriodProgress: 0,
  }),
}));

vi.mock("../../../src/ui/hooks/useVoiceCall.js", () => ({
  useVoiceCall: () => ({
    isCallActive: false,
    callState: "idle",
    callDuration: 0,
    startCall: vi.fn(),
    endCall: vi.fn(),
    vadEnabled: false,
  }),
}));

vi.mock("../../../src/ui/components/VoiceCallOverlay.js", () => ({
  VoiceCallOverlay: () => <div data-testid="voice-call-overlay" />,
}));

vi.mock("../../../src/ai/voice/adapters/browser-stt.js", () => ({
  BrowserSTTProvider: class {},
}));

vi.mock("../../../src/ui/components/chat/index.js", () => ({
  MessageBubble: ({ message }: any) => <div data-testid="message-bubble">{message.content}</div>,
  TypingIndicator: () => <div data-testid="typing-indicator" />,
  ChatInput: ({ onSubmit }: any) => (
    <form
      data-testid="chat-input"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit("test message");
      }}
    >
      <button type="submit">Send</button>
    </form>
  ),
  WelcomeScreen: () => <div data-testid="welcome-screen">Welcome</div>,
  SuggestedActions: () => null,
  ChatHistory: () => <div data-testid="chat-history" />,
}));

import { AIChatPanel } from "../../../src/ui/components/AIChatPanel.js";

describe("AIChatPanel", () => {
  const defaultProps = {
    onClose: vi.fn(),
    onOpenSettings: vi.fn(),
    onSelectTask: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows not configured state when AI is not configured", () => {
    render(<AIChatPanel {...defaultProps} />);
    expect(screen.getByText("AI Assistant")).toBeDefined();
    expect(screen.getByText(/Configure an AI provider/)).toBeDefined();
  });

  it("shows open settings button in not configured state", () => {
    render(<AIChatPanel {...defaultProps} />);
    const settingsBtn = screen.getByText("Open Settings");
    expect(settingsBtn).toBeDefined();
    fireEvent.click(settingsBtn);
    expect(defaultProps.onOpenSettings).toHaveBeenCalled();
  });

  it("shows close button in panel mode when not configured", () => {
    render(<AIChatPanel {...defaultProps} />);
    const closeBtn = screen.getByLabelText("Close AI chat");
    expect(closeBtn).toBeDefined();
    fireEvent.click(closeBtn);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("renders AI Chat heading in panel header", () => {
    render(<AIChatPanel {...defaultProps} />);
    expect(screen.getByText("AI Chat")).toBeDefined();
  });
});
