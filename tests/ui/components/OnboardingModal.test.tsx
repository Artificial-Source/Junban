import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock variables must be declared before the component import
const mockUpdateSetting = vi.fn();
const mockSetTheme = vi.fn();
const mockApprovePluginPermissions = vi.fn();

vi.mock("lucide-react", () => ({
  CheckCircle2: (props: any) => <svg data-testid="icon-check" {...props} />,
  Sparkles: (props: any) => <svg data-testid="icon-sparkles" {...props} />,
  Sun: (props: any) => <svg data-testid="icon-sun" {...props} />,
  Moon: (props: any) => <svg data-testid="icon-moon" {...props} />,
  Snowflake: (props: any) => <svg data-testid="icon-snowflake" {...props} />,
  Minus: (props: any) => <svg data-testid="icon-minus" {...props} />,
  Layers: (props: any) => <svg data-testid="icon-layers" {...props} />,
  Rocket: (props: any) => <svg data-testid="icon-rocket" {...props} />,
  Bot: (props: any) => <svg data-testid="icon-bot" {...props} />,
  Type: (props: any) => <svg data-testid="icon-type" {...props} />,
  Command: (props: any) => <svg data-testid="icon-command" {...props} />,
  Puzzle: (props: any) => <svg data-testid="icon-puzzle" {...props} />,
  Check: (props: any) => <svg data-testid="icon-check-small" {...props} />,
}));

vi.mock("../../../src/ui/context/SettingsContext.js", () => ({
  useGeneralSettings: () => ({
    settings: { accent_color: "#3b82f6" },
    loaded: true,
    updateSetting: (...args: any[]) => mockUpdateSetting(...args),
  }),
}));

vi.mock("../../../src/ui/themes/manager.js", () => ({
  themeManager: {
    setTheme: (...args: any[]) => mockSetTheme(...args),
  },
}));

vi.mock("../../../src/ui/api/plugins.js", () => ({
  approvePluginPermissions: (...args: any[]) => mockApprovePluginPermissions(...args),
}));

import { OnboardingModal } from "../../../src/ui/components/OnboardingModal.js";

