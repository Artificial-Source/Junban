import { describe, expect, it } from "vitest";
import {
  isPhase6LocalVoiceAcceptance,
  PHASE6_LOCAL_VOICE_ACCEPTANCE_ID,
  phase6LocalVoiceAcceptancePath,
} from "./phase6LocalVoiceAcceptance";

describe("phase6LocalVoiceAcceptance gate", () => {
  it("accepts only the exact allowlisted query value", () => {
    expect(isPhase6LocalVoiceAcceptance("?acceptance=phase-6-local-voice")).toBe(true);
    expect(isPhase6LocalVoiceAcceptance(phase6LocalVoiceAcceptancePath().slice(1))).toBe(true);
  });

  it("fails closed for ordinary navigation and unknown values", () => {
    expect(isPhase6LocalVoiceAcceptance("")).toBe(false);
    expect(isPhase6LocalVoiceAcceptance("?")).toBe(false);
    expect(isPhase6LocalVoiceAcceptance("/settings/voice")).toBe(false);
    expect(isPhase6LocalVoiceAcceptance("?acceptance=1")).toBe(false);
    expect(isPhase6LocalVoiceAcceptance("?acceptance=phase-6")).toBe(false);
    expect(isPhase6LocalVoiceAcceptance("?visual-fixture=phase-6")).toBe(false);
    expect(isPhase6LocalVoiceAcceptance("?acceptance=phase-6-local-voice&extra=1")).toBe(true);
  });

  it("exports a stable non-secret id", () => {
    expect(PHASE6_LOCAL_VOICE_ACCEPTANCE_ID).toBe("phase-6-local-voice");
    expect(phase6LocalVoiceAcceptancePath()).toBe("/?acceptance=phase-6-local-voice");
  });
});
