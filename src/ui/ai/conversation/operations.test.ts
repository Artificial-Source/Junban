import { describe, expect, it } from "vitest";
import {
  ActionKeys,
  ConversationOperations,
  digestUtf8,
  isDefinitiveTerminal,
  terminalFromStreamResult,
  terminalFromThrown,
} from "./operations";
import { createInitialAiRunStreamState } from "../types";

describe("conversation operations identity", () => {
  it("digests text deterministically without retaining raw bodies in keys", () => {
    const a = digestUtf8("hello");
    const b = digestUtf8("hello");
    const c = digestUtf8("hello!");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(ActionKeys.send("s", "hello", null)).toContain(a);
    expect(ActionKeys.send("s", "hello", null)).not.toContain("hello");
  });

  it("changes identity when request bytes or targets change", () => {
    const base = ActionKeys.send("s1", "hi", null);
    expect(ActionKeys.send("s1", "hi", null)).toBe(base);
    expect(ActionKeys.send("s1", "yo", null)).not.toBe(base);
    expect(ActionKeys.send("s2", "hi", null)).not.toBe(base);
    expect(ActionKeys.send("s1", "hi", "task")).not.toBe(base);

    const edit = ActionKeys.edit("s", "m", "t", null);
    expect(ActionKeys.edit("s", "m", "t2", null)).not.toBe(edit);

    const approve = ActionKeys.approve("a", "h1");
    expect(ActionKeys.approve("a", "h2")).not.toBe(approve);
    expect(ActionKeys.reject("a", "h1")).not.toBe(approve);

    expect(ActionKeys.rename("s", "A")).not.toBe(ActionKeys.rename("s", "B"));
    expect(ActionKeys.delete("s1")).not.toBe(ActionKeys.delete("s2"));
    expect(ActionKeys.clear("s1")).not.toBe(ActionKeys.clear("s2"));
    expect(ActionKeys.createSession("New chat")).toBe(ActionKeys.createSession("New chat"));
    expect(ActionKeys.createSession("New chat")).not.toBe(ActionKeys.createSession("Other"));
  });

  it("retains UUID across ambiguous failure and releases on definitive terminal", () => {
    const ops = new ConversationOperations();
    const key = ActionKeys.retry("s", "m");
    const first = ops.retain(key).id;
    expect(ops.retain(key).id).toBe(first);

    expect(
      ops.releaseIfDefinitive(key, {
        kind: "interrupted",
        reason: "eof_without_terminal",
        message: "eof",
      }),
    ).toBe(false);
    expect(ops.retain(key).id).toBe(first);

    expect(
      ops.releaseIfDefinitive(key, {
        kind: "completed",
        assistantMessageId: "asst",
      }),
    ).toBe(true);
    expect(ops.has(key)).toBe(false);
    expect(ops.retain(key).id).not.toBe(first);
  });

  it("releases cancelled and failed terminals and treats null as retain", () => {
    expect(isDefinitiveTerminal({ kind: "cancelled", assistantMessageId: "a" })).toBe(true);
    expect(isDefinitiveTerminal({ kind: "failed", assistantMessageId: null, error: "x" })).toBe(
      true,
    );
    expect(isDefinitiveTerminal(null)).toBe(false);
    expect(isDefinitiveTerminal({ kind: "interrupted", reason: "aborted", message: "a" })).toBe(
      false,
    );

    const ops = new ConversationOperations();
    const key = ActionKeys.regenerate("s", "m");
    const id = ops.retain(key).id;
    ops.releaseIfDefinitive(key, null);
    expect(ops.retain(key).id).toBe(id);
    ops.releaseIfDefinitive(key, { kind: "failed", assistantMessageId: null, error: "boom" });
    expect(ops.retain(key).id).not.toBe(id);
  });

  it("resetDeferredChat drops create/send/briefing only", () => {
    const ops = new ConversationOperations();
    const create = ActionKeys.createSession("New chat");
    const send = ActionKeys.send("s", "hi", null);
    const del = ActionKeys.delete("s");
    const createId = ops.retain(create).id;
    const sendId = ops.retain(send).id;
    const delId = ops.retain(del).id;
    ops.resetDeferredChat();
    expect(ops.retain(create).id).not.toBe(createId);
    expect(ops.retain(send).id).not.toBe(sendId);
    expect(ops.retain(del).id).toBe(delId);
  });

  it("reads terminals from stream results and thrown protocol state", () => {
    const state = createInitialAiRunStreamState();
    state.terminal = { kind: "completed", assistantMessageId: "a" };
    expect(terminalFromStreamResult({ operationId: "op", state })?.kind).toBe("completed");
    expect(terminalFromStreamResult({})).toBeNull();
    const err = Object.assign(new Error("proto"), {
      state: {
        ...createInitialAiRunStreamState(),
        terminal: {
          kind: "interrupted" as const,
          reason: "protocol" as const,
          message: "bad",
        },
      },
    });
    expect(terminalFromThrown(err)?.kind).toBe("interrupted");
  });
});
