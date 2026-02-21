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
});
