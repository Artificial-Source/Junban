/**
 * P6-DOG-001: pending tool proposals stay actionable while the SSE stream is open.
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageView, ChatToolProposal } from "../message-view";
import { MessageBubble } from "./MessageBubble";

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

function assistantWithProposal(proposal: ChatToolProposal): ChatMessageView {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    role: "assistant",
    status: "streaming",
    text: "",
    createdAt: "2026-01-01T00:00:00Z",
    sequence: 1,
    turnId: "33333333-3333-4333-8333-333333333333",
    focusedTaskId: null,
    briefingDate: null,
    segments: [{ kind: "tool_proposed", proposal }],
    proposals: [proposal],
    isError: false,
    retryable: false,
    streaming: true,
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

describe("MessageBubble tool proposal controls (P6-DOG-001)", () => {
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

  it("keeps Approve/Reject enabled for a pending proposal while streaming", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const proposal = pendingProposal();

    act(() => {
      root.render(
        createElement(MessageBubble, {
          message: assistantWithProposal(proposal),
          isLatest: true,
          isStreaming: true,
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

  it("disables Approve/Reject while a decision is in flight", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const proposal = pendingProposal({ decisionPending: true });

    act(() => {
      root.render(
        createElement(MessageBubble, {
          message: assistantWithProposal(proposal),
          isLatest: true,
          isStreaming: true,
          onApprove,
          onReject,
        }),
      );
    });

    const { approve, reject } = approvalButtons(container);
    expect(approve.disabled).toBe(true);
    expect(reject.disabled).toBe(true);

    act(() => {
      approve.click();
      reject.click();
    });

    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });
});
