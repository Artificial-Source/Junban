import { beforeEach, describe, expect, it, vi } from "vitest";

describe("ui/api/direct-services retry behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("clears pending after bootstrap failure so next call can retry", async () => {
    const initError = new Error("init failed");
    const services = { marker: "ok" };

    const bootstrapModule = await import("../../../src/bootstrap-web.js");
    const bootstrapSpy = vi
      .spyOn(bootstrapModule, "bootstrapWeb")
      .mockRejectedValueOnce(initError)
      .mockResolvedValueOnce(services as never);

    const { getServices } = await import("../../../src/ui/api/direct-services.js");

    await expect(getServices()).rejects.toThrow("init failed");
    await expect(getServices()).resolves.toEqual(services);
    expect(bootstrapSpy).toHaveBeenCalledTimes(2);
  });
});
