import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

// Mock lucide-react
vi.mock("lucide-react", () => ({
  Plus: (props: any) => <svg data-testid="plus-icon" {...props} />,
  Flag: (props: any) => <svg data-testid="flag-icon" {...props} />,
  Hash: (props: any) => <svg data-testid="hash-icon" {...props} />,
  Calendar: (props: any) => <svg data-testid="calendar-icon" {...props} />,
  FolderOpen: (props: any) => <svg data-testid="folder-icon" {...props} />,
  Repeat: (props: any) => <svg data-testid="repeat-icon" {...props} />,
  Clock: (props: any) => <svg data-testid="clock-icon" {...props} />,
}));

vi.mock("../../../src/ui/components/DatePicker.js", () => ({
  DatePicker: ({ onChange }: any) => (
    <button data-testid="date-picker" onClick={() => onChange("2026-02-20T00:00:00")}>
      pick date
    </button>
  ),
}));

vi.mock("../../../src/ui/components/TagsInput.js", () => ({
  TagsInput: ({ value, onChange }: any) => (
    <button data-testid="tags-input" onClick={() => onChange([...(value ?? []), "work"])}>
      add tag
    </button>
  ),
}));

// Mock task parser — use vi.fn() so we can change behavior per test
const mockParseTask = vi.fn((input: string) => ({
  title: input,
  priority: null,
  tags: [],
  project: null,
  dueDate: null,
  dueTime: false,
  recurrence: null,
}));

vi.mock("../../../src/parser/task-parser.js", () => ({
  parseTask: (...args: any[]) => mockParseTask(...args),
}));

// Mock RecurrencePicker
vi.mock("../../../src/ui/components/RecurrencePicker.js", () => ({
  formatRecurrenceLabel: (r: string) => r,
}));

// Mock SettingsContext
vi.mock("../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: {
      default_priority: "none",
      accent_color: "#3b82f6",
      density: "default",
      font_size: "default",
      reduce_animations: "false",
      week_start: "sunday",
      date_format: "relative",
      time_format: "12h",
      confirm_delete: "true",
      start_view: "inbox",
      sound_enabled: "false",
      sound_volume: "70",
      sound_complete: "true",
      sound_create: "true",
      sound_delete: "true",
      sound_reminder: "true",
    },
    loaded: true,
    updateSetting: vi.fn(),
  }),
}));

import { TaskInput } from "../../../src/ui/components/TaskInput.js";

describe("TaskInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseTask.mockImplementation((input: string) => ({
      title: input,
      priority: null,
      tags: [],
      project: null,
      dueDate: null,
      dueTime: false,
      recurrence: null,
    }));
    cleanup();
  });

  it("calls onSubmit with parsed task on form submit", async () => {
    const onSubmit = vi.fn();
    render(<TaskInput onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/add a task/i);
    fireEvent.change(input, { target: { value: "buy milk" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ title: "buy milk", dueDate: null }),
    );
  });

  it("does not submit empty input", () => {
    const onSubmit = vi.fn();
    render(<TaskInput onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/add a task/i);
    fireEvent.submit(input.closest("form")!);

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("applies defaultDueDate when parser returns no date", async () => {
    const onSubmit = vi.fn();
    const defaultDate = new Date("2026-02-17T00:00:00");
    render(<TaskInput onSubmit={onSubmit} defaultDueDate={defaultDate} />);

    const input = screen.getByPlaceholderText(/add a task/i);
    fireEvent.change(input, { target: { value: "buy milk" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const parsed = onSubmit.mock.calls[0][0];
    expect(parsed.dueDate).toEqual(defaultDate);
  });

  it("does not override parser date with defaultDueDate", async () => {
    const parserDate = new Date("2026-03-01T00:00:00");
    // Use mockImplementation (not Once) because parseTask is called for both preview and submit
    mockParseTask.mockImplementation((input: string) => ({
      title: input,
      priority: null,
      tags: [],
      project: null,
      dueDate: parserDate,
      dueTime: false,
      recurrence: null,
    }));

    const onSubmit = vi.fn();
    const defaultDate = new Date("2026-02-17T00:00:00");
    render(<TaskInput onSubmit={onSubmit} defaultDueDate={defaultDate} />);

    const input = screen.getByPlaceholderText(/add a task/i);
    fireEvent.change(input, { target: { value: "buy milk tomorrow" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const parsed = onSubmit.mock.calls[0][0];
    expect(parsed.dueDate).toEqual(parserDate);
  });

  it("does not apply defaultDueDate when none provided", async () => {
    const onSubmit = vi.fn();
    render(<TaskInput onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/add a task/i);
    fireEvent.change(input, { target: { value: "buy milk" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const parsed = onSubmit.mock.calls[0][0];
    expect(parsed.dueDate).toBeNull();
  });

  it("clears input after successful submit", async () => {
    const onSubmit = vi.fn();
    render(<TaskInput onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/add a task/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "buy milk" } });
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });

    await waitFor(() => expect(input.value).toBe(""));
  });

  it("renders custom placeholder", () => {
    render(<TaskInput onSubmit={() => {}} placeholder="Custom placeholder" />);
    expect(screen.getByPlaceholderText("Custom placeholder")).toBeTruthy();
  });

  it("shows the metadata toolbar on focus", () => {
    render(<TaskInput onSubmit={() => {}} />);
    const input = screen.getByPlaceholderText(/add a task/i);
    fireEvent.focus(input);
    expect(screen.getByRole("button", { name: /p1/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /date/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /labels/i })).toBeTruthy();
  });

  it("submits manual toolbar priority overrides", async () => {
    const onSubmit = vi.fn();
    render(<TaskInput onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/add a task/i);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "buy milk" } });
    fireEvent.click(screen.getByRole("button", { name: /p2/i }));
    await act(async () => {
      fireEvent.submit(input.closest("form")!);
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ title: "buy milk", priority: 2 }),
    );
  });
});
