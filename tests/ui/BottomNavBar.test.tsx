import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BottomNavBar } from "../../src/ui/components/BottomNavBar.js";

describe("BottomNavBar", () => {
  const defaultProps = {
    currentView: "inbox",
    onNavigate: vi.fn(),
    onMenuOpen: vi.fn(),
    onOpenChat: vi.fn(),
    onOpenVoice: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders all nav items and center AI button", () => {
    render(<BottomNavBar {...defaultProps} />);
    expect(screen.getByText("Inbox")).toBeDefined();
    expect(screen.getByText("Today")).toBeDefined();
    expect(screen.getByText("Upcoming")).toBeDefined();
    expect(screen.getByText("Menu")).toBeDefined();
    expect(screen.getByLabelText("AI assistant — hold for voice")).toBeDefined();
  });

  it("calls onNavigate when a nav item is clicked", () => {
    const onNavigate = vi.fn();
    render(<BottomNavBar {...defaultProps} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText("Today"));
    expect(onNavigate).toHaveBeenCalledWith("today");

    fireEvent.click(screen.getByText("Upcoming"));
    expect(onNavigate).toHaveBeenCalledWith("upcoming");
  });

  it("calls onMenuOpen when Menu is clicked", () => {
    const onMenuOpen = vi.fn();
    render(<BottomNavBar {...defaultProps} onMenuOpen={onMenuOpen} />);

    fireEvent.click(screen.getByText("Menu"));
    expect(onMenuOpen).toHaveBeenCalledTimes(1);
  });

  it("highlights the active view", () => {
    render(<BottomNavBar {...defaultProps} currentView="today" />);
    const todayButton = screen.getByText("Today").closest("button")!;
    expect(todayButton.getAttribute("aria-current")).toBe("page");

    const inboxButton = screen.getByText("Inbox").closest("button")!;
    expect(inboxButton.getAttribute("aria-current")).toBeNull();
  });

  it("shows badge count for inbox", () => {
    render(<BottomNavBar {...defaultProps} inboxCount={5} />);
    expect(screen.getByText("5")).toBeDefined();
  });

  it("shows badge count for today", () => {
    render(<BottomNavBar {...defaultProps} todayCount={12} />);
    expect(screen.getByText("12")).toBeDefined();
  });

  it("does not show badge when count is 0", () => {
    render(<BottomNavBar {...defaultProps} inboxCount={0} todayCount={0} />);
    expect(screen.queryByText("0")).toBeNull();
  });

  it("caps badge display at 99+", () => {
    render(<BottomNavBar {...defaultProps} inboxCount={150} />);
    expect(screen.getByText("99+")).toBeDefined();
  });

  it("tap on center button calls onNavigate with ai-chat", () => {
    const onNavigate = vi.fn();
    render(<BottomNavBar {...defaultProps} onNavigate={onNavigate} />);
    const aiButton = screen.getByLabelText("AI assistant — hold for voice");

    fireEvent.pointerDown(aiButton);
    // Release before long press threshold
    vi.advanceTimersByTime(100);
    fireEvent.pointerUp(aiButton);

    expect(onNavigate).toHaveBeenCalledWith("ai-chat");
  });

  it("long press on center button calls onOpenVoice", () => {
    const onOpenVoice = vi.fn();
    const onOpenChat = vi.fn();
    render(<BottomNavBar {...defaultProps} onOpenVoice={onOpenVoice} onOpenChat={onOpenChat} />);
    const aiButton = screen.getByLabelText("AI assistant — hold for voice");

    fireEvent.pointerDown(aiButton);
    vi.advanceTimersByTime(500);
    fireEvent.pointerUp(aiButton);

    expect(onOpenVoice).toHaveBeenCalledTimes(1);
    // Should NOT also fire onOpenChat
    expect(onOpenChat).not.toHaveBeenCalled();
  });
});
