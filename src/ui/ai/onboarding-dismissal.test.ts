import { describe, expect, it } from "vitest";
import {
  AI_ONBOARDING_DISMISSAL_KEY,
  dismissAiOnboarding,
  isAiOnboardingDismissed,
} from "./onboarding-dismissal";

describe("AI onboarding dismissal key", () => {
  it("uses a versioned non-secret key and round-trips dismissal", () => {
    expect(AI_ONBOARDING_DISMISSAL_KEY).toBe("junban.ai.onboarding.v1.dismissed");
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    expect(isAiOnboardingDismissed(storage)).toBe(false);
    dismissAiOnboarding(storage);
    expect(isAiOnboardingDismissed(storage)).toBe(true);
    expect(store.get(AI_ONBOARDING_DISMISSAL_KEY)).toBe("1");
  });
});
