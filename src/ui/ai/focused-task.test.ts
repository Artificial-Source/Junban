import { describe, expect, it } from "vitest";
import { aiChatFocusedTaskUrl, readFocusedTaskId, readFocusedTaskPrompt } from "./focused-task";

const UUID = "01234567-0123-4123-8123-0123456789ab";

describe("focused task query helpers", () => {
  it("accepts only valid UUIDs", () => {
    expect(readFocusedTaskId(`?focusedTaskId=${UUID}`)).toBe(UUID);
    expect(readFocusedTaskId("?focusedTaskId=not-a-uuid")).toBeNull();
    expect(readFocusedTaskId("")).toBeNull();
  });

  it("reads optional concrete prompt", () => {
    expect(readFocusedTaskPrompt(`?focusedTaskId=${UUID}&prompt=Plan+this`)).toBe("Plan this");
    expect(readFocusedTaskPrompt(`?focusedTaskId=${UUID}`)).toBeNull();
  });

  it("builds canonical launch URL", () => {
    expect(aiChatFocusedTaskUrl(UUID)).toBe(`/ai-chat?focusedTaskId=${UUID}`);
    expect(aiChatFocusedTaskUrl(UUID, "Help")).toBe(`/ai-chat?focusedTaskId=${UUID}&prompt=Help`);
  });
});
