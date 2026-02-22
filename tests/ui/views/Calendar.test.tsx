import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  CalendarRange: (props: any) => <svg data-testid="calendar-icon" {...props} />,
  ChevronLeft: (props: any) => <svg data-testid="chevron-left" {...props} />,
  ChevronRight: (props: any) => <svg data-testid="chevron-right" {...props} />,
  Check: (props: any) => <svg data-testid="check-icon" {...props} />,
}));

vi.mock("../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: { week_start: "sunday", calendar_default_mode: "week" },
    loaded: true,
    updateSetting: vi.fn(),
  }),
}));

vi.mock("../../../src/utils/format-date.js", () => ({
  toDateKey: (d: Date) => d.toISOString().split("T")[0],
}));

vi.mock("../../../src/ui/views/settings/components.js", () => ({
  SegmentedControl: (props: any) => (
    <div data-testid="segmented-control">
      {props.options.map((o: any) => (
        <button
          key={o.value}
          data-testid={`mode-${o.value}`}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../../../src/ui/views/calendar/useCalendarNavigation.js", () => ({
  useCalendarNavigation: (opts: any) => {
    const mode = opts?.initialMode ?? "week";
    return {
      selectedDate: new Date("2026-02-21"),
      mode,
      setMode: vi.fn(),
      goNext: vi.fn(),
      goPrev: vi.fn(),
      goToday: vi.fn(),
      setDate: vi.fn(),
      isCurrentPeriod: true,
      periodLabel: "February 2026",
      weekStartDay: 0,
    };
  },
}));

vi.mock("../../../src/ui/views/calendar/CalendarWeekView.js", () => ({
  CalendarWeekView: () => <div data-testid="week-view">Week View</div>,
}));

vi.mock("../../../src/ui/views/calendar/CalendarMonthView.js", () => ({
  CalendarMonthView: () => <div data-testid="month-view">Month View</div>,
}));

vi.mock("../../../src/ui/views/calendar/CalendarDayView.js", () => ({
  CalendarDayView: () => <div data-testid="day-view">Day View</div>,
}));

import { Calendar } from "../../../src/ui/views/Calendar.js";

describe("Calendar", () => {
  const defaultProps = {
    tasks: [],
    projects: [],
    onSelectTask: vi.fn(),
    onToggleTask: vi.fn(),
  };

  it("renders the period label", () => {
    render(<Calendar {...defaultProps} />);
    expect(screen.getByText("February 2026")).toBeTruthy();
  });

  it("renders mode tabs (Day, Week, Month)", () => {
    render(<Calendar {...defaultProps} />);
    expect(screen.getByTestId("segmented-control")).toBeTruthy();
    expect(screen.getByText("Day")).toBeTruthy();
    expect(screen.getByText("Week")).toBeTruthy();
    expect(screen.getByText("Month")).toBeTruthy();
  });

  it("renders week view by default", () => {
    render(<Calendar {...defaultProps} />);
    expect(screen.getByTestId("week-view")).toBeTruthy();
  });

  it("renders navigation buttons", () => {
    render(<Calendar {...defaultProps} />);
    expect(screen.getByText("Today")).toBeTruthy();
    // Previous and next buttons have aria-labels
    expect(screen.getByLabelText("Previous week")).toBeTruthy();
    expect(screen.getByLabelText("Next week")).toBeTruthy();
  });

  it("renders day view when mode prop is day", () => {
    render(<Calendar {...defaultProps} mode="day" />);
    expect(screen.getByTestId("day-view")).toBeTruthy();
  });

  it("renders month view when mode prop is month", () => {
    render(<Calendar {...defaultProps} mode="month" />);
    expect(screen.getByTestId("month-view")).toBeTruthy();
  });
});
