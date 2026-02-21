import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  SkeletonLine,
  SkeletonTaskItem,
  SkeletonTaskList,
} from "../../../src/ui/components/Skeleton.js";

describe("SkeletonLine", () => {
  it("renders with default dimensions", () => {
    const { container } = render(<SkeletonLine />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.width).toBe("100%");
    expect(el.style.height).toBe("0.75rem");
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("accepts custom width and height", () => {
    const { container } = render(<SkeletonLine width="50%" height="1rem" />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.width).toBe("50%");
    expect(el.style.height).toBe("1rem");
  });
});

describe("SkeletonTaskItem", () => {
  it("has correct ARIA attributes", () => {
    render(<SkeletonTaskItem />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.getAttribute("aria-label")).toBe("Loading task");
  });
});

describe("SkeletonTaskList", () => {
  it("renders 5 items by default", () => {
    render(<SkeletonTaskList />);
    const items = screen.getAllByLabelText("Loading task");
    expect(items.length).toBe(5);
  });

  it("renders custom count", () => {
    render(<SkeletonTaskList count={3} />);
    const items = screen.getAllByLabelText("Loading task");
    expect(items.length).toBe(3);
  });

  it("has aria-busy on container", () => {
    render(<SkeletonTaskList />);
    const container = screen.getByLabelText("Loading tasks");
    expect(container.getAttribute("aria-busy")).toBe("true");
  });
});
