/**
 * Pure DTO mapper + UTF-8 offset slicing.
 */
import { describe, expect, it } from "vitest";
import { mapAiMessageDto, mapToolEventsToSegments } from "./message-mapper";
import { utf8ByteOffsetToStringIndex, boundUtf8, utf8ByteLength } from "./utf8";
import type { AiMessageDto } from "./types";

function baseMessage(over: Partial<AiMessageDto> = {}): AiMessageDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    session_id: "22222222-2222-4222-8222-222222222222",
    turn_id: "33333333-3333-4333-8333-333333333333",
    role: "assistant",
    status: "completed",
    sequence: 1,
    content_bytes: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    content: { text: "Hello" },
    ...over,
  };
}

describe("utf8ByteOffsetToStringIndex", () => {
  it("maps ASCII offsets 1:1", () => {
    expect(utf8ByteOffsetToStringIndex("hello", 0)).toBe(0);
    expect(utf8ByteOffsetToStringIndex("hello", 2)).toBe(2);
    expect(utf8ByteOffsetToStringIndex("hello", 5)).toBe(5);
  });

  it("does not split multibyte code points", () => {
    // "é" is 2 UTF-8 bytes, 1 JS code unit
    const text = "aéb"; // bytes: 1 + 2 + 1 = 4
    expect(utf8ByteLength(text)).toBe(4);
    expect(utf8ByteOffsetToStringIndex(text, 1)).toBe(1); // before é
    expect(utf8ByteOffsetToStringIndex(text, 2)).toBe(1); // inside é → stay before
    expect(utf8ByteOffsetToStringIndex(text, 3)).toBe(2); // after é
    expect(utf8ByteOffsetToStringIndex(text, 4)).toBe(3);

    // emoji is 4 UTF-8 bytes, 2 JS code units
    const smile = "x👍y";
    expect(utf8ByteOffsetToStringIndex(smile, 1)).toBe(1);
    expect(utf8ByteOffsetToStringIndex(smile, 2)).toBe(1);
    expect(utf8ByteOffsetToStringIndex(smile, 5)).toBe(3); // after emoji
  });

  it("bounds strings without splitting multibyte chars", () => {
    expect(boundUtf8("aéb", 2)).toBe("a");
    expect(boundUtf8("aéb", 3)).toBe("aé");
  });
});

describe("mapToolEventsToSegments", () => {
  it("interleaves tool events at durable UTF-8 offsets", () => {
    const text = "Hi 👍 world";
    // offset after "Hi " (3 bytes) then after emoji (3+4=7)
    const { segments, proposals } = mapToolEventsToSegments(text, [
      {
        version: 1,
        event_type: "tool_proposed",
        assistant_utf8_offset: 3,
        payload: {
          approval_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          tool: "create_task",
          arguments: { title: "x" },
          action_hash: "a".repeat(64),
          expires_at: "2026-01-01T00:05:00Z",
        },
      },
      {
        version: 1,
        event_type: "tool_result",
        assistant_utf8_offset: 7,
        payload: {
          tool: "create_task",
          outcome: "success",
          data: { ok: true },
          truncated: false,
          operation_id: null,
          revision: 1,
        },
      },
    ]);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.approvalId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(proposals[0]?.actionHash).toHaveLength(64);

    const kinds = segments.map((s) => s.kind);
    expect(kinds[0]).toBe("text");
    expect(segments[0]).toMatchObject({ kind: "text", text: "Hi " });
    expect(kinds).toContain("tool_proposed");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("tool_badge");
    // Remaining text after emoji offset
    const lastText = [...segments].reverse().find((s) => s.kind === "text");
    expect(lastText).toMatchObject({ kind: "text", text: " world" });
  });
});

describe("mapAiMessageDto", () => {
  it("maps user messages with focused_task_id", () => {
    const view = mapAiMessageDto(
      baseMessage({
        role: "user",
        content: {
          text: "Help",
          focused_task_id: "44444444-4444-4444-8444-444444444444",
        },
      }),
    );
    expect(view.role).toBe("user");
    expect(view.focusedTaskId).toBe("44444444-4444-4444-8444-444444444444");
    expect(view.segments).toEqual([{ kind: "text", text: "Help" }]);
  });

  it("maps failed assistant as error with retryable", () => {
    const view = mapAiMessageDto(
      baseMessage({
        status: "failed",
        content: { text: "provider failed" },
      }),
    );
    expect(view.role).toBe("error");
    expect(view.isError).toBe(true);
    expect(view.retryable).toBe(true);
  });

  it("applies approved decision onto proposal", () => {
    const view = mapAiMessageDto(
      baseMessage({
        content: {
          text: "ok",
          tool_events: [
            {
              version: 1,
              event_type: "tool_proposed",
              assistant_utf8_offset: 0,
              payload: {
                approval_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                tool: "complete_task",
                arguments: { task_id: "t1" },
                action_hash: "b".repeat(64),
                expires_at: "2026-01-01T00:05:00Z",
              },
            },
            {
              version: 1,
              event_type: "tool_approved",
              assistant_utf8_offset: 0,
              payload: {
                approval_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              },
            },
          ],
        },
      }),
    );
    expect(view.proposals[0]?.decision).toBe("approved");
  });
});
