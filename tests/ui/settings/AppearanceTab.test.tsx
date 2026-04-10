import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AppearanceTab } from "../../../src/ui/views/settings/AppearanceTab.js";
import { SettingsProvider } from "../../../src/ui/context/SettingsContext.js";

const settingsApiMocks = vi.hoisted(() => ({
  getAllSettings: vi.fn().mockResolvedValue({}),
  setAppSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/ui/api/settings.js", () => settingsApiMocks);

// Mock themeManager
vi.mock("../../../src/ui/themes/manager.js", () => ({
  themeManager: {
    getCurrent: vi.fn().mockReturnValue("system"),
    setTheme: vi.fn(),
    listThemes: vi.fn().mockReturnValue([
      { id: "light", name: "Light", type: "light" },
      { id: "dark", name: "Dark", type: "dark" },
    ]),
  },
}));

import { themeManager } from "../../../src/ui/themes/manager.js";

function renderAppearanceTab() {
  return render(
    <SettingsProvider>
      <AppearanceTab />
    </SettingsProvider>,
  );
}

describe("AppearanceTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsApiMocks.getAllSettings.mockResolvedValue({});
    document.documentElement.style.removeProperty("--color-accent");
    document.documentElement.style.removeProperty("--color-accent-hover");
    document.documentElement.classList.remove(
      "density-compact",
      "density-comfortable",
      "font-small",
      "font-large",
      "reduce-motion",
    );
  });

  it("renders all 3 sections", async () => {
    renderAppearanceTab();
    await waitFor(() => {
      expect(screen.getByText("Theme")).toBeDefined();
    });
    expect(screen.getByText("Layout")).toBeDefined();
    expect(screen.getByText("Accessibility")).toBeDefined();
  });

  it("renders theme segmented control with system/light/dark", async () => {
    renderAppearanceTab();
    await waitFor(() => {
      // "System" appears in both theme and font family controls
      expect(screen.getAllByText("System").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.getByText("Light")).toBeDefined();
    expect(screen.getByText("Dark")).toBeDefined();
  });

  it("theme control calls themeManager.setTheme", async () => {
    renderAppearanceTab();
    await waitFor(() => {
      expect(screen.getByText("Dark")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Dark"));
    expect(themeManager.setTheme).toHaveBeenCalledWith("dark");
  });

  it("renders all accent color swatches", async () => {
    renderAppearanceTab();
    await waitFor(() => {
      expect(screen.getByText("Accent color")).toBeDefined();
    });
    const swatches = screen.getAllByLabelText(/Accent color #/);
    expect(swatches.length).toBe(19);
  });

  it("accent color picker updates setting on click", async () => {
    renderAppearanceTab();
    await waitFor(() => {
      expect(screen.getByText("Accent color")).toBeDefined();
    });
    const redSwatch = screen.getByLabelText("Accent color #db4035");
    fireEvent.click(redSwatch);
    expect(settingsApiMocks.setAppSetting).toHaveBeenCalledWith("accent_color", "#db4035");
  });

  it("renders density segmented control", async () => {
    renderAppearanceTab();
    await waitFor(() => {
      expect(screen.getByText("Compact")).toBeDefined();
    });
    // Multiple "Default" buttons exist (density + font size), just check Compact/Comfortable
    expect(screen.getByText("Comfortable")).toBeDefined();
  });

  it("density control updates setting", async () => {
    renderAppearanceTab();
    await waitFor(() => {
      expect(screen.getByText("Compact")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Compact"));
    expect(settingsApiMocks.setAppSetting).toHaveBeenCalledWith("density", "compact");
  });

  it("renders font size segmented control", async () => {
    renderAppearanceTab();
    await waitFor(() => {
      expect(screen.getByText("Font size")).toBeDefined();
    });
    expect(screen.getByText("Small")).toBeDefined();
    expect(screen.getByText("Large")).toBeDefined();
  });

  it("font size control updates setting", async () => {
    renderAppearanceTab();
    await waitFor(() => {
      expect(screen.getByText("Small")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Small"));
    expect(settingsApiMocks.setAppSetting).toHaveBeenCalledWith("font_size", "small");
  });

  it("renders reduce animations toggle", async () => {
    renderAppearanceTab();
    await waitFor(() => {
      expect(screen.getByText("Reduce animations")).toBeDefined();
    });
  });

  it("reduce animations toggle updates setting", async () => {
    renderAppearanceTab();
    await waitFor(() => {
      expect(screen.getByText("Reduce animations")).toBeDefined();
    });
    const label = screen.getByText("Reduce animations");
    const row = label.closest(".flex")!;
    const toggle = row.querySelector("button")!;
    fireEvent.click(toggle);
    expect(settingsApiMocks.setAppSetting).toHaveBeenCalledWith("reduce_animations", "true");
  });
});
