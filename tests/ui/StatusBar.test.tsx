import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "../../src/ui/components/StatusBar.js";

// Mock the PluginContext
const mockUsePluginContext = vi.fn();
vi.mock("../../src/ui/context/PluginContext.js", () => ({
  usePluginContext: () => mockUsePluginContext(),
}));

describe("StatusBar", () => {
  it("renders nothing when no status bar items", () => {
    mockUsePluginContext.mockReturnValue({ statusBarItems: [] });
    const { container } = render(<StatusBar />);
    expect(container.firstChild).toBeNull();
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
});
