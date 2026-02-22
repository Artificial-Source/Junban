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
  PROJECT_COLOR_LABELS: {} as Record<string, string>,
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
});
