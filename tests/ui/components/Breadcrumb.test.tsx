import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Breadcrumb } from "../../../src/ui/components/Breadcrumb.js";

vi.mock("lucide-react", () => ({
  ChevronRight: (props: any) => <svg data-testid="chevron" {...props} />,
  Home: (props: any) => <svg data-testid="home-icon" {...props} />,
}));

describe("Breadcrumb", () => {
  it("renders nothing when items is empty", () => {
    const { container } = render(<Breadcrumb items={[]} />);
    expect(container.firstElementChild).toBeNull();
  });

  it("renders breadcrumb items", () => {
    render(<Breadcrumb items={[{ label: "Projects" }, { label: "Work" }]} />);
    expect(screen.getByText("Projects")).toBeDefined();
    expect(screen.getByText("Work")).toBeDefined();
  });

  it("has aria-label on nav", () => {
    render(<Breadcrumb items={[{ label: "Home" }]} />);
    expect(screen.getByLabelText("Breadcrumb")).toBeDefined();
  });

  it("renders clickable items as buttons", () => {
    const onClick = vi.fn();
    render(<Breadcrumb items={[{ label: "Projects", onClick }, { label: "Current" }]} />);
    const btn = screen.getByText("Projects");
    expect(btn.tagName).toBe("BUTTON");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders last item as text (no onClick)", () => {
    render(<Breadcrumb items={[{ label: "Projects", onClick: vi.fn() }, { label: "Current" }]} />);
    const current = screen.getByText("Current");
    expect(current.tagName).toBe("SPAN");
  });
});
