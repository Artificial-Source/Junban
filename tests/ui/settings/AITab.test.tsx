import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const mockUpdateConfig = vi.fn().mockResolvedValue(undefined);
const mockRefreshConfig = vi.fn().mockResolvedValue(undefined);
const mockListAIProviders = vi.fn().mockResolvedValue([]);
const mockFetchModels = vi.fn().mockResolvedValue([]);

vi.mock("../../../src/ui/context/AIContext.js", () => ({
  AIProvider: ({ children }: any) => children,
  useAIContext: () => ({
    config: { provider: "", model: "", baseUrl: "", hasApiKey: false },
    isConfigured: false,
    updateConfig: (...args: any[]) => mockUpdateConfig(...args),
    refreshConfig: (...args: any[]) => mockRefreshConfig(...args),
  }),
}));

vi.mock("../../../src/ui/api/ai.js", () => ({
  listAIProviders: (...args: any[]) => mockListAIProviders(...args),
  fetchModels: (...args: any[]) => mockFetchModels(...args),
  loadModel: vi.fn().mockResolvedValue(undefined),
  getAiMemories: vi.fn().mockResolvedValue([]),
  deleteAiMemory: vi.fn().mockResolvedValue(undefined),
  deleteAllAiMemories: vi.fn().mockResolvedValue(undefined),
  updateAiMemory: vi.fn().mockResolvedValue(undefined),
}));

import { AITab } from "../../../src/ui/views/settings/AITab.js";

describe("AITab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAIProviders.mockResolvedValue([
      {
        name: "openai",
        displayName: "OpenAI",
        needsApiKey: true,
        optionalApiKey: false,
        showBaseUrl: false,
        defaultModel: "gpt-4o",
        defaultBaseUrl: "",
      },
      {
        name: "ollama",
        displayName: "Ollama",
        needsApiKey: false,
        optionalApiKey: false,
        showBaseUrl: true,
        defaultModel: "llama3",
        defaultBaseUrl: "http://localhost:11434",
      },
    ]);
    mockFetchModels.mockResolvedValue([]);
  });

  function getProviderSelect() {
    // The provider selector is the first combobox; DailyBriefingSection may add another
    return screen.getAllByRole("combobox")[0];
  }

  it("renders provider selector with None option", async () => {
    render(<AITab />);
    await waitFor(() => {
      expect(screen.getByText("Provider")).toBeDefined();
    });
    const select = getProviderSelect();
    expect(select).toBeDefined();
    expect(screen.getByText("None (disabled)")).toBeDefined();
  });

  it("loads provider list from API", async () => {
    render(<AITab />);
    await waitFor(() => {
      expect(screen.getByText("OpenAI")).toBeDefined();
    });
    expect(screen.getByText("Ollama")).toBeDefined();
  });

  it("shows API key input when provider needs it", async () => {
    render(<AITab />);
    await waitFor(() => {
      expect(screen.getByText("OpenAI")).toBeDefined();
    });
    const select = getProviderSelect();
    fireEvent.change(select, { target: { value: "openai" } });
    await waitFor(() => {
      expect(screen.getByText("API Key")).toBeDefined();
    });
  });

  it("shows model input when provider is selected", async () => {
    render(<AITab />);
    await waitFor(() => {
      expect(screen.getByText("OpenAI")).toBeDefined();
    });
    const select = getProviderSelect();
    fireEvent.change(select, { target: { value: "openai" } });
    await waitFor(() => {
      expect(screen.getByText("Model")).toBeDefined();
    });
  });

  it("shows save button when provider is selected", async () => {
    render(<AITab />);
    await waitFor(() => {
      expect(screen.getByText("OpenAI")).toBeDefined();
    });
    const select = getProviderSelect();
    fireEvent.change(select, { target: { value: "openai" } });
    await waitFor(() => {
      const saveButtons = screen.getAllByText("Save");
      expect(saveButtons.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("calls updateConfig on save", async () => {
    render(<AITab />);
    await waitFor(() => {
      expect(screen.getByText("OpenAI")).toBeDefined();
    });
    const select = getProviderSelect();
    fireEvent.change(select, { target: { value: "openai" } });
    await waitFor(() => {
      expect(screen.getAllByText("Save").length).toBeGreaterThanOrEqual(1);
    });
    // The first Save button is the provider config save
    fireEvent.click(screen.getAllByText("Save")[0]);
    await waitFor(() => {
      expect(mockUpdateConfig).toHaveBeenCalled();
    });
  });

  it("shows not configured status initially", async () => {
    render(<AITab />);
    // Select a provider to see the status text
    await waitFor(() => {
      expect(screen.getByText("OpenAI")).toBeDefined();
    });
    const select = getProviderSelect();
    fireEvent.change(select, { target: { value: "openai" } });
    await waitFor(() => {
      expect(screen.getByText("Not configured")).toBeDefined();
    });
  });
});
