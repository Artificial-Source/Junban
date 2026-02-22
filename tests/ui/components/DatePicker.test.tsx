import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  ChevronLeft: (props: any) => <svg data-testid="chevron-left" {...props} />,
  ChevronRight: (props: any) => <svg data-testid="chevron-right" {...props} />,
}));

import { DatePicker } from "../../../src/ui/components/DatePicker.js";

describe("DatePicker", () => {
  const onChange = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders calendar grid with day headers", () => {
    render(<DatePicker value={null} onChange={onChange} onClose={onClose} />);
    expect(screen.getByText("Su")).toBeTruthy();
    expect(screen.getByText("Mo")).toBeTruthy();
    expect(screen.getByText("Tu")).toBeTruthy();
    expect(screen.getByText("We")).toBeTruthy();
    expect(screen.getByText("Th")).toBeTruthy();
    expect(screen.getByText("Fr")).toBeTruthy();
    expect(screen.getByText("Sa")).toBeTruthy();
  });

  it("renders day numbers in the grid", () => {
    render(<DatePicker value={null} onChange={onChange} onClose={onClose} />);
    // Should have day numbers 1-28 at minimum
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("15")).toBeTruthy();
  });

  it("calls onChange when a date is selected", () => {
    render(<DatePicker value={null} onChange={onChange} onClose={onClose} />);

    fireEvent.click(screen.getByText("15"));
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("T00:00:00"));
  });

  it("renders quick options: Today, Tomorrow, Next week, No date", () => {
    render(<DatePicker value={null} onChange={onChange} onClose={onClose} />);
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Tomorrow")).toBeTruthy();
    expect(screen.getByText("Next week")).toBeTruthy();
    expect(screen.getByText("No date")).toBeTruthy();
  });

  it("calls onChange(null) when No date is clicked", () => {
    render(<DatePicker value={null} onChange={onChange} onClose={onClose} />);

    fireEvent.click(screen.getByText("No date"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("calls onChange with today's date when Today is clicked", () => {
    render(<DatePicker value={null} onChange={onChange} onClose={onClose} />);

    fireEvent.click(screen.getByText("Today"));
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining("T00:00:00"));
  });

  it("navigates months with prev/next buttons", () => {
    render(<DatePicker value="2026-03-15T00:00:00" onChange={onChange} onClose={onClose} />);

    // Should show March 2026
    const monthLabel = screen.getByText(/March.*2026|2026.*March/i);
    expect(monthLabel).toBeTruthy();

    // Click prev to go to February
    const buttons = screen.getAllByRole("button");
    const prevBtn = buttons.find((b) => b.querySelector('[data-testid="chevron-left"]'));
    if (prevBtn) fireEvent.click(prevBtn);

    expect(screen.getByText(/February.*2026|2026.*February/i)).toBeTruthy();
  });

  it("highlights the selected date", () => {
    render(<DatePicker value="2026-03-15T00:00:00" onChange={onChange} onClose={onClose} />);

    // The "15" button should have the selected style (bg-accent)
    const dayBtn = screen.getByText("15");
    expect(dayBtn.className).toContain("bg-accent");
  });

  it("shows month label", () => {
    render(<DatePicker value="2026-06-01T00:00:00" onChange={onChange} onClose={onClose} />);

    expect(screen.getByText(/June.*2026|2026.*June/i)).toBeTruthy();
  });
});
