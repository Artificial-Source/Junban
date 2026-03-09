import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecurrenceEditor, RecurrenceEditDialog } from "../../../../src/plugins/builtin/timeblocking/components/RecurrenceEditor.js";

describe("RecurrenceEditor", () => {
  it("renders with no recurrence", () => {
    const onChange = vi.fn();
    render(<RecurrenceEditor rule={undefined} onChange={onChange} />);
    expect(screen.getByText("No repeat")).toBeInTheDocument();
  });

  it("shows Daily label for daily rule", () => {
    const onChange = vi.fn();
    render(
      <RecurrenceEditor
        rule={{ frequency: "daily", interval: 1 }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Daily")).toBeInTheDocument();
  });

  it("shows Weekly label with days", () => {
    const onChange = vi.fn();
    render(
      <RecurrenceEditor
        rule={{ frequency: "weekly", interval: 1, daysOfWeek: [1, 3, 5] }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Weekly (Mon, Wed, Fri)")).toBeInTheDocument();
  });

  it("shows Monthly label", () => {
    const onChange = vi.fn();
    render(
      <RecurrenceEditor
        rule={{ frequency: "monthly", interval: 1 }}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Monthly")).toBeInTheDocument();
  });

  it("opens popover on click", () => {
    const onChange = vi.fn();
    render(<RecurrenceEditor rule={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("recurrence-trigger"));
    expect(screen.getByTestId("recurrence-popover")).toBeInTheDocument();
    expect(screen.getByTestId("recurrence-frequency")).toBeInTheDocument();
  });

  it("calls onChange with undefined when None is selected", () => {
    const onChange = vi.fn();
    render(
      <RecurrenceEditor
        rule={{ frequency: "daily", interval: 1 }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("recurrence-trigger"));
    fireEvent.change(screen.getByTestId("recurrence-frequency"), {
      target: { value: "none" },
    });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("calls onChange with daily rule when Daily is selected", () => {
    const onChange = vi.fn();
    render(<RecurrenceEditor rule={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("recurrence-trigger"));
    fireEvent.change(screen.getByTestId("recurrence-frequency"), {
      target: { value: "daily" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ frequency: "daily", interval: 1 }),
    );
  });

  it("shows day checkboxes in weekly mode", () => {
    const onChange = vi.fn();
    render(
      <RecurrenceEditor
        rule={{ frequency: "weekly", interval: 1, daysOfWeek: [1] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("recurrence-trigger"));
    expect(screen.getByTestId("recurrence-days")).toBeInTheDocument();
    // Check all 7 day buttons exist
    for (let i = 0; i < 7; i++) {
      expect(screen.getByTestId(`recurrence-day-${i}`)).toBeInTheDocument();
    }
  });

  it("toggles a day in weekly mode", () => {
    const onChange = vi.fn();
    render(
      <RecurrenceEditor
        rule={{ frequency: "weekly", interval: 1, daysOfWeek: [1] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("recurrence-trigger"));
    // Add Wednesday (3)
    fireEvent.click(screen.getByTestId("recurrence-day-3"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ daysOfWeek: [1, 3] }),
    );
  });

  it("shows interval input in custom mode", () => {
    const onChange = vi.fn();
    render(
      <RecurrenceEditor
        rule={{ frequency: "daily", interval: 3 }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("recurrence-trigger"));
    expect(screen.getByTestId("recurrence-interval")).toBeInTheDocument();
  });

  it("shows end date picker when rule exists", () => {
    const onChange = vi.fn();
    render(
      <RecurrenceEditor
        rule={{ frequency: "daily", interval: 1 }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("recurrence-trigger"));
    expect(screen.getByTestId("recurrence-end-date")).toBeInTheDocument();
  });
});

describe("RecurrenceEditDialog", () => {
  it("renders edit mode", () => {
    const onChoice = vi.fn();
    const onCancel = vi.fn();
    render(<RecurrenceEditDialog mode="edit" onChoice={onChoice} onCancel={onCancel} />);
    expect(screen.getByText("Edit Recurring Block")).toBeInTheDocument();
    expect(screen.getByText("Edit this occurrence")).toBeInTheDocument();
    expect(screen.getByText("Edit all future occurrences")).toBeInTheDocument();
  });

  it("renders delete mode", () => {
    const onChoice = vi.fn();
    const onCancel = vi.fn();
    render(<RecurrenceEditDialog mode="delete" onChoice={onChoice} onCancel={onCancel} />);
    expect(screen.getByText("Delete Recurring Block")).toBeInTheDocument();
    expect(screen.getByText("Delete this occurrence")).toBeInTheDocument();
    expect(screen.getByText("Delete all occurrences")).toBeInTheDocument();
  });

  it("calls onChoice with 'this' when clicking this occurrence", () => {
    const onChoice = vi.fn();
    const onCancel = vi.fn();
    render(<RecurrenceEditDialog mode="edit" onChoice={onChoice} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("recurrence-choice-this"));
    expect(onChoice).toHaveBeenCalledWith("this");
  });

  it("calls onChoice with 'all' when clicking all", () => {
    const onChoice = vi.fn();
    const onCancel = vi.fn();
    render(<RecurrenceEditDialog mode="edit" onChoice={onChoice} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("recurrence-choice-all"));
    expect(onChoice).toHaveBeenCalledWith("all");
  });

  it("calls onCancel when clicking Cancel", () => {
    const onChoice = vi.fn();
    const onCancel = vi.fn();
    render(<RecurrenceEditDialog mode="edit" onChoice={onChoice} onCancel={onCancel} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});
