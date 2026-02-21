import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VoiceCallOverlay } from "../../../src/ui/components/VoiceCallOverlay.js";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  PhoneOff: ({ size: _size, ...props }: any) => <svg data-testid="phone-off-icon" {...props} />,
}));

describe("VoiceCallOverlay", () => {
  it("renders listening state label", () => {
    render(<VoiceCallOverlay callState="listening" callDuration={0} onEndCall={() => {}} />);
    expect(screen.getByTestId("call-state-label").textContent).toBe("Listening...");
  });

  it("renders processing state label", () => {
    render(<VoiceCallOverlay callState="processing" callDuration={0} onEndCall={() => {}} />);
    expect(screen.getByTestId("call-state-label").textContent).toBe("Thinking...");
  });

  it("renders speaking state label", () => {
    render(<VoiceCallOverlay callState="speaking" callDuration={0} onEndCall={() => {}} />);
    expect(screen.getByTestId("call-state-label").textContent).toBe("Speaking...");
  });

  it("renders greeting state label", () => {
    render(<VoiceCallOverlay callState="greeting" callDuration={0} onEndCall={() => {}} />);
    expect(screen.getByTestId("call-state-label").textContent).toBe("Starting...");
  });

  it("displays formatted duration", () => {
    render(<VoiceCallOverlay callState="listening" callDuration={125} onEndCall={() => {}} />);
    expect(screen.getByTestId("call-duration").textContent).toBe("2:05");
  });

  it("End Call button calls onEndCall", () => {
    const onEndCall = vi.fn();
    render(<VoiceCallOverlay callState="listening" callDuration={0} onEndCall={onEndCall} />);
    fireEvent.click(screen.getByTestId("end-call-button"));
    expect(onEndCall).toHaveBeenCalledTimes(1);
  });
});
