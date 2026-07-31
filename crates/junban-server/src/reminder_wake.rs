//! Process-global reminder wake coordinator and ephemeral reminder SSE.
//!
//! One loop sleeps until the next control-plane wake instant from
//! `TaskService::next_reminder_wake_at`, broadcasts a content-free
//! `reminders_due` signal, and recomputes when `Notify` fires after user
//! mutations or reminder control-plane writes. Overdue rows without a browser
//! owner cannot busy-loop: after each due broadcast the loop waits at least
//! [`REMINDER_OVERDUE_WAKE_THROTTLE`] unless notified of a state change.
//!
//! Wake events are ephemeral process-local signals. They are not committed task
//! events and never increment the global revision.

use std::{
    convert::Infallible,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use futures_core::Stream;
use jiff::{SignedDuration, Timestamp};
use serde::Serialize;
use tokio::{
    sync::{Notify, broadcast, mpsc},
    task::JoinHandle,
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use utoipa::ToSchema;

use crate::sse::{AppService, ForwarderGuard, SseConnectionPermit};

/// After broadcasting a due wake, wait at least this long before rebroadcasting
/// the same overdue set unless a state-changing notification arrives.
pub const REMINDER_OVERDUE_WAKE_THROTTLE: Duration = Duration::from_secs(30);

/// SSE event name for ephemeral reminder wakes (not a committed task event).
pub const REMINDER_WAKE_EVENT_TYPE: &str = "reminders_due";

const REMINDER_WAKE_BROADCAST_CAPACITY: usize = 64;
const REMINDER_SSE_QUEUE_CAPACITY: usize = 16;

/// Ephemeral wake payload for `/api/v1/reminders/events`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ReminderWakeEventDto {
    /// Monotonic process-local sequence. Not a durable revision.
    pub sequence: u64,
    /// Server clock sample for the signal, RFC3339 UTC.
    #[schema(value_type = String, format = DateTime)]
    pub server_now: Timestamp,
}

/// Bounded wake broadcast plus coordinator recompute notifications.
#[derive(Debug)]
pub struct ReminderWakeHub {
    sender: broadcast::Sender<ReminderWakeEventDto>,
    notify: Notify,
    sequence: AtomicU64,
}

impl ReminderWakeHub {
    #[must_use]
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(REMINDER_WAKE_BROADCAST_CAPACITY);
        Self {
            sender,
            notify: Notify::new(),
            sequence: AtomicU64::new(0),
        }
    }

    /// Wake the coordinator so it re-reads the next wake instant.
    pub fn notify_recompute(&self) {
        // There is exactly one coordinator. `notify_one` stores a permit when
        // it is between polls, so a mutation cannot be lost in that window.
        self.notify.notify_one();
    }

    /// Subscribe before work so concurrent publishes stay queued.
    pub fn subscribe(&self) -> broadcast::Receiver<ReminderWakeEventDto> {
        self.sender.subscribe()
    }

    /// Latest published sequence (0 if none yet).
    #[must_use]
    pub fn latest_sequence(&self) -> u64 {
        self.sequence.load(Ordering::SeqCst)
    }

    /// Snapshot for immediate-connect and coalesced-lag delivery (no sequence bump).
    #[must_use]
    pub fn snapshot_wake(&self) -> ReminderWakeEventDto {
        ReminderWakeEventDto {
            sequence: self.latest_sequence(),
            server_now: Timestamp::now(),
        }
    }

    /// Publish a new due wake to all reminder SSE subscribers.
    pub fn publish_due_wake(&self) -> ReminderWakeEventDto {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let wake = ReminderWakeEventDto {
            sequence,
            server_now: Timestamp::now(),
        };
        // Zero subscribers is normal when no browser owns delivery.
        let _ = self.sender.send(wake.clone());
        wake
    }

    pub(crate) fn notified(&self) -> tokio::sync::futures::Notified<'_> {
        self.notify.notified()
    }
}

impl Default for ReminderWakeHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Tokio-time-aligned clock so paused-time tests advance `now` with sleeps.
#[derive(Debug, Clone)]
struct CoordinatorClock {
    origin_ts: Timestamp,
    origin_instant: Instant,
}

