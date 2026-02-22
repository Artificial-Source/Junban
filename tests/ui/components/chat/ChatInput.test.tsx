import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Send: (props: any) => <svg data-testid="send-icon" {...props} />,
  Phone: (props: any) => <svg data-testid="phone-icon" {...props} />,
}));

vi.mock("../../../../src/ui/components/chat/VoiceButton.js", () => ({
  VoiceButton: () => <button data-testid="voice-button">Voice</button>,
}));

import { ChatInput } from "../../../../src/ui/components/chat/ChatInput.js";

const defaultVoice = {
  sttProvider: null,
  ttsProvider: null,
  isSpeaking: false,
  speak: vi.fn(),
  cancelSpeech: vi.fn(),
  transcribeAudio: vi.fn(),
  settings: { autoSend: false, voiceMode: "off", ttsEnabled: false },
  updateSettings: vi.fn(),
  registry: { listSTT: vi.fn().mockReturnValue([]), listTTS: vi.fn().mockReturnValue([]) },
  ttsVoices: [],
  ttsModels: [],
} as any;

describe("ChatInput", () => {
  const defaultProps = {
    onSubmit: vi.fn(),
    isStreaming: false,
    mode: "panel" as const,
    voice: defaultVoice,
    ttsAvailable: false,
    onVoiceResult: vi.fn(),
    onStartCall: vi.fn(),
    showCallButton: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders input field in panel mode", () => {
    render(<ChatInput {...defaultProps} />);
    expect(screen.getByPlaceholderText("Ask about your tasks...")).toBeDefined();
  });

  it("renders input field in view mode", () => {
    render(<ChatInput {...defaultProps} mode="view" />);
    expect(screen.getByPlaceholderText("Ask anything...")).toBeDefined();
  });

  it("submits on Enter with non-empty text", () => {
    render(<ChatInput {...defaultProps} />);
    const input = screen.getByPlaceholderText("Ask about your tasks...");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(input.closest("form")!);
    expect(defaultProps.onSubmit).toHaveBeenCalledWith("hello");
  });

  it("does not submit empty text", () => {
    render(<ChatInput {...defaultProps} />);
    const input = screen.getByPlaceholderText("Ask about your tasks...");
    fireEvent.submit(input.closest("form")!);
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit whitespace-only text", () => {
    render(<ChatInput {...defaultProps} />);
    const input = screen.getByPlaceholderText("Ask about your tasks...");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit when streaming", () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />);
    const input = screen.getByPlaceholderText("Ask about your tasks...");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(input.closest("form")!);
    expect(defaultProps.onSubmit).not.toHaveBeenCalled();
  });

  it("clears input after submit", () => {
    render(<ChatInput {...defaultProps} />);
    const input = screen.getByPlaceholderText("Ask about your tasks...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(input.closest("form")!);
    expect(input.value).toBe("");
  });

  it("shows call button when showCallButton is true", () => {
    render(<ChatInput {...defaultProps} showCallButton={true} />);
    expect(screen.getByTitle("Start voice call")).toBeDefined();
  });

  it("hides call button when showCallButton is false", () => {
    render(<ChatInput {...defaultProps} showCallButton={false} />);
    expect(screen.queryByTitle("Start voice call")).toBeNull();
  });

  it("submit button is disabled when input is empty", () => {
    render(<ChatInput {...defaultProps} />);
    const _submitButton = screen.getByRole("button", { name: "" }); // send button has no text
    // The submit button should be disabled (via disabled prop)
    const buttons = screen.getAllByRole("button");
    const sendButton = buttons.find((b) => b.getAttribute("type") === "submit");
    expect(sendButton?.hasAttribute("disabled")).toBe(true);
  });
});
