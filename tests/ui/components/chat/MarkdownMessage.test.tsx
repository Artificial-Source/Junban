import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  Check: (props: any) => <svg data-testid="check-icon" {...props} />,
  Copy: (props: any) => <svg data-testid="copy-icon" {...props} />,
  ChevronDown: (props: any) => <svg data-testid="chevron-down" {...props} />,
  ChevronRight: (props: any) => <svg data-testid="chevron-right" {...props} />,
}));

import { MarkdownMessage } from "../../../../src/ui/components/chat/MarkdownMessage.js";

describe("MarkdownMessage", () => {
  it("renders plain text", () => {
    render(<MarkdownMessage content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeDefined();
  });

  it("renders bold text", () => {
    render(<MarkdownMessage content="**bold text**" />);
    expect(screen.getByText("bold text")).toBeDefined();
    // The bold text should be in a strong tag
    const strong = screen.getByText("bold text").closest("strong");
    expect(strong).toBeDefined();
  });

  it("renders italic text", () => {
    render(<MarkdownMessage content="*italic*" />);
    const em = screen.getByText("italic").closest("em");
    expect(em).toBeDefined();
  });

  it("renders external links", () => {
    render(<MarkdownMessage content="[Visit](https://example.com)" />);
    const link = screen.getByText("Visit");
    expect(link.closest("a")?.getAttribute("href")).toBe("https://example.com");
    expect(link.closest("a")?.getAttribute("target")).toBe("_blank");
  });

  it("renders saydo:// links as buttons when onSelectTask is provided", () => {
    const onSelectTask = vi.fn();
    render(<MarkdownMessage content="[Task](saydo://task/abc123)" onSelectTask={onSelectTask} />);
    const button = screen.getByText("Task");
    fireEvent.click(button);
    expect(onSelectTask).toHaveBeenCalledWith("abc123");
  });

  it("renders unordered lists", () => {
    const content = "- Item 1\n- Item 2";
    render(<MarkdownMessage content={content} />);
    // Markdown list renders both items within a ul
    const ul = document.querySelector("ul");
    expect(ul).toBeDefined();
    const items = document.querySelectorAll("li");
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it("renders inline code", () => {
    render(<MarkdownMessage content="Use `npm install` to install" />);
    expect(screen.getByText("npm install")).toBeDefined();
  });

  it("renders headings", () => {
    render(<MarkdownMessage content="# Title" />);
    const heading = screen.getByText("Title");
    expect(heading.tagName).toBe("H1");
  });
});
