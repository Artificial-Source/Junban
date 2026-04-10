import React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  registerBuiltinComponent,
  resolveBuiltinComponent,
} from "../../../src/ui/context/builtin-views.js";

describe("ui/context/builtin-views", () => {
  it("deduplicates concurrent built-in component resolution", async () => {
    const pluginId = `race-test-${Date.now()}-${Math.random()}`;
    const factory = vi.fn(async () => {
      await Promise.resolve();
      return () => React.createElement("div", null, "ok");
    });

    registerBuiltinComponent(pluginId, factory);

    const [first, second] = await Promise.all([
      resolveBuiltinComponent(pluginId),
      resolveBuiltinComponent(pluginId),
    ]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});
