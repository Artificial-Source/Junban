/**
 * Browser reminder owner/delivery client.
 *
 * After authenticated app load: one random client id, fenced lease
 * acquire/renew/release, wake-only SSE, claim due work, present via
 * Notification (when granted) or in-app toast, optional WebAudio after user
 * activation, settle delivered only after presentation succeeds.
 *
 * Control-plane calls never send idempotency keys. Delivery is at-least-once
 * across crash-before-ack. No polling loop.
 */
import { useEffect, useRef } from "react";
import {
  acquireReminderLease,
  claimDueReminders,
  getTask,
  markOwnerLostReminders,
  releaseReminderLease,
  renewReminderLease,
  settleReminderDelivered,
  settleReminderFailed,
  subscribeReminderWakes,
  type ClaimedReminderDto,
  type ReminderChannelDto,
  type ReminderFailureCodeDto,
} from "../api/client";

export const REMINDER_LEASE_SECS = 90;
export const REMINDER_RENEW_INTERVAL_MS = 30_000;
export const REMINDER_CLAIM_LIMIT = 20;

export type ReminderPresentation = {
  taskId: string;
  title: string;
  remindAt: string;
};

export type UseReminderDeliveryOptions = {
  enabled: boolean;
  onInApp: (reminder: ReminderPresentation) => void | Promise<void>;
  /** Optional short sound after user activation; never required for delivery. */
  playSound?: () => void | Promise<void>;
  soundEnabled?: boolean;
};

function createClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `reminder-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function presentBrowserNotification(title: string): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission !== "granted") return false;
  try {
    // Construction is the presentation signal for web notifications.
    new Notification("Junban Reminder", { body: title });
    return true;
  } catch {
    return false;
  }
}

/**
 * Request notification permission without blocking the caller.
 * Returns the resulting permission string.
 */
export function requestNotificationPermissionNonBlocking(): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "default") return;
  try {
    void Notification.requestPermission();
  } catch {
    // Ignore — toast delivery remains available.
  }
}

export function useReminderDelivery({
  enabled,
  onInApp,
  playSound,
  soundEnabled = false,
}: UseReminderDeliveryOptions): void {
  const onInAppRef = useRef(onInApp);
  const playSoundRef = useRef(playSound);
  const soundEnabledRef = useRef(soundEnabled);
  onInAppRef.current = onInApp;
  playSoundRef.current = playSound;
  soundEnabledRef.current = soundEnabled;

  const clientIdRef = useRef<string | null>(null);
  clientIdRef.current ??= createClientId();

  useEffect(() => {
    if (!enabled) return;

    let mounted = true;
    let fenceTerm: string | null = null;
    let renewTimer: ReturnType<typeof setInterval> | null = null;
    let claimInFlight = false;
    let stopWakes: (() => void) | null = null;

    const clearRenew = () => {
      if (renewTimer !== null) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
    };

    const release = async () => {
      const term = fenceTerm;
      fenceTerm = null;
      clearRenew();
      if (!term) return;
      try {
        await releaseReminderLease({ fence_term: term });
      } catch {
        // Best-effort release on teardown.
      }
    };

    const settleDelivered = async (
      reminder: ClaimedReminderDto,
      channel: ReminderChannelDto,
      term: string,
    ) => {
      await settleReminderDelivered({
        fence_term: term,
        task_id: reminder.task_id,
        remind_at: reminder.remind_at,
        claim_attempt: reminder.claim_attempt,
        channel,
      });
    };

    const settleFailed = async (
      reminder: ClaimedReminderDto,
      error: ReminderFailureCodeDto,
      term: string,
    ) => {
      await settleReminderFailed({
        fence_term: term,
        task_id: reminder.task_id,
        remind_at: reminder.remind_at,
        claim_attempt: reminder.claim_attempt,
        error,
      });
    };

    const deliverOne = async (reminder: ClaimedReminderDto, term: string) => {
      let title = "Reminder";
      try {
        const task = await getTask(reminder.task_id);
        title = task.title;
      } catch {
        // Presentation can still proceed with a generic title.
      }

      let channel: ReminderChannelDto | null = null;
      try {
        const notified = await presentBrowserNotification(title);
        if (notified) {
          channel = "web_notification";
        } else {
          await onInAppRef.current({
            taskId: reminder.task_id,
            title,
            remindAt: reminder.remind_at,
          });
          channel = "in_app";
        }

        if (soundEnabledRef.current && playSoundRef.current) {
          try {
            await playSoundRef.current();
          } catch {
            // Sound is optional and never required for delivery ack.
          }
        }

        await settleDelivered(reminder, channel, term);
      } catch {
        try {
          await settleFailed(reminder, "channel_failed", term);
        } catch {
          // Claim expiry remains authoritative.
        }
      }
    };

    const claimAndDeliver = async () => {
      if (!mounted || !fenceTerm || claimInFlight) return;
      claimInFlight = true;
      const term = fenceTerm;
      try {
        const { reminders } = await claimDueReminders({
          fence_term: term,
          limit: REMINDER_CLAIM_LIMIT,
        });
        if (!mounted || fenceTerm !== term) return;
        for (const reminder of reminders) {
          if (!mounted || fenceTerm !== term) return;
          await deliverOne(reminder, term);
        }
      } catch (caught) {
        // Stale fence / owner lost → recover and reacquire.
        const message = caught instanceof Error ? caught.message : "";
        if (/owner|fence|lease|stale/i.test(message) && fenceTerm === term) {
          try {
            await markOwnerLostReminders({ fence_term: term });
          } catch {
            // ignore
          }
          fenceTerm = null;
          clearRenew();
          await acquire();
        }
      } finally {
        claimInFlight = false;
      }
    };

    const startRenew = () => {
      clearRenew();
      renewTimer = setInterval(() => {
        void (async () => {
          if (!mounted || !fenceTerm) return;
          const term = fenceTerm;
          try {
            const lease = await renewReminderLease({
              fence_term: term,
              lease_secs: REMINDER_LEASE_SECS,
            });
            if (!mounted) return;
            fenceTerm = lease.fence_term;
          } catch {
            if (fenceTerm === term) {
              fenceTerm = null;
              clearRenew();
              await acquire();
            }
          }
        })();
      }, REMINDER_RENEW_INTERVAL_MS);
    };

    const acquire = async () => {
      if (!mounted || fenceTerm) return;
      let acquiredTerm: string | null = null;
      const releaseAcquired = async () => {
        const term = acquiredTerm;
        acquiredTerm = null;
        if (!term) return;
        try {
          await releaseReminderLease({ fence_term: term });
        } catch {
          // Best-effort release after failed recovery or teardown.
        }
      };

      try {
        const lease = await acquireReminderLease({ lease_secs: REMINDER_LEASE_SECS });
        acquiredTerm = lease.fence_term;
        if (!mounted) {
          await releaseAcquired();
          return;
        }

        // A new fence may have inherited claims from a browser that crashed
        // before settling them. Recover those rows before any new claim.
        await markOwnerLostReminders({ fence_term: acquiredTerm });
        if (!mounted) {
          await releaseAcquired();
          return;
        }

        fenceTerm = acquiredTerm;
        acquiredTerm = null;
        startRenew();
        await claimAndDeliver();
      } catch {
        await releaseAcquired();
        // A later wake will retry acquisition.
      }
    };

    void acquire();
    stopWakes = subscribeReminderWakes(() => {
      if (!mounted) return;
      if (!fenceTerm) {
        void acquire();
        return;
      }
      void claimAndDeliver();
    });

    const onPageHide = () => {
      void release();
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      mounted = false;
      window.removeEventListener("pagehide", onPageHide);
      stopWakes?.();
      void release();
    };
  }, [enabled]);
}
