import { describe, it, expect } from "vitest";
import {
  getRemoteStatusFailureFallback,
  shouldBlockLocalMutations,
} from "../../../src/ui/app/remoteMutationLock.js";

describe("shouldBlockLocalMutations", () => {
  it("keeps startup blocked until desktop remote status is known", () => {
    expect(shouldBlockLocalMutations(true, false, false)).toBe(true);
    expect(shouldBlockLocalMutations(true, true, false)).toBe(false);
  });

  it("stays blocked when initial status resolves as running", () => {
    expect(shouldBlockLocalMutations(true, false, false)).toBe(true);
    expect(shouldBlockLocalMutations(true, true, true)).toBe(true);
  });

  it("unlocks safely when the first packaged-desktop status read fails", () => {
    const fallback = getRemoteStatusFailureFallback(false);

    expect(fallback).toEqual({
      remoteStatusKnown: true,
      remoteServerRunning: false,
    });
    expect(
      shouldBlockLocalMutations(true, fallback.remoteStatusKnown, fallback.remoteServerRunning),
    ).toBe(false);
  });

  it("does not override known remote status on later poll failures", () => {
    expect(getRemoteStatusFailureFallback(true)).toBeNull();
  });
});