impl CoordinatorClock {
    fn new() -> Self {
        Self {
            origin_ts: Timestamp::now(),
            origin_instant: Instant::now(),
        }
    }

    fn now(&self) -> Timestamp {
        let elapsed = Instant::now().saturating_duration_since(self.origin_instant);
        self.origin_ts
            .checked_add(elapsed)
            .unwrap_or(self.origin_ts)
    }
}

fn sleep_duration_until(now: Timestamp, target: Timestamp) -> Duration {
    let signed = now.duration_until(target);
    if signed.is_negative() || signed == SignedDuration::ZERO {
        Duration::ZERO
    } else {
        Duration::try_from(signed).unwrap_or(Duration::from_secs(u64::MAX / 4))
    }
}

/// Run until `shutdown` is cancelled. Does not spawn; caller owns the task.
pub async fn run_reminder_coordinator(
    service: AppService,
    hub: Arc<ReminderWakeHub>,
    shutdown: CancellationToken,
) {
    let clock = CoordinatorClock::new();
    loop {
        // Register before querying, then check again afterwards. A stored
        // mutation permit is consumed before the query; a mutation racing the
        // query restarts it before any wake is published. This avoids both
        // lost recomputes and duplicate overdue wakes.
        let notified = hub.notified();
        tokio::pin!(notified);
        if notified.as_mut().enable() {
            continue;
        }

        if shutdown.is_cancelled() {
            return;
        }

        let next = match service.next_reminder_wake_at().await {
            Ok(next) => next,
            Err(error) => {
                tracing::warn!(%error, "reminder wake query failed");
                tokio::select! {
                    biased;
                    () = shutdown.cancelled() => return,
                    () = &mut notified => continue,
                    () = tokio::time::sleep(Duration::from_secs(5)) => continue,
                }
            }
        };
        if notified.as_mut().enable() {
            continue;
        }

        let now = clock.now();
        match next {
            Some(wake_at) if wake_at <= now => {
                hub.publish_due_wake();
                tokio::select! {
                    biased;
                    () = shutdown.cancelled() => return,
                    () = &mut notified => {}
                    () = tokio::time::sleep(REMINDER_OVERDUE_WAKE_THROTTLE) => {}
                }
            }
            Some(wake_at) => {
                let delay = sleep_duration_until(now, wake_at);
                tokio::select! {
                    biased;
                    () = shutdown.cancelled() => return,
                    () = &mut notified => {}
                    () = tokio::time::sleep(delay) => {}
                }
            }
            None => {
                tokio::select! {
                    biased;
                    () = shutdown.cancelled() => return,
                    () = notified => {}
                }
            }
        }
    }
}

/// Spawn the single process-global coordinator. Router tests must not call this.
#[must_use]
pub fn start_reminder_coordinator(
    service: AppService,
    hub: Arc<ReminderWakeHub>,
    shutdown: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(run_reminder_coordinator(service, hub, shutdown))
}

struct ReminderChannelStream {
    receiver: mpsc::Receiver<Result<SseEvent, Infallible>>,
    _permit: SseConnectionPermit,
}

impl Stream for ReminderChannelStream {
    type Item = Result<SseEvent, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(context)
    }
}

/// Authenticated ephemeral reminder wake stream. Shares the global SSE cap.
pub fn open_reminder_sse_stream(
    hub: Arc<ReminderWakeHub>,
    live: broadcast::Receiver<ReminderWakeEventDto>,
    shutdown: CancellationToken,
    permit: SseConnectionPermit,
    active_forwarders: Arc<AtomicUsize>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let (sender, stream_receiver) = mpsc::channel(REMINDER_SSE_QUEUE_CAPACITY);
    let forwarder_guard = ForwarderGuard::enter(active_forwarders);
    tokio::spawn(async move {
        let _forwarder_guard = forwarder_guard;
        forward_reminder_wakes(hub, live, sender, shutdown).await;
    });

    Sse::new(ReminderChannelStream {
        receiver: stream_receiver,
        _permit: permit,
    })
    .keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
}

