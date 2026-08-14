import { describe, expect, it, vi } from "vitest";
import {
  isLocalSttSelected,
  isLocalTtsSelected,
  resolveSttReady,
  resolveTtsAvailable,
} from "./voice-capabilities";
import type { ConfirmedVoiceSettings, LocalSttAdapter, LocalTtsAdapter } from "./types";

vi.mock("./browser-stt", () => ({
  isBrowserSttAvailable: () => true,
}));
vi.mock("./browser-tts", () => ({
  isBrowserTtsAvailable: () => true,
}));

const browserSettings: ConfirmedVoiceSettings = {
  cloud_speech_enabled: false,
  grace_period_ms: 500,
  stt_provider: "browser",
  stt_model: null,
  tts_provider: "browser",
  tts_model: null,
  tts_voice: null,
  stt_credential_id: null,
  tts_credential_id: null,
  tts_enabled: true,
  voice_mode: "push_to_talk",
};

function stt(status: LocalSttAdapter["status"]): LocalSttAdapter {
  return {
    status,
    async transcribe() {
      return "";
    },
    dispose() {},
  };
}

function tts(status: LocalTtsAdapter["status"]): LocalTtsAdapter {
  return {
    status,
    async speak() {},
    cancel() {},
    dispose() {},
  };
}

describe("voice capabilities local/cloud/browser", () => {
  it("treats adapter presence as explicit local selection", () => {
    expect(isLocalSttSelected(null)).toBe(false);
    expect(isLocalSttSelected(stt("loading"))).toBe(true);
    expect(isLocalTtsSelected(tts("error"))).toBe(true);
  });

  it("does not fall back to browser when local is selected but not ready", () => {
    expect(resolveSttReady(browserSettings, stt("loading"), false)).toBe(false);
    expect(resolveSttReady(browserSettings, stt("error"), false)).toBe(false);
    expect(resolveSttReady(browserSettings, stt("unavailable"), false)).toBe(false);
    expect(resolveSttReady(browserSettings, stt("ready"), false)).toBe(true);
    expect(resolveSttReady(browserSettings, null, false)).toBe(true);

    expect(resolveTtsAvailable(browserSettings, tts("loading"), false)).toBe(false);
    expect(resolveTtsAvailable(browserSettings, tts("ready"), false)).toBe(true);
    expect(resolveTtsAvailable(browserSettings, null, false)).toBe(true);
  });

  it("cloud confirmed is ready without consulting local adapters", () => {
    const cloud: ConfirmedVoiceSettings = {
      ...browserSettings,
      cloud_speech_enabled: true,
      stt_provider: "openai",
      tts_provider: "groq",
    };
    // Even if a local adapter were somehow passed, cloud path wins for readiness.
    expect(resolveSttReady(cloud, stt("ready"), false)).toBe(true);
    expect(resolveTtsAvailable(cloud, tts("ready"), false)).toBe(true);
  });
});
