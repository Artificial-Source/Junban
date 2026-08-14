import { describe, expect, it } from "vitest";
import { isKnownEventType } from "./events";

describe("committed event authority", () => {
  it.each(["plugin.replaced", "plugin.retry_requested"])(
    "recognizes backend plugin event %s",
    (eventType) => {
      expect(isKnownEventType(eventType)).toBe(true);
    },
  );

  it("keeps unknown events on the safe-resync path", () => {
    expect(isKnownEventType("plugin.future_event")).toBe(false);
  });
});
