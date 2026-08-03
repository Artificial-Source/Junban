/**
 * Versioned, non-secret local dismissal key for the narrow AI onboarding card.
 * No app-wide wizard framework and no model download state.
 */

export const AI_ONBOARDING_DISMISSAL_KEY = "junban.ai.onboarding.v1.dismissed";

export function isAiOnboardingDismissed(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): boolean {
  try {
    return storage.getItem(AI_ONBOARDING_DISMISSAL_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissAiOnboarding(storage: Pick<Storage, "setItem"> = window.localStorage): void {
  try {
    storage.setItem(AI_ONBOARDING_DISMISSAL_KEY, "1");
  } catch {
    // Best-effort only; private mode may reject writes.
  }
}
