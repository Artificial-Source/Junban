import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QuickCapture } from "../../../src/ui/views/QuickCapture.js";

const mockGetDesktopRemoteServerStatus = vi.fn().mockResolvedValue({ running: false });

vi.mock("../../../src/ui/api/index.js", () => ({
  api: {
    getDesktopRemoteServerStatus: (...args: unknown[]) => mockGetDesktopRemoteServerStatus(...args),
  },
}));

// Mock isTauri — returns false by default (browser mode)
const mockIsTauri = vi.fn(() => false);
vi.mock("../../../src/utils/tauri.js", () => ({
  isTauri: () => mockIsTauri(),
}));

// Mock Tauri window API
const mockHide = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide: mockHide }),
}));

// Mock Tauri event API
const mockEmit = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...args: unknown[]) => mockEmit(...args),
}));

// Mock TaskInput
vi.mock("../../../src/ui/components/TaskInput.js", () => ({
  TaskInput: ({
    onSubmit,
    placeholder,
  }: {
    onSubmit: (v: unknown) => void;
    placeholder?: string;
  }) => (
    <input
      data-testid="task-input"
      placeholder={placeholder}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onSubmit({
            title: (e.target as HTMLInputElement).value || "test task",
            priority: null,
            tags: [],
            project: null,
            dueDate: null,
            dueTime: false,
            recurrence: null,
            estimatedMinutes: null,
            deadline: null,
            isSomeday: false,
          });
        }
      }}
    />
  ),
}));

describe("QuickCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTauri.mockReturnValue(false);
    mockGetDesktopRemoteServerStatus.mockResolvedValue({ running: false });
  });

  it("renders TaskInput with quick capture placeholder", () => {
    render(<QuickCapture />);
    expect(screen.getByTestId("task-input")).toBeDefined();
    expect(screen.getByPlaceholderText(/Quick capture/)).toBeDefined();
  });

  it("does not render sidebar or navigation", () => {
    const { container } = render(<QuickCapture />);
    expect(container.querySelector("nav")).toBeNull();
    expect(container.querySelector("[data-testid='sidebar']")).toBeNull();
  });

  it("hides on Escape key (calls getCurrentWindow().hide in Tauri)", async () => {
    mockIsTauri.mockReturnValue(true);

    render(<QuickCapture />);
    fireEvent.keyDown(document, { key: "Escape" });

    // Give async hide time to resolve
    await vi.waitFor(() => {
      expect(mockHide).toHaveBeenCalled();
    });
  });

  it("does not crash on Escape in browser mode", () => {
    mockIsTauri.mockReturnValue(false);

    render(<QuickCapture />);
    // Should not throw
    fireEvent.keyDown(document, { key: "Escape" });
    expect(mockHide).not.toHaveBeenCalled();
  });

  it("blocks submit while remote access is running", async () => {
    mockIsTauri.mockReturnValue(true);
    mockGetDesktopRemoteServerStatus.mockResolvedValue({ running: true });

    render(<QuickCapture />);
    const input = screen.getByTestId("task-input");

    fireEvent.change(input, { target: { value: "blocked task" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await vi.waitFor(() => {
      expect(
        screen.getByText(/Quick capture is unavailable while remote access is running/i),
      ).toBeInTheDocument();
    });
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockHide).not.toHaveBeenCalled();
  });
});
