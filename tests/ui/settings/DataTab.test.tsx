import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("lucide-react", () => ({
  ChevronDown: (props: any) => <svg data-testid="chevron-down" {...props} />,
  ChevronUp: (props: any) => <svg data-testid="chevron-up" {...props} />,
}));

const mockGetStorageInfo = vi.fn();
const mockExportAllData = vi.fn();
const mockImportTasks = vi.fn();
const mockListProjects = vi.fn();

vi.mock("../../../src/ui/api/index.js", () => ({
  api: {
    getStorageInfo: (...args: any[]) => mockGetStorageInfo(...args),
    exportAllData: (...args: any[]) => mockExportAllData(...args),
    importTasks: (...args: any[]) => mockImportTasks(...args),
    listProjects: (...args: any[]) => mockListProjects(...args),
  },
}));

vi.mock("../../../src/ui/context/TaskContext.js", () => ({
  useTaskContext: () => ({
    refreshTasks: vi.fn(),
  }),
}));

vi.mock("../../../src/core/export.js", () => ({
  exportJSON: vi.fn().mockReturnValue("{}"),
  exportCSV: vi.fn().mockReturnValue(""),
  exportMarkdown: vi.fn().mockReturnValue(""),
}));

vi.mock("../../../src/core/import.js", () => ({
  parseImport: vi.fn().mockReturnValue({
    tasks: [],
    projects: [],
    tags: [],
    warnings: [],
    format: "saydo-json",
  }),
}));

vi.mock("../../../src/ui/views/settings/components.js", () => ({
  SegmentedControl: ({ options, value: _value, onChange }: any) => (
    <div data-testid="segmented-control">
      {options.map((opt: any) => (
        <button key={opt.value} onClick={() => onChange(opt.value)}>
          {opt.label}
        </button>
      ))}
    </div>
  ),
}));

import { DataTab } from "../../../src/ui/views/settings/DataTab.js";

describe("DataTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStorageInfo.mockResolvedValue({ mode: "sqlite", path: "/data/saydo.db" });
    mockExportAllData.mockResolvedValue({ tasks: [], projects: [], tags: [] });
    mockListProjects.mockResolvedValue([]);
  });

  it("renders storage info section", async () => {
    render(<DataTab />);
    await waitFor(() => {
      expect(screen.getByText("Storage")).toBeDefined();
    });
  });

  it("displays storage mode and path", async () => {
    render(<DataTab />);
    await waitFor(() => {
      expect(screen.getByText("SQLite")).toBeDefined();
    });
    expect(screen.getByText("/data/saydo.db")).toBeDefined();
  });

  it("renders export buttons", async () => {
    render(<DataTab />);
    await waitFor(() => {
      expect(screen.getByText("Export JSON")).toBeDefined();
    });
    expect(screen.getByText("Export CSV")).toBeDefined();
    expect(screen.getByText("Export Markdown")).toBeDefined();
  });

  it("renders import section", async () => {
    render(<DataTab />);
    await waitFor(() => {
      expect(screen.getByText("Import")).toBeDefined();
    });
    expect(screen.getByText("Choose File")).toBeDefined();
  });

  it("shows markdown storage description", async () => {
    mockGetStorageInfo.mockResolvedValue({ mode: "markdown", path: "/data/tasks" });
    render(<DataTab />);
    await waitFor(() => {
      expect(screen.getByText("Markdown Files")).toBeDefined();
    });
  });

  it("shows loading state before storage info loads", () => {
    mockGetStorageInfo.mockReturnValue(new Promise(() => {})); // never resolves
    render(<DataTab />);
    expect(screen.getByText("Loading storage info...")).toBeDefined();
  });
});