async fn forward_reminder_wakes(
    hub: Arc<ReminderWakeHub>,
    mut live: broadcast::Receiver<ReminderWakeEventDto>,
    sender: mpsc::Sender<Result<SseEvent, Infallible>>,
    shutdown: CancellationToken,
) {
    // Immediate wake so a newly connected owner need not wait out the throttle.
    if !send_reminder_wake(&sender, &hub.snapshot_wake(), &shutdown).await {
        return;
    }

    loop {
        let received = tokio::select! {
            biased;
            () = sender.closed() => return,
            () = shutdown.cancelled() => return,
            result = live.recv() => result,
        };
        let mut wake = match received {
            Ok(wake) => wake,
            Err(broadcast::error::RecvError::Lagged(_)) => hub.snapshot_wake(),
            Err(broadcast::error::RecvError::Closed) => return,
        };
        // Collapse any already-queued wakes so a slow client gets one signal.
        wake = coalesce_ready_wakes(&mut live, &hub, wake);
        if !send_reminder_wake(&sender, &wake, &shutdown).await {
            return;
        }
    }
}

fn coalesce_ready_wakes(
    live: &mut broadcast::Receiver<ReminderWakeEventDto>,
    hub: &ReminderWakeHub,
    mut latest: ReminderWakeEventDto,
) -> ReminderWakeEventDto {
    loop {
        match live.try_recv() {
            Ok(wake) => latest = wake,
            Err(broadcast::error::TryRecvError::Lagged(_)) => latest = hub.snapshot_wake(),
            Err(broadcast::error::TryRecvError::Empty | broadcast::error::TryRecvError::Closed) => {
                return latest;
            }
        }
    }
}

async fn send_reminder_wake(
    sender: &mpsc::Sender<Result<SseEvent, Infallible>>,
    wake: &ReminderWakeEventDto,
    shutdown: &CancellationToken,
) -> bool {
    let Ok(data) = serde_json::to_string(wake) else {
        return false;
    };
    let message = Ok(SseEvent::default()
        .id(wake.sequence.to_string())
        .event(REMINDER_WAKE_EVENT_TYPE)
        .data(data));
    tokio::select! {
        biased;
        () = sender.closed() => return false,
        () = shutdown.cancelled() => return false,
        result = sender.send(message) => {
            if result.is_err() {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_sequence_is_monotonic_and_snapshot_does_not_bump() {
        let hub = ReminderWakeHub::new();
        assert_eq!(hub.latest_sequence(), 0);
        assert_eq!(hub.snapshot_wake().sequence, 0);
        assert_eq!(hub.publish_due_wake().sequence, 1);
        assert_eq!(hub.publish_due_wake().sequence, 2);
        assert_eq!(hub.snapshot_wake().sequence, 2);
        assert_eq!(hub.latest_sequence(), 2);
    }

    #[test]
    fn sleep_duration_until_handles_past_and_future() {
        let now: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();
        let past: Timestamp = "2026-07-28T11:59:00Z".parse().unwrap();
        let future: Timestamp = "2026-07-28T12:01:30Z".parse().unwrap();
        assert_eq!(sleep_duration_until(now, past), Duration::ZERO);
        assert_eq!(sleep_duration_until(now, now), Duration::ZERO);
        assert_eq!(sleep_duration_until(now, future), Duration::from_secs(90));
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn pause_advances_spawned_sleep_and_cancel_token() {
        // Yield so the runtime is fully installed before spawning.
        tokio::task::yield_now().await;

        let token = CancellationToken::new();
        let child = token.clone();
        let handle = tokio::spawn(async move {
            tokio::select! {
                () = child.cancelled() => "cancelled",
                () = tokio::time::sleep(Duration::from_secs(30)) => "slept",
            }
        });
        // Drive the spawned task to the select.
        tokio::task::yield_now().await;
        token.cancel();
        // With paused time, drive until the join completes without a wall sleep.
        let result = handle.await.unwrap();
        assert_eq!(result, "cancelled");

        let handle = tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            7
        });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(30)).await;
        assert_eq!(handle.await.unwrap(), 7);
    }
}
