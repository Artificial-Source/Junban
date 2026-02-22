import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  RecurrencePicker,
  formatRecurrenceLabel,
} from "../../../src/ui/components/RecurrencePicker.js";

describe("RecurrencePicker", () => {
  const onChange = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders preset options", () => {
    render(<RecurrencePicker value={null} onChange={onChange} onClose={onClose} />);
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getByText("Daily")).toBeTruthy();
    expect(screen.getByText("Weekly")).toBeTruthy();
    expect(screen.getByText("Monthly")).toBeTruthy();
    expect(screen.getByText("Weekdays")).toBeTruthy();
  });

  it("calls onChange when a preset is clicked", () => {
    render(<RecurrencePicker value={null} onChange={onChange} onClose={onClose} />);

    fireEvent.click(screen.getByText("Daily"));
    expect(onChange).toHaveBeenCalledWith("daily");
  });

  it("calls onChange(null) when None is clicked", () => {
    render(<RecurrencePicker value="daily" onChange={onChange} onClose={onClose} />);

    fireEvent.click(screen.getByText("None"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("highlights the currently selected preset", () => {
    render(<RecurrencePicker value="weekly" onChange={onChange} onClose={onClose} />);

    const weeklyBtn = screen.getByText("Weekly");
    expect(weeklyBtn.className).toContain("bg-accent");
  });

  it("shows custom pattern section", () => {
    render(<RecurrencePicker value={null} onChange={onChange} onClose={onClose} />);
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(screen.getByText("Every")).toBeTruthy();
  });

  it("applies custom pattern when Set button is clicked", () => {
    render(<RecurrencePicker value={null} onChange={onChange} onClose={onClose} />);

    // Change number input to 3
    const numberInput = screen.getByRole("spinbutton");
    fireEvent.change(numberInput, { target: { value: "3" } });

    fireEvent.click(screen.getByText("Set"));
    expect(onChange).toHaveBeenCalledWith("every 3 days");
  });

  it("applies custom weeks pattern", () => {
    render(<RecurrencePicker value={null} onChange={onChange} onClose={onClose} />);

    const numberInput = screen.getByRole("spinbutton");
    fireEvent.change(numberInput, { target: { value: "2" } });

    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "week" } });

    fireEvent.click(screen.getByText("Set"));
    expect(onChange).toHaveBeenCalledWith("every 2 weeks");
  });

  it("handles singular day pattern (every 1 day)", () => {
    render(<RecurrencePicker value={null} onChange={onChange} onClose={onClose} />);

    const numberInput = screen.getByRole("spinbutton");
    fireEvent.change(numberInput, { target: { value: "1" } });

    fireEvent.click(screen.getByText("Set"));
    expect(onChange).toHaveBeenCalledWith("every 1 day");
  });
});

describe("formatRecurrenceLabel", () => {
  it("formats daily", () => {
    expect(formatRecurrenceLabel("daily")).toBe("Daily");
  });

  it("formats weekly", () => {
    expect(formatRecurrenceLabel("weekly")).toBe("Weekly");
  });

  it("formats monthly", () => {
    expect(formatRecurrenceLabel("monthly")).toBe("Monthly");
  });

  it("formats weekdays", () => {
    expect(formatRecurrenceLabel("weekdays")).toBe("Weekdays");
  });

  it("formats every 1 day as Daily", () => {
    expect(formatRecurrenceLabel("every 1 day")).toBe("Daily");
  });

  it("formats every 1 week as Weekly", () => {
    expect(formatRecurrenceLabel("every 1 week")).toBe("Weekly");
  });

  it("formats every N days", () => {
    expect(formatRecurrenceLabel("every 3 days")).toBe("Every 3 days");
  });

  it("formats every N weeks", () => {
    expect(formatRecurrenceLabel("every 2 weeks")).toBe("Every 2 weeks");
  });

  it("returns raw string for unrecognized patterns", () => {
    expect(formatRecurrenceLabel("custom-thing")).toBe("custom-thing");
  });
});
