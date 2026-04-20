import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockGetRemoteSessionStatus = vi.fn();
const mockClaimRemoteSession = vi.fn();
const mockLoginRemoteSession = vi.fn();

vi.mock("lucide-react", () => ({
  Globe: (props: any) => <svg data-testid="globe-icon" {...props} />,
  Loader2: (props: any) => <svg data-testid="loader-icon" {...props} />,
  Lock: (props: any) => <svg data-testid="lock-icon" {...props} />,
}));

vi.mock("../../../src/ui/api/desktop-server.js", () => ({
  getRemoteSessionStatus: (...args: any[]) => mockGetRemoteSessionStatus(...args),
  claimRemoteSession: (...args: any[]) => mockClaimRemoteSession(...args),
  loginRemoteSession: (...args: any[]) => mockLoginRemoteSession(...args),
}));

vi.mock("../../../src/utils/runtime.js", () => ({
  isRemoteDesktopRuntime: () => true,
}));

import { RemoteAccessGate } from "../../../src/ui/components/RemoteAccessGate.js";

describe("RemoteAccessGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoginRemoteSession.mockResolvedValue({
      authorized: true,
      requiresPassword: true,
      sessionLocked: false,
    });
  });

  it("does not auto-claim passwordless sessions on status load", async () => {
    mockGetRemoteSessionStatus.mockResolvedValue({
      authorized: false,
      requiresPassword: false,
      sessionLocked: false,
    });

    render(
      <RemoteAccessGate>
        <div>App content</div>
      </RemoteAccessGate>,
    );

    await waitFor(() => {
      expect(screen.getByText("Remote Access")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(mockClaimRemoteSession).not.toHaveBeenCalled();
  });

  it("claims a passwordless session only after the explicit action", async () => {
    mockGetRemoteSessionStatus.mockResolvedValue({
      authorized: false,
      requiresPassword: false,
      sessionLocked: false,
    });
    mockClaimRemoteSession.mockResolvedValue({
      authorized: true,
      requiresPassword: false,
      sessionLocked: false,
    });

    render(
      <RemoteAccessGate>
        <div>App content</div>
      </RemoteAccessGate>,
    );

    const connectButton = await screen.findByRole("button", { name: "Connect" });
    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(mockClaimRemoteSession).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText("App content")).toBeInTheDocument();
    });
  });

  it("shows the lock message when another remote session already owns access", async () => {
    mockGetRemoteSessionStatus.mockResolvedValue({
      authorized: false,
      requiresPassword: false,
      sessionLocked: true,
    });

    render(
      <RemoteAccessGate>
        <div>App content</div>
      </RemoteAccessGate>,
    );

    expect(
      await screen.findByText(/Another remote browser session is already connected/i),
    ).toBeInTheDocument();
  });

  it("announces unlock errors in a persistent alert region", async () => {
    mockGetRemoteSessionStatus.mockResolvedValue({
      authorized: false,
      requiresPassword: true,
      sessionLocked: false,
    });
    mockLoginRemoteSession.mockRejectedValue(new Error("Invalid password"));

    render(
      <RemoteAccessGate>
        <div>App content</div>
      </RemoteAccessGate>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("");

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "bad-pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => {
      expect(alert).toHaveTextContent("Invalid password");
    });
  });

  it("announces connect errors in a persistent alert region", async () => {
    mockGetRemoteSessionStatus.mockResolvedValue({
      authorized: false,
      requiresPassword: false,
      sessionLocked: false,
    });
    mockClaimRemoteSession.mockRejectedValue(new Error("Could not connect this browser."));

    render(
      <RemoteAccessGate>
        <div>App content</div>
      </RemoteAccessGate>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("");

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(alert).toHaveTextContent("Could not connect this browser.");
    });
  });
});
