import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StatusBar } from "../../src/ui/components/StatusBar.js";

// Mock the PluginContext
const mockUsePluginContext = vi.fn();
vi.mock("../../src/ui/context/PluginContext.js", () => ({
  usePluginContext: () => mockUsePluginContext(),
}));

// Mock the useDirectServices hook
const mockUseDirectServices = vi.fn();
vi.mock("../../src/ui/api/helpers.js", () => ({
  useDirectServices: () => mockUseDirectServices(),
  BASE: "http://localhost:3000",
}));

describe("StatusBar", () => {
  beforeEach(() => {
    mockUseDirectServices.mockReturnValue(true);
  });

  it("renders empty state when no status bar items", () => {
    mockUsePluginContext.mockReturnValue({ statusBarItems: [] });
    const { container } = render(<StatusBar />);
    // Always renders the bar for consistent layout; content is invisible
    expect(container.firstChild).not.toBeNull();
  });

  it("renders status bar items with icon and text", () => {
    mockUsePluginContext.mockReturnValue({
      statusBarItems: [
        { id: "timer", text: "25:00", icon: "\uD83C\uDF45" },
        { id: "tasks", text: "5 pending", icon: "\uD83D\uDCCB" },
      ],
    });

    render(<StatusBar />);

    expect(screen.getByText("25:00")).toBeDefined();
    expect(screen.getByText("\uD83C\uDF45")).toBeDefined();
    expect(screen.getByText("5 pending")).toBeDefined();
    expect(screen.getByText("\uD83D\uDCCB")).toBeDefined();
  });

  it("renders multiple items separated", () => {
    mockUsePluginContext.mockReturnValue({
      statusBarItems: [
        { id: "a", text: "Item A", icon: "A" },
        { id: "b", text: "Item B", icon: "B" },
      ],
    });

    render(<StatusBar />);

    expect(screen.getByText("Item A")).toBeDefined();
    expect(screen.getByText("Item B")).toBeDefined();
  });

  it("disables plugin status bar items when mutations are blocked", () => {
    const mockClick = vi.fn();
    mockUsePluginContext.mockReturnValue({
      statusBarItems: [
        { id: "action", text: "Click Me", icon: "\uD83D\uDC46", onClick: mockClick },
      ],
    });

    render(<StatusBar mutationsBlocked={true} />);

    // When mutations are blocked, items should not be clickable (no role=button)
    // and should have opacity-50 class for visual feedback
    // The text is inside a span, get its parent container
    const textSpan = screen.getByText("Click Me");
    const item = textSpan.parentElement; // The outer container span
    expect(item).toHaveClass("opacity-50");
    expect(item).not.toHaveAttribute("role", "button");

    // Clicking should not trigger the handler (no onClick handler attached)
    fireEvent.click(item!);
    expect(mockClick).not.toHaveBeenCalled();
  });

  it("allows clicking plugin status bar items when mutations are not blocked", () => {
    const mockClick = vi.fn();
    mockUsePluginContext.mockReturnValue({
      statusBarItems: [
        { id: "action", text: "Click Me", icon: "\uD83D\uDC46", onClick: mockClick },
      ],
    });

    render(<StatusBar mutationsBlocked={false} />);

    const textSpan = screen.getByText("Click Me");
    const item = textSpan.parentElement; // The outer container span
    expect(item).toHaveAttribute("role", "button");
    expect(item).not.toHaveClass("opacity-50");
    expect(item).not.toHaveAttribute("aria-disabled", "true");

    // Clicking should trigger the handler
    fireEvent.click(item!);
    expect(mockClick).toHaveBeenCalled();
  });
});
