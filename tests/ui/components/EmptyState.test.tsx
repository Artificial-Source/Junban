import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "../../../src/ui/components/EmptyState.js";

describe("EmptyState", () => {
  it("renders title and icon", () => {
    render(<EmptyState icon={<svg data-testid="test-icon" />} title="No tasks" />);
    expect(screen.getByText("No tasks")).toBeInTheDocument();
    expect(screen.getByTestId("test-icon")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(<EmptyState icon={<svg />} title="Empty" description="Add a task to get started" />);
    expect(screen.getByText("Add a task to get started")).toBeInTheDocument();
  });

  it("does not render description when not provided", () => {
    const { container } = render(<EmptyState icon={<svg />} title="Empty" />);
    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs.length).toBe(1); // Only the title
  });

  it("renders action button and calls onClick", () => {
    const onClick = vi.fn();
    render(<EmptyState icon={<svg />} title="Empty" action={{ label: "Add Task", onClick }} />);
    const button = screen.getByText("Add Task");
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not render action button when not provided", () => {
    render(<EmptyState icon={<svg />} title="Empty" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
