import { act } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentToolsTab } from "../../../src/ui/views/settings/AgentToolsTab.js";

vi.mock("../../../src/utils/tauri.js", () => ({
  isTauri: () => false,
}));

vi.mock("../../../src/config/defaults.js", () => ({
  APP_VERSION: "1.2.3",
}));

function cardFor(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title });
  const card = heading.closest("div");
  if (!card) throw new Error(`Missing card for ${title}`);
  return card;
}

describe("AgentToolsTab", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let anchorClick: ReturnType<typeof vi.fn>;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL = vi.fn().mockReturnValue("blob:junban-agent-tools");
    revokeObjectURL = vi.fn();
    anchorClick = vi.fn();
    writeText = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    Object.defineProperty(HTMLAnchorElement.prototype, "click", {
      configurable: true,
      value: anchorClick,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the agent setup cards and docs links", () => {
    render(<AgentToolsTab />);

    expect(screen.getByRole("heading", { name: "Agent Tools" })).toBeInTheDocument();
    expect(screen.getByText("junban")).toBeInTheDocument();
    expect(screen.getByText("junban-mcp")).toBeInTheDocument();
    expect(screen.getByText("App version:")).toHaveTextContent("1.2.3");
    expect(screen.getByRole("heading", { name: "Claude MCP config" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent skill" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Source checkout config" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /MCP setup guide/i })).toHaveAttribute(
      "href",
      expect.stringContaining("connect-claude-desktop"),
    );
  });

  it("copies setup snippets and clears copied feedback", async () => {
    render(<AgentToolsTab />);
    const card = cardFor("Agent skill");

    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: /copy/i }));
    });

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("# Junban Agent Skill"));
    expect(within(card).getByRole("button", { name: /copied/i })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1600);
    });

    expect(within(card).getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("keeps copy feedback off when clipboard write fails", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    render(<AgentToolsTab />);
    const card = cardFor("Claude MCP config");

    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: /copy/i }));
    });

    expect(writeText).toHaveBeenCalled();
    expect(within(card).queryByRole("button", { name: /copied/i })).not.toBeInTheDocument();
  });

  it("downloads setup snippets with the browser fallback and revokes object URLs", async () => {
    render(<AgentToolsTab />);
    const card = cardFor("Source checkout config");

    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: /download/i }));
    });

    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchorClick).toHaveBeenCalled();
    expect(within(card).getByRole("button", { name: /saved/i })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:junban-agent-tools");

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(within(card).getByRole("button", { name: /download/i })).toBeInTheDocument();
  });

  it("shows a useful download error when saving fails", async () => {
    createObjectURL.mockImplementationOnce(() => {
      throw new Error("blob disabled");
    });
    render(<AgentToolsTab />);

    await act(async () => {
      fireEvent.click(
        within(cardFor("Claude MCP config")).getByRole("button", { name: /download/i }),
      );
    });

    expect(screen.getByText("Could not save file. blob disabled")).toBeInTheDocument();
  });
});
