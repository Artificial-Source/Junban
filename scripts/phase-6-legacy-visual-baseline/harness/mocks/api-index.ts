import { readFixture } from "./read-fixture";

export const api = {
  getAppSetting: async (key: string): Promise<string | null> => {
    const fixture = readFixture();
    if (key === "ai_daily_briefing") {
      return fixture.dailyBriefing ? "on" : "off";
    }
    return null;
  },
  setAppSetting: async () => undefined,
  getAiMemories: async () => [],
  deleteAiMemory: async () => undefined,
  deleteAllAiMemories: async () => undefined,
  updateAiMemory: async () => undefined,
};
