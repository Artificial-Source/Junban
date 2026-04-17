import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskInput } from "../../src/ui/components/TaskInput.js";

describe("TaskInput", () => {
  it("renders an input field", () => {
    render(<TaskInput onSubmit={() => {}} />);
    expect(screen.getByPlaceholderText(/add a task/i)).toBeInTheDocument();
  });

  it("calls onSubmit with parsed task on Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TaskInput onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/add a task/i);
    await user.type(input, "buy milk p1 #groceries{enter}");

    expect(onSubmit).toHaveBeenCalledOnce();
    const parsed = onSubmit.mock.calls[0][0];
    expect(parsed.title).toBe("buy milk");
    expect(parsed.priority).toBe(1);
    expect(parsed.tags).toContain("groceries");
  });

  it("clears the input after submit", async () => {
    const user = userEvent.setup();
    render(<TaskInput onSubmit={() => {}} />);

    const input = screen.getByPlaceholderText(/add a task/i) as HTMLInputElement;
    await user.type(input, "test task{enter}");

    expect(input.value).toBe("");
  });

  it("does not submit empty input", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TaskInput onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText(/add a task/i);
    await user.type(input, "{enter}");

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows parser preview while typing", async () => {
    const user = userEvent.setup();
    render(<TaskInput onSubmit={() => {}} />);

    const input = screen.getByPlaceholderText(/add a task/i);
    await user.type(input, "buy milk p2 #food");

    expect(screen.getByText("buy milk")).toBeInTheDocument();
    expect(screen.getAllByText("P2").length).toBeGreaterThan(0);
    expect(screen.getByText("food")).toBeInTheDocument();
  });

  it("uses custom placeholder", () => {
    render(<TaskInput onSubmit={() => {}} placeholder="Custom placeholder" />);
    expect(screen.getByPlaceholderText("Custom placeholder")).toBeInTheDocument();
  });
});
