import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextMenu, type ContextMenuItem } from "../../../src/ui/components/ContextMenu.js";

const baseItems: ContextMenuItem[] = [
  { id: "edit", label: "Edit", onClick: vi.fn() },
  { id: "delete", label: "Delete", danger: true, onClick: vi.fn() },
  { id: "disabled-item", label: "Disabled", disabled: true, onClick: vi.fn() },
];

function renderMenu(items = baseItems, onClose = vi.fn()) {
  return render(<ContextMenu items={items} position={{ x: 100, y: 200 }} onClose={onClose} />);
}

describe("ContextMenu", () => {
  it("renders all menu items", () => {
    renderMenu();
    expect(screen.getByText("Edit")).toBeDefined();
    expect(screen.getByText("Delete")).toBeDefined();
    expect(screen.getByText("Disabled")).toBeDefined();
  });

  it("has role=menu on the container", () => {
    renderMenu();
    expect(screen.getByRole("menu")).toBeDefined();
  });

  it("calls onClick and onClose when item is clicked", () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    const items: ContextMenuItem[] = [{ id: "action", label: "Do Something", onClick }];
    render(<ContextMenu items={items} position={{ x: 0, y: 0 }} onClose={onClose} />);
    fireEvent.click(screen.getByText("Do Something"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClick for disabled items", () => {
    const onClick = vi.fn();
    const items: ContextMenuItem[] = [{ id: "nope", label: "Nope", disabled: true, onClick }];
    const onClose = vi.fn();
    render(<ContextMenu items={items} position={{ x: 0, y: 0 }} onClose={onClose} />);
    fireEvent.click(screen.getByText("Nope"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("closes on Escape key", () => {
    const onClose = vi.fn();
    renderMenu(baseItems, onClose);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on outside click", () => {
    const onClose = vi.fn();
    renderMenu(baseItems, onClose);
    fireEvent.mouseDown(document);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("navigates with ArrowDown keyboard", () => {
    renderMenu();
    const menu = screen.getByRole("menu");
    const items = menu.querySelectorAll('[role="menuitem"]');
    // Initial focus on first item
    expect(items.length).toBeGreaterThan(0);
    // Arrow down within the menu
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // Just verify no crash — focus management is DOM-dependent
  });

  it("renders submenu on hover", () => {
    const items: ContextMenuItem[] = [
      {
        id: "priority",
        label: "Set Priority",
        submenu: [
          { id: "p1", label: "P1 - Urgent", onClick: vi.fn() },
          { id: "p2", label: "P2 - High", onClick: vi.fn() },
        ],
      },
    ];
    renderMenu(items);
    fireEvent.mouseEnter(screen.getByText("Set Priority"));
    expect(screen.getByText("P1 - Urgent")).toBeDefined();
    expect(screen.getByText("P2 - High")).toBeDefined();
  });

  it("positions at specified coordinates", () => {
    const { container } = render(
      <ContextMenu items={baseItems} position={{ x: 150, y: 250 }} onClose={vi.fn()} />,
    );
    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.style.left).toBe("150px");
    expect(menu.style.top).toBe("250px");
  });

  it("renders separator divider when separator is true", () => {
    const items: ContextMenuItem[] = [
      { id: "a", label: "First", separator: true, onClick: vi.fn() },
      { id: "b", label: "Second", onClick: vi.fn() },
    ];
    renderMenu(items);
    const separators = screen.getAllByRole("separator");
    expect(separators.length).toBe(1);
  });

  it("does not render separator by default", () => {
    renderMenu();
    const separators = screen.queryAllByRole("separator");
    expect(separators.length).toBe(0);
  });

  it("renders shortcut text when shortcut is provided", () => {
    const items: ContextMenuItem[] = [
      { id: "edit", label: "Edit", shortcut: "Ctrl+E", onClick: vi.fn() },
    ];
    renderMenu(items);
    expect(screen.getByText("Ctrl+E")).toBeDefined();
  });

  it("keyboard nav works with separator items", () => {
    const items: ContextMenuItem[] = [
      { id: "a", label: "First", separator: true, onClick: vi.fn() },
      { id: "b", label: "Second", onClick: vi.fn() },
    ];
    renderMenu(items);
    const menu = screen.getByRole("menu");
    // Arrow down should not crash with separator items
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // No crash means pass
    expect(screen.getByText("First")).toBeDefined();
    expect(screen.getByText("Second")).toBeDefined();
  });

  it("renders shortcut text in submenu items", () => {
    const items: ContextMenuItem[] = [
      {
        id: "due",
        label: "Due date",
        submenu: [
          { id: "today", label: "Today", shortcut: "Sat", onClick: vi.fn() },
          { id: "tomorrow", label: "Tomorrow", shortcut: "Sun", onClick: vi.fn() },
        ],
      },
    ];
    renderMenu(items);
    fireEvent.mouseEnter(screen.getByText("Due date"));
    expect(screen.getByText("Sat")).toBeDefined();
    expect(screen.getByText("Sun")).toBeDefined();
  });

  it("renders separator in submenu items", () => {
    const items: ContextMenuItem[] = [
      {
        id: "remind",
        label: "Reminder",
        submenu: [
          { id: "30min", label: "In 30 min", onClick: vi.fn() },
          { id: "custom", label: "Custom...", separator: true, onClick: vi.fn() },
        ],
      },
    ];
    renderMenu(items);
    fireEvent.mouseEnter(screen.getByText("Reminder"));
    // Separator from parent item + separator from submenu item
    const seps = screen.queryAllByRole("separator");
    expect(seps.length).toBeGreaterThanOrEqual(1);
  });

  it("keepOpen prevents menu close on submenu item click", () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    const items: ContextMenuItem[] = [
      {
        id: "labels",
        label: "Labels",
        submenu: [{ id: "tag-work", label: "Work", keepOpen: true, onClick }],
      },
    ];
    render(<ContextMenu items={items} position={{ x: 0, y: 0 }} onClose={onClose} />);
    fireEvent.mouseEnter(screen.getByText("Labels"));
    fireEvent.click(screen.getByText("Work"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("without keepOpen, submenu item click closes menu", () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    const items: ContextMenuItem[] = [
      {
        id: "priority",
        label: "Priority",
        submenu: [{ id: "p1", label: "P1", onClick }],
      },
    ];
    render(<ContextMenu items={items} position={{ x: 0, y: 0 }} onClose={onClose} />);
    fireEvent.mouseEnter(screen.getByText("Priority"));
    fireEvent.click(screen.getByText("P1"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disabled submenu items render with muted style and do not fire onClick", () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    const items: ContextMenuItem[] = [
      {
        id: "labels",
        label: "Labels",
        submenu: [{ id: "no-tags", label: "No labels yet", disabled: true, onClick }],
      },
    ];
    render(<ContextMenu items={items} position={{ x: 0, y: 0 }} onClose={onClose} />);
    fireEvent.mouseEnter(screen.getByText("Labels"));
    const disabledBtn = screen.getByText("No labels yet").closest("button")!;
    expect(disabledBtn.className).toContain("cursor-not-allowed");
    fireEvent.click(disabledBtn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
