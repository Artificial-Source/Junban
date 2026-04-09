import { describe, expect, it } from "vitest";
import { expectRpcOptionalString } from "../../src/plugins/timeblocking-rpc-validation.js";

describe("expectRpcOptionalString", () => {
  it("accepts undefined/null and returns undefined", () => {
    expect(expectRpcOptionalString([], 0, "date")).toEqual({ ok: true, value: undefined });
    expect(expectRpcOptionalString([null], 0, "date")).toEqual({ ok: true, value: undefined });
  });

  it("accepts strings", () => {
    expect(expectRpcOptionalString(["2026-01-10"], 0, "date")).toEqual({
      ok: true,
      value: "2026-01-10",
    });
  });

  it("rejects non-string values when provided", () => {
    expect(expectRpcOptionalString([123], 0, "date")).toEqual({
      ok: false,
      error: "date (args[0]) must be a string when provided",
    });
  });
});
