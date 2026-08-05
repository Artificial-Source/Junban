/**
 * Explicit Phase 6 Wave 5 local-voice acceptance gate.
 *
 * Activated only by `acceptance=phase-6-local-voice`. Outside this exact
 * query value every helper returns false/null and must not change ordinary
 * startup, navigation, CSP, or chunk loading.
 */

const ACCEPTANCE_VALUE = "phase-6-local-voice";

function parseSearch(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
}

/**
 * True only when the exact allowlisted acceptance query is present.
 * Unknown acceptance values fail closed.
 */
export function isPhase6LocalVoiceAcceptance(
  search: string = typeof window !== "undefined" ? window.location.search : "",
): boolean {
  return parseSearch(search).get("acceptance") === ACCEPTANCE_VALUE;
}

/** Canonical query fragment for the opt-in harness (no secrets). */
export function phase6LocalVoiceAcceptancePath(): string {
  return `/?acceptance=${ACCEPTANCE_VALUE}`;
}

export const PHASE6_LOCAL_VOICE_ACCEPTANCE_ID = ACCEPTANCE_VALUE;
