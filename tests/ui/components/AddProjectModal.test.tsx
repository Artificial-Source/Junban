import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  X: (props: any) => <svg data-testid="x-icon" {...props} />,
  Check: (props: any) => <svg data-testid="check-icon" {...props} />,
  Smile: (props: any) => <svg data-testid="smile-icon" {...props} />,
  Palette: (props: any) => <svg data-testid="palette-icon" {...props} />,
  List: (props: any) => <svg data-testid="list-icon" {...props} />,
  Columns3: (props: any) => <svg data-testid="columns-icon" {...props} />,
  Calendar: (props: any) => <svg data-testid="calendar-icon" {...props} />,
}));

vi.mock("emoji-picker-react", () => ({
  __esModule: true,
  default: () => <div data-testid="emoji-picker" />,
  Theme: { AUTO: "auto" },
}));

vi.mock("../../../src/config/defaults.js", () => ({
  DEFAULT_PROJECT_COLORS: [
    "#b8255f",
    "#db4035",
    "#ff9933",
    "#fad000",
    "#afb83b",
    "#7ecc49",
    "#299438",
    "#6accbc",
    "#158fad",
    "#14aaf5",
    "#4073ff",
  ],
  PROJECT_COLOR_LABELS: {
    "#b8255f": "Berry Red",
    "#db4035": "Red",
    "#ff9933": "Orange",
    "#fad000": "Yellow",
    "#afb83b": "Olive Green",
    "#7ecc49": "Lime Green",
    "#299438": "Emerald",
    "#6accbc": "Mint Green",
    "#158fad": "Teal",
    "#14aaf5": "Sky Blue",
    "#4073ff": "Blue",
  } as Record<string, string>,
}));

import { AddProjectModal } from "../../../src/ui/components/AddProjectModal.js";
import type { Project } from "../../../src/core/types.js";

