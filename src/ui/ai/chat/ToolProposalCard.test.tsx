/**
 * Apply-auto-schedule proposal presentation + generic approval controls.
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatToolProposal } from "../message-view";
import {
  APPLY_AUTO_SCHEDULE_DAY_TOOL,
  formatStructuredPlain,
  toolDisplayLabel,
  toolMetaFor,
} from "../tool-meta";
import { ToolProposalCard } from "./ToolProposalCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pendingProposal(overrides: Partial<ChatToolProposal> = {}): ChatToolProposal {
  return {
    approvalId: "11111111-1111-4111-8111-111111111111",
    tool: "create_task",
    arguments: { title: "Ship dogfood fix" },
    actionHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expiresAt: "2099-01-01T00:00:00Z",
    decision: "pending",
    ...overrides,
  };
}

function scheduleBlock(index: number, titleExtra = "") {
  const n = index + 1;
  return {
    task_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    title: `Block ${n}${titleExtra}`,
    date: "2026-08-02",
    start: `${String(8 + (index % 10)).padStart(2, "0")}:00`,
    end: `${String(8 + (index % 10)).padStart(2, "0")}:30`,
    time_zone: "America/Los_Angeles",
    estimated_minutes: 30 + index,
  };
}

function approvalButtons(container: HTMLElement): {
  approve: HTMLButtonElement;
  reject: HTMLButtonElement;
} {
  const buttons = Array.from(container.querySelectorAll("button"));
  const approve = buttons.find((button) => button.textContent?.includes("Approve"));
  const reject = buttons.find((button) => button.textContent?.includes("Reject"));
  expect(approve).toBeTruthy();
  expect(reject).toBeTruthy();
  return {
    approve: approve as HTMLButtonElement,
    reject: reject as HTMLButtonElement,
  };
}

describe("tool metadata for apply_auto_schedule_day", () => {
  it("exposes a friendly label and icon without raw snake_case", () => {
    const meta = toolMetaFor(APPLY_AUTO_SCHEDULE_DAY_TOOL);
    const label = toolDisplayLabel(APPLY_AUTO_SCHEDULE_DAY_TOOL);
    expect(label).toBe("day schedule");
    expect(label.includes("_")).toBe(false);
    expect(meta.verb.toLowerCase()).toContain("schedule");
    expect(meta.icon).toBeTruthy();
    expect(meta.icon).toBe(toolMetaFor("auto_schedule_day").icon);
  });
});

describe("ToolProposalCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a friendly header for apply_auto_schedule_day", () => {
    const proposal = pendingProposal({
      tool: APPLY_AUTO_SCHEDULE_DAY_TOOL,
      arguments: {
        date: "2026-08-02",
        blocks: [scheduleBlock(0)],
      },
    });

    act(() => {
      root.render(createElement(ToolProposalCard, { proposal }));
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Approve day schedule");
    expect(text.includes("apply_auto_schedule_day")).toBe(false);
    expect(text.includes("apply auto schedule day")).toBe(false);
  });

  it("shows every approved block including the final task id beyond generic 2k JSON", () => {
    // Long titles force pretty JSON well past the generic 2_000-char plain formatter.
    const blocks = Array.from({ length: 16 }, (_, i) =>
      scheduleBlock(i, ` ${"detail-padding-".repeat(12)}`),
    );
    const args = { date: "2026-08-02", blocks };
    expect(formatStructuredPlain(args, 2_000).includes(blocks[15]!.task_id)).toBe(false);

    const proposal = pendingProposal({
      tool: APPLY_AUTO_SCHEDULE_DAY_TOOL,
      arguments: args,
    });

    act(() => {
      root.render(createElement(ToolProposalCard, { proposal }));
    });

    const text = container.textContent ?? "";
    expect(text).toContain("2026-08-02");
    for (const block of blocks) {
      expect(text).toContain(block.title);
      expect(text).toContain(block.task_id);
      expect(text).toContain(block.start);
      expect(text).toContain(block.end);
      expect(text).toContain(block.time_zone);
      expect(text).toContain(String(block.estimated_minutes));
    }
    expect(text).toContain(blocks[15]!.task_id);
    expect(container.querySelector('[aria-label="Approved schedule blocks"]')).toBeTruthy();
    expect(container.querySelectorAll('[aria-label="Approved schedule blocks"] > li')).toHaveLength(
      16,
    );
  });

  it("falls back safely for malformed apply-schedule arguments without crashing", () => {
    const proposal = pendingProposal({
      tool: APPLY_AUTO_SCHEDULE_DAY_TOOL,
      arguments: {
        date: 42 as unknown as string,
        blocks: "not-an-array" as unknown as unknown[],
      } as unknown as Record<string, unknown>,
    });

    expect(() => {
      act(() => {
        root.render(createElement(ToolProposalCard, { proposal }));
      });
    }).not.toThrow();

    const text = container.textContent ?? "";
    expect(text).toContain("Approve day schedule");
    // Generic bounded JSON fallback — must not invent a schedule list.
    expect(container.querySelector('[aria-label="Approved schedule blocks"]')).toBeNull();
    expect(text).toContain("not-an-array");
  });

  it("marks missing block fields without inventing schedule values", () => {
    const proposal = pendingProposal({
      tool: APPLY_AUTO_SCHEDULE_DAY_TOOL,
      arguments: {
        date: "2026-08-02",
        blocks: [{ task_id: "00000000-0000-4000-8000-000000000099" }],
      },
    });

    act(() => {
      root.render(createElement(ToolProposalCard, { proposal }));
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Title missing");
    expect(text).toContain("00000000-0000-4000-8000-000000000099");
    expect(text).not.toContain("Untitled");
  });

  it("keeps generic JSON args and header for other tools", () => {
    const proposal = pendingProposal({
      tool: "create_task",
      arguments: { title: "Ship dogfood fix", priority: 2 },
    });

    act(() => {
      root.render(createElement(ToolProposalCard, { proposal }));
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Approve create task");
    expect(text).toContain("Ship dogfood fix");
    expect(container.querySelector("pre")).toBeTruthy();
    expect(container.querySelector('[aria-label="Approved schedule blocks"]')).toBeNull();
  });

  it("shows every task in valid generic bulk mutation args beyond the old 2k truncation", () => {
    // The registry accepts up to 500 task IDs; this valid 100-ID mutation already exceeds 2,000 chars.
    const taskIds = Array.from(
      { length: 100 },
      (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    );
    const finalTaskId = taskIds.at(-1)!;
    const args = { task_ids: taskIds, priority: 2 };
    const truncated = formatStructuredPlain(args, 2_000);
    expect(truncated.includes(finalTaskId)).toBe(false);
    expect(truncated.includes("…")).toBe(true);

    const onApprove = vi.fn();
    const proposal = pendingProposal({
      tool: "bulk_update_tasks",
      arguments: args,
    });

    act(() => {
      root.render(
        createElement(ToolProposalCard, {
          proposal,
          onApprove,
          onReject: vi.fn(),
        }),
      );
    });

    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    const preText = pre?.textContent ?? "";
    expect(preText).toContain(finalTaskId);
    expect(preText).toContain('"priority": 2');
    expect(preText.match(/00000000-0000-4000-8000-/g)).toHaveLength(100);
    // Must not hide the suffix behind the old formatter ellipsis.
    expect(preText.includes("\n…")).toBe(false);
    expect(preText.endsWith("…")).toBe(false);

    const { approve } = approvalButtons(container);
    expect(approve.disabled).toBe(false);

    act(() => {
      approve.click();
    });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(proposal.approvalId, proposal.actionHash);
  });

  it("leaves Approve/Reject controls unchanged for schedule proposals", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const proposal = pendingProposal({
      tool: APPLY_AUTO_SCHEDULE_DAY_TOOL,
      arguments: {
        date: "2026-08-02",
        blocks: [scheduleBlock(0)],
      },
    });

    act(() => {
      root.render(
        createElement(ToolProposalCard, {
          proposal,
          onApprove,
          onReject,
        }),
      );
    });

    const { approve, reject } = approvalButtons(container);
    expect(approve.disabled).toBe(false);
    expect(reject.disabled).toBe(false);

    act(() => {
      approve.click();
      reject.click();
    });

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(proposal.approvalId, proposal.actionHash);
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith(proposal.approvalId, proposal.actionHash);
  });
});
