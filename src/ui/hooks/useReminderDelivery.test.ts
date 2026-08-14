/**
 * Reminder lease/claim/settle + channel-gated presentation with fake timers.
 * Control-plane paths never send Idempotency-Key (covered by client tests too).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { renderHook } from "./test-utils";

const acquireReminderLease = vi.fn();
const renewReminderLease = vi.fn();
const releaseReminderLease = vi.fn();
const claimDueReminders = vi.fn();
const settleReminderDelivered = vi.fn();
const settleReminderFailed = vi.fn();
const markOwnerLostReminders = vi.fn();
const getTask = vi.fn();
const subscribeReminderWakes = vi.fn();

vi.mock("../api/client", () => ({
  acquireReminderLease: (...args: unknown[]) => acquireReminderLease(...args),
  renewReminderLease: (...args: unknown[]) => renewReminderLease(...args),
  releaseReminderLease: (...args: unknown[]) => releaseReminderLease(...args),
  claimDueReminders: (...args: unknown[]) => claimDueReminders(...args),
  settleReminderDelivered: (...args: unknown[]) => settleReminderDelivered(...args),
  settleReminderFailed: (...args: unknown[]) => settleReminderFailed(...args),
  markOwnerLostReminders: (...args: unknown[]) => markOwnerLostReminders(...args),
  getTask: (...args: unknown[]) => getTask(...args),
  subscribeReminderWakes: (...args: unknown[]) => subscribeReminderWakes(...args),
}));

import { presentReminderChannels, useReminderDelivery } from "./useReminderDelivery";

describe("presentReminderChannels", () => {
  it("only attempts web notification when allowed", async () => {
    const tryWeb = vi.fn().mockResolvedValue(true);
    const onInApp = vi.fn();
    const result = await presentReminderChannels({
      title: "Ship",
      allowedChannels: ["in_app"],
      soundEnabled: false,
      onInApp,
      tryWebNotification: tryWeb,
    });
    expect(tryWeb).not.toHaveBeenCalled();
    expect(onInApp).toHaveBeenCalled();
    expect(result).toEqual({ channel: "in_app" });
  });

  it("acks web_notification when that channel presents", async () => {
    const result = await presentReminderChannels({
      title: "Ship",
      allowedChannels: ["web_notification", "in_app"],
      soundEnabled: false,
      onInApp: vi.fn(),
      tryWebNotification: async () => true,
    });
    expect(result).toEqual({ channel: "web_notification" });
  });

  it("allows sound as the sole successful delivery channel", async () => {
    const result = await presentReminderChannels({
      title: "Ship",
      allowedChannels: ["sound"],
      soundEnabled: true,
      onInApp: vi.fn(),
      playSound: async () => true,
      tryWebNotification: async () => true,
    });
    expect(result).toEqual({ channel: "sound" });
  });

  it("never acks a channel that was not presented and fails when none succeed", async () => {
    const onInApp = vi.fn();
    const result = await presentReminderChannels({
      title: "Ship",
      allowedChannels: ["web_notification", "sound"],
      soundEnabled: true,
      onInApp,
      playSound: async () => false,
      tryWebNotification: async () => false,
    });
    expect(onInApp).not.toHaveBeenCalled();
    expect(result).toEqual({ failed: true });
  });

  it("does not treat locked audio as presentation", async () => {
    const result = await presentReminderChannels({
      title: "Ship",
      allowedChannels: ["sound"],
      soundEnabled: true,
      onInApp: vi.fn(),
      playSound: async () => false,
    });
    expect(result).toEqual({ failed: true });
  });
});

describe("useReminderDelivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    acquireReminderLease.mockReset();
    renewReminderLease.mockReset();
    releaseReminderLease.mockReset();
    claimDueReminders.mockReset();
    settleReminderDelivered.mockReset();
    settleReminderFailed.mockReset();
    markOwnerLostReminders.mockReset();
    getTask.mockReset();
    subscribeReminderWakes.mockReset();

    acquireReminderLease.mockResolvedValue({
      fence_term: "fence-1",
      expires_at: "2026-07-23T10:31:30Z",
      updated_at: "2026-07-23T10:30:00Z",
    });
    claimDueReminders.mockResolvedValue({
      reminders: [
        {
          task_id: "task-1",
          remind_at: "2026-07-23T10:29:00Z",
          claim_term: "claim-1",
          claim_attempt: 1,
          claim_expires_at: "2026-07-23T10:31:30Z",
        },
      ],
    });
    getTask.mockResolvedValue({
      id: "task-1",
      title: "Ship docs",
      description: "",
      status: "pending",
      tag_ids: [],
      someday: false,
      revision: 1,
      sort_order: 0,
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
    });
    settleReminderDelivered.mockResolvedValue(undefined);
    settleReminderFailed.mockResolvedValue(undefined);
    releaseReminderLease.mockResolvedValue(undefined);
    subscribeReminderWakes.mockImplementation(() => () => undefined);

    // No Notification API → toast fallback path.
    // @ts-expect-error test override
    delete globalThis.Notification;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquires, claims, presents via toast fallback, and settles delivered", async () => {
    const onInApp = vi.fn().mockResolvedValue(undefined);

    const { result: _result } = renderHook(() =>
      useReminderDelivery({
        enabled: true,
        onInApp,
        allowedChannels: ["in_app"],
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(acquireReminderLease).toHaveBeenCalledWith({ lease_secs: 90 });
    expect(claimDueReminders).toHaveBeenCalledWith({
      fence_term: "fence-1",
      limit: 20,
    });
    expect(onInApp).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", title: "Ship docs" }),
    );
    expect(settleReminderDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        fence_term: "fence-1",
        task_id: "task-1",
        claim_attempt: 1,
        channel: "in_app",
      }),
    );
    expect(settleReminderFailed).not.toHaveBeenCalled();
  });

  it("recovers expired claims before a replacement owner claims for redelivery", async () => {
    const onInApp = vi.fn().mockResolvedValue(undefined);
    markOwnerLostReminders.mockResolvedValue({ marked: 1 });

    renderHook(() =>
      useReminderDelivery({
        enabled: true,
        onInApp,
        allowedChannels: ["in_app"],
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(markOwnerLostReminders).toHaveBeenCalledWith({ fence_term: "fence-1" });
    expect(markOwnerLostReminders.mock.invocationCallOrder[0]).toBeLessThan(
      claimDueReminders.mock.invocationCallOrder[0]!,
    );
    expect(onInApp).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", title: "Ship docs" }),
    );
  });

  it("settles failed when presentation throws", async () => {
    const onInApp = vi.fn().mockRejectedValue(new Error("toast failed"));

    renderHook(() =>
      useReminderDelivery({
        enabled: true,
        onInApp,
        allowedChannels: ["in_app"],
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(settleReminderFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        fence_term: "fence-1",
        task_id: "task-1",
        claim_attempt: 1,
        error: "channel_failed",
      }),
    );
    expect(settleReminderDelivered).not.toHaveBeenCalled();
  });

  it("settles failed when no permitted channel can present", async () => {
    renderHook(() =>
      useReminderDelivery({
        enabled: true,
        onInApp: vi.fn(),
        allowedChannels: ["web_notification"],
        soundEnabled: false,
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(settleReminderFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "channel_failed",
      }),
    );
    expect(settleReminderDelivered).not.toHaveBeenCalled();
  });

  it("renews the lease on the 30s timer", async () => {
    renewReminderLease.mockResolvedValue({
      fence_term: "fence-2",
      expires_at: "2026-07-23T10:32:00Z",
      updated_at: "2026-07-23T10:30:30Z",
    });
    claimDueReminders.mockResolvedValue({ reminders: [] });

    renderHook(() =>
      useReminderDelivery({
        enabled: true,
        onInApp: vi.fn(),
        allowedChannels: ["in_app"],
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renewReminderLease).toHaveBeenCalledWith({
      fence_term: "fence-1",
      lease_secs: 90,
    });
  });
});
