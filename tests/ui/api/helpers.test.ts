import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/utils/tauri.js", () => ({
  isTauri: () => false,
}));

import { buildApiUrl } from "../../../src/ui/api/helpers.js";

describe("buildApiUrl", () => {
  it("builds relative API URLs with query params", () => {
    expect(
      buildApiUrl("/tasks", {
        search: "buy milk",
        status: "pending",
      }),
    ).toBe("/api/tasks?search=buy+milk&status=pending");
  });

  it("omits undefined params", () => {
    expect(
      buildApiUrl("/stats/daily", {
        startDate: "2026-04-01",
        endDate: undefined,
      }),
    ).toBe("/api/stats/daily?startDate=2026-04-01");
  });
});
