import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

vi.mock("lucide-react", () => ({
  Search: (props: any) => <svg data-testid="search-icon" {...props} />,
}));

import { CommandPalette } from "../../../src/ui/components/CommandPalette.js";

describe("CommandPalette", () => {
  const makeCommands = () => [
    { id: "nav-inbox", name: "Go to Inbox", callback: vi.fn() },
    { id: "nav-today", name: "Go to Today", callback: vi.fn() },
    { id: "nav-upcoming", name: "Go to Upcoming", callback: vi.fn() },
    { id: "theme-toggle", name: "Toggle Dark Mode", callback: vi.fn(), hotkey: "Ctrl+D" },
  ];

  let commands: ReturnType<typeof makeCommands>;
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    commands = makeCommands();
  });

  it("renders nothing when not open", () => {
    const { container } = render(
      <CommandPalette commands={commands} isOpen={false} onClose={onClose} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders dialog when open", () => {
    render(<CommandPalette commands={commands} isOpen={true} onClose={onClose} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByPlaceholderText("Type a command...")).toBeTruthy();
  });

  it("shows all commands by default", () => {
    render(<CommandPalette commands={commands} isOpen={true} onClose={onClose} />);
    expect(screen.getByText("Go to Inbox")).toBeTruthy();
    expect(screen.getByText("Go to Today")).toBeTruthy();
    expect(screen.getByText("Go to Upcoming")).toBeTruthy();
    expect(screen.getByText("Toggle Dark Mode")).toBeTruthy();
  });

  it("filters commands based on search query", () => {
    render(<CommandPalette commands={commands} isOpen={true} onClose={onClose} />);

    const input = screen.getByPlaceholderText("Type a command...");
    fireEvent.change(input, { target: { value: "inbox" } });

    expect(screen.getByText("Go to Inbox")).toBeTruthy();
    expect(screen.queryByText("Go to Today")).toBeNull();
    expect(screen.queryByText("Toggle Dark Mode")).toBeNull();
  });

  it("shows no matching commands message", () => {
    render(<CommandPalette commands={commands} isOpen={true} onClose={onClose} />);

    const input = screen.getByPlaceholderText("Type a command...");
    fireEvent.change(input, { target: { value: "zzzznonexistent" } });

    expect(screen.getByText("No matching commands")).toBeTruthy();
  });

  it("navigates with arrow keys", () => {
    render(<CommandPalette commands={commands} isOpen={true} onClose={onClose} />);

    const dialog = screen.getByRole("dialog").querySelector("div[class*='bg-surface']")!;

    // First item selected by default
    const firstOption = screen.getByText("Go to Inbox").closest("[role='option']");
    expect(firstOption?.getAttribute("aria-selected")).toBe("true");

    // Arrow down selects next
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    const secondOption = screen.getByText("Go to Today").closest("[role='option']");
    expect(secondOption?.getAttribute("aria-selected")).toBe("true");
  });

  it("executes command on Enter and closes", () => {
    render(<CommandPalette commands={commands} isOpen={true} onClose={onClose} />);

    const dialog = screen.getByRole("dialog").querySelector("div[class*='bg-surface']")!;
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(commands[0].callback).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    render(<CommandPalette commands={commands} isOpen={true} onClose={onClose} />);

    const dialog = screen.getByRole("dialog").querySelector("div[class*='bg-surface']")!;
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("closes when clicking backdrop", () => {
    render(<CommandPalette commands={commands} isOpen={true} onClose={onClose} />);

    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalled();
  });

  it("executes command on click", () => {
    render(<CommandPalette commands={commands} isOpen={true} onClose={onClose} />);

    fireEvent.click(screen.getByText("Go to Today"));
    expect(commands[1].callback).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("shows hotkey when defined", () => {
    render(<CommandPalette commands={commands} isOpen={true} onClose={onClose} />);
    expect(screen.getByText("Ctrl+D")).toBeTruthy();
  });
});