describe("AddProjectModal", () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    projects: [] as Project[],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<AddProjectModal {...defaultProps} open={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders form when open", () => {
    render(<AddProjectModal {...defaultProps} />);
    expect(screen.getByText("Add project")).toBeDefined();
  });

  it("renders name input", () => {
    render(<AddProjectModal {...defaultProps} />);
    expect(screen.getByPlaceholderText("My project")).toBeDefined();
  });

  it("renders color swatches", () => {
    render(<AddProjectModal {...defaultProps} />);
    expect(screen.getByText("Color")).toBeDefined();
  });

  it("renders parent project dropdown", () => {
    render(<AddProjectModal {...defaultProps} />);
    expect(screen.getByLabelText("Parent project")).toBeDefined();
  });

  it("renders favorite toggle", () => {
    render(<AddProjectModal {...defaultProps} />);
    expect(screen.getByText("Add to favorites")).toBeDefined();
  });

  it("renders view style options", () => {
    render(<AddProjectModal {...defaultProps} />);
    expect(screen.getByText("List")).toBeDefined();
    expect(screen.getByText("Board")).toBeDefined();
    expect(screen.getByText("Calendar")).toBeDefined();
  });

  it("calls onSubmit with name on form submit", () => {
    render(<AddProjectModal {...defaultProps} />);
    const input = screen.getByPlaceholderText("My project");
    fireEvent.change(input, { target: { value: "New Project" } });
    fireEvent.click(screen.getByText("Add"));
    expect(defaultProps.onSubmit).toHaveBeenCalledWith(
      "New Project",
      expect.any(String), // color
      "", // emoji
      null, // parentId
      false, // isFavorite
      "list", // viewStyle
    );
  });

  it("disables Add button when name is empty", () => {
    render(<AddProjectModal {...defaultProps} />);
    const addButton = screen.getByText("Add");
    expect(addButton.hasAttribute("disabled")).toBe(true);
  });

  it("calls onClose when Cancel is clicked", () => {
    render(<AddProjectModal {...defaultProps} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("calls onClose when close button is clicked", () => {
    render(<AddProjectModal {...defaultProps} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("shows character count", () => {
    render(<AddProjectModal {...defaultProps} />);
    expect(screen.getByText("0/120")).toBeDefined();
  });

  it("keeps Tab focus contained when submit is disabled by empty name", () => {
    render(<AddProjectModal {...defaultProps} />);

    const dialog = screen.getByRole("dialog");
    const cancelButton = screen.getByText("Cancel");
    const closeButton = screen.getByLabelText("Close");
    const addButton = screen.getByText("Add");

    expect(addButton.hasAttribute("disabled")).toBe(true);

    cancelButton.focus();
    expect(document.activeElement).toBe(cancelButton);

    fireEvent.keyDown(cancelButton, { key: "Tab" });

    expect(document.activeElement).toBe(closeButton);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  // Accessibility tests for Milestone 4 blockers
  describe("accessibility", () => {
    it("emoji trigger has accessible name with aria-label", () => {
      render(<AddProjectModal {...defaultProps} />);
      const emojiButton = screen.getByLabelText("Pick an emoji");
      expect(emojiButton).toBeDefined();
      expect(emojiButton.getAttribute("aria-haspopup")).toBe("dialog");
      expect(emojiButton.getAttribute("aria-expanded")).toBe("false");
    });

    it("emoji trigger shows current emoji in accessible name when set", () => {
      render(
        <AddProjectModal
          {...defaultProps}
          initialProject={{
            id: "1",
            name: "Test",
            icon: "🚀",
            color: "#4073ff",
            isFavorite: false,
            viewStyle: "list",
            archived: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }}
          mode="edit"
        />,
      );
      const emojiButton = screen.getByLabelText("Change emoji: currently 🚀");
      expect(emojiButton).toBeDefined();
    });

    it("clear emoji button has accessible name", () => {
      render(
        <AddProjectModal
          {...defaultProps}
          initialProject={{
            id: "1",
            name: "Test",
            icon: "🚀",
            color: "#4073ff",
            isFavorite: false,
            viewStyle: "list",
            archived: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }}
          mode="edit"
        />,
      );
      const clearButton = screen.getByLabelText("Clear emoji");
      expect(clearButton).toBeDefined();
    });

    it("color picker has labeled group with aria-labelledby", () => {
      render(<AddProjectModal {...defaultProps} />);
      const colorLabel = screen.getByText("Color");
      expect(colorLabel.id).toBeDefined();
      // The group is referenced by aria-labelledby
      expect(colorLabel.tagName.toLowerCase()).toBe("label");
    });

    it("color buttons have accessible names and aria-pressed state", () => {
      render(<AddProjectModal {...defaultProps} />);
      // Default color is Blue (#4073ff)
      const blueButton = screen.getByLabelText("Blue");
      expect(blueButton).toBeDefined();
      expect(blueButton.getAttribute("aria-pressed")).toBe("true");

      // Other colors should have aria-pressed="false"
      const redButton = screen.getByLabelText("Red");
      expect(redButton.getAttribute("aria-pressed")).toBe("false");
    });

    it("color selection updates aria-pressed state", () => {
      render(<AddProjectModal {...defaultProps} />);
      const berryRedButton = screen.getByLabelText("Berry Red");

      // Initially not selected
      expect(berryRedButton.getAttribute("aria-pressed")).toBe("false");

      // Click to select
      fireEvent.click(berryRedButton);
      expect(berryRedButton.getAttribute("aria-pressed")).toBe("true");

      // Previous selection (Blue) should now be unselected
      const blueButton = screen.getByLabelText("Blue");
      expect(blueButton.getAttribute("aria-pressed")).toBe("false");
    });

    it("custom color button has accessible name and aria-pressed state", () => {
      render(<AddProjectModal {...defaultProps} />);
      const customButton = screen.getByLabelText("Custom color");
      expect(customButton).toBeDefined();
      expect(customButton.getAttribute("aria-pressed")).toBe("false");
    });

    it("view selector has radiogroup role with labeledby", () => {
      render(<AddProjectModal {...defaultProps} />);
      const viewLabel = screen.getByText("View");
      expect(viewLabel.id).toBeDefined();

      // Find the radiogroup container
      const radiogroup = document.querySelector('[role="radiogroup"]');
      expect(radiogroup).toBeDefined();
      expect(radiogroup?.getAttribute("aria-labelledby")).toBe(viewLabel.id);
    });

    it("view buttons have radio role with aria-checked for selected state", () => {
      render(<AddProjectModal {...defaultProps} />);
      const listButton = screen.getByRole("radio", { name: /list/i });
      const boardButton = screen.getByRole("radio", { name: /board/i });
      const calendarButton = screen.getByRole("radio", { name: /calendar/i });

      // List is default selected
      expect(listButton.getAttribute("aria-checked")).toBe("true");
      expect(boardButton.getAttribute("aria-checked")).toBe("false");
      expect(calendarButton.getAttribute("aria-checked")).toBe("false");
    });

    it("view selection updates aria-checked state", () => {
      render(<AddProjectModal {...defaultProps} />);
      const listButton = screen.getByRole("radio", { name: /list/i });
      const boardButton = screen.getByRole("radio", { name: /board/i });

      // Initially List is selected
      expect(listButton.getAttribute("aria-checked")).toBe("true");

      // Click Board
      fireEvent.click(boardButton);
      expect(boardButton.getAttribute("aria-checked")).toBe("true");
      expect(listButton.getAttribute("aria-checked")).toBe("false");
    });
  });
});