describe("OnboardingModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<OnboardingModal open={false} onComplete={vi.fn()} />);
    expect(container.firstElementChild).toBeNull();
  });

  it("renders welcome step when open", () => {
    render(<OnboardingModal open={true} onComplete={vi.fn()} />);
    expect(screen.getByText("Welcome to Junban")).toBeDefined();
  });

  it("navigates to theme step on Get Started click", () => {
    render(<OnboardingModal open={true} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Get Started"));
    expect(screen.getByText("Pick your look")).toBeDefined();
  });

  it("navigates to preset step from theme step", () => {
    render(<OnboardingModal open={true} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Get Started")); // step 0 -> 1
    fireEvent.click(screen.getByText("Next")); // step 1 -> 2
    expect(screen.getByText("How much do you want to see?")).toBeDefined();
  });

  it("navigates back from theme step to welcome", () => {
    render(<OnboardingModal open={true} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Get Started")); // step 0 -> 1
    fireEvent.click(screen.getByText("Back")); // step 1 -> 0
    expect(screen.getByText("Welcome to Junban")).toBeDefined();
  });

  it("shows preset options on step 2", () => {
    render(<OnboardingModal open={true} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Get Started")); // 0 -> 1
    fireEvent.click(screen.getByText("Next")); // 1 -> 2
    expect(screen.getByText("Minimal")).toBeDefined();
    expect(screen.getByText("Standard")).toBeDefined();
    expect(screen.getByText("Everything")).toBeDefined();
    expect(
      screen.getByText("Start simple. You can always add more later in Settings."),
    ).toBeDefined();
    expect(screen.getByText("Recommended to start: just Inbox, Today, and Upcoming")).toBeDefined();
  });

  it("navigates through AI step to ready step", () => {
    render(<OnboardingModal open={true} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByText("Get Started")); // 0 -> 1
    fireEvent.click(screen.getByText("Next")); // 1 -> 2
    fireEvent.click(screen.getByText("Next")); // 2 -> 3
    expect(screen.getByText("AI Assistant")).toBeDefined();
    fireEvent.click(screen.getByText("Set up later")); // 3 -> 4
    expect(screen.getByText("You're all set!")).toBeDefined();
  });

  it("calls onComplete on Start using Junban", async () => {
    const onComplete = vi.fn();
    render(<OnboardingModal open={true} onComplete={onComplete} />);
    fireEvent.click(screen.getByText("Get Started")); // 0 -> 1
    fireEvent.click(screen.getByText("Next")); // 1 -> 2
    fireEvent.click(screen.getByText("Next")); // 2 -> 3
    fireEvent.click(screen.getByText("Set up later")); // 3 -> 4
    fireEvent.click(screen.getByText("Start using Junban"));
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe("mutations blocked", () => {
    it("skips local writes when mutations are blocked during finish", async () => {
      const onComplete = vi.fn();
      render(<OnboardingModal open={true} onComplete={onComplete} mutationsBlocked={true} />);

      // Navigate through to finish
      fireEvent.click(screen.getByText("Get Started"));
      fireEvent.click(screen.getByText("Next"));
      fireEvent.click(screen.getByText("Next"));
      fireEvent.click(screen.getByText("Set up later"));
      fireEvent.click(screen.getByText("Start using Junban"));

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledTimes(1);
      });

      // Should not have called any updateSetting
      expect(mockUpdateSetting).not.toHaveBeenCalled();
      expect(mockSetTheme).not.toHaveBeenCalled();
      expect(mockApprovePluginPermissions).not.toHaveBeenCalled();
    });

    it("does not update theme when selecting theme while mutations blocked", () => {
      render(<OnboardingModal open={true} onComplete={vi.fn()} mutationsBlocked={true} />);

      fireEvent.click(screen.getByText("Get Started")); // Navigate to theme step

      // Click on a theme
      fireEvent.click(screen.getByText("Dark"));

      expect(mockSetTheme).not.toHaveBeenCalled();
    });

    it("does not update accent color when selecting color while mutations blocked", () => {
      render(<OnboardingModal open={true} onComplete={vi.fn()} mutationsBlocked={true} />);

      fireEvent.click(screen.getByText("Get Started")); // Navigate to theme step

      // The color buttons have aria-labels with the color values
      const colorButtons = screen.getAllByLabelText(/Accent color/);
      if (colorButtons.length > 0) {
        fireEvent.click(colorButtons[1]!);
      }

      expect(mockUpdateSetting).not.toHaveBeenCalled();
    });

    it("skips local writes when readOnly prop is true (regression: combined lock state)", async () => {
      // Regression test: readOnly prop should also block writes
      const onComplete = vi.fn();
      render(
        <OnboardingModal
          open={true}
          onComplete={onComplete}
          mutationsBlocked={false}
          readOnly={true}
        />,
      );

      // Navigate through to finish
      fireEvent.click(screen.getByText("Get Started"));
      fireEvent.click(screen.getByText("Next"));
      fireEvent.click(screen.getByText("Next"));
      fireEvent.click(screen.getByText("Set up later"));
      fireEvent.click(screen.getByText("Start using Junban"));

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledTimes(1);
      });

      // Should not have called any updateSetting when readOnly is true
      expect(mockUpdateSetting).not.toHaveBeenCalled();
      expect(mockSetTheme).not.toHaveBeenCalled();
      expect(mockApprovePluginPermissions).not.toHaveBeenCalled();
    });

    it("skips local writes when either mutationsBlocked OR readOnly is true", async () => {
      // Combined lock state test: either prop should block writes
      const onComplete = vi.fn();
      render(
        <OnboardingModal
          open={true}
          onComplete={onComplete}
          mutationsBlocked={true}
          readOnly={true}
        />,
      );

      // Navigate through to finish
      fireEvent.click(screen.getByText("Get Started"));
      fireEvent.click(screen.getByText("Next"));
      fireEvent.click(screen.getByText("Next"));
      fireEvent.click(screen.getByText("Set up later"));
      fireEvent.click(screen.getByText("Start using Junban"));

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledTimes(1);
      });

      // Should not have called any updateSetting
      expect(mockUpdateSetting).not.toHaveBeenCalled();
    });
  });

  describe("accessibility - radio group semantics", () => {
    it("theme options have radio roles and aria-checked attributes", () => {
      render(<OnboardingModal open={true} onComplete={vi.fn()} />);
      fireEvent.click(screen.getByText("Get Started")); // Navigate to theme step

      // Theme options should be in a radiogroup
      const themeGroup = screen.getByRole("radiogroup", { name: /theme selection/i });
      expect(themeGroup).toBeInTheDocument();

      // Each theme option should have role="radio" and aria-checked
      const themeOptions = screen.getAllByRole("radio");
      expect(themeOptions.length).toBeGreaterThanOrEqual(3); // At least light, dark, nord

      // One should be checked (the default selected theme)
      const checkedOption = themeOptions.find(
        (option) => option.getAttribute("aria-checked") === "true",
      );
      expect(checkedOption).toBeDefined();
    });

    it("accent color options have radio roles and aria-checked attributes", () => {
      render(<OnboardingModal open={true} onComplete={vi.fn()} />);
      fireEvent.click(screen.getByText("Get Started")); // Navigate to theme step

      // Accent color group should exist
      const colorGroup = screen.getByRole("radiogroup", { name: /accent color/i });
      expect(colorGroup).toBeInTheDocument();

      // Each color should have role="radio"
      const colorOptions = screen.getAllByRole("radio");
      expect(colorOptions.length).toBeGreaterThanOrEqual(3);
    });

    it("preset options have radio roles and aria-checked attributes", () => {
      render(<OnboardingModal open={true} onComplete={vi.fn()} />);
      fireEvent.click(screen.getByText("Get Started"));
      fireEvent.click(screen.getByText("Next")); // Navigate to preset step

      // Preset group should exist
      const presetGroup = screen.getByRole("radiogroup", { name: /feature preset selection/i });
      expect(presetGroup).toBeInTheDocument();

      // Each preset option should have role="radio"
      const presetOptions = screen.getAllByRole("radio");
      expect(presetOptions.length).toBeGreaterThanOrEqual(3); // Minimal, Standard, Everything

      // One should be checked
      const checkedOption = presetOptions.find(
        (option) => option.getAttribute("aria-checked") === "true",
      );
      expect(checkedOption).toBeDefined();
    });
  });
});
