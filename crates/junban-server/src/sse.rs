//! Authenticated SSE delivery with durable multi-page catch-up and shutdown cancellation.

use std::{
    convert::Infallible,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};

use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use futures_core::Stream;
use jiff::Timestamp;
use junban_app::{AffectedIds, CommittedEvent, EventCatchUp, EventType, ResyncScope, TaskService};
use junban_domain::OperationId;
use junban_storage::SqliteRepository;
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::BroadcastEventSink;
use crate::dto::CommittedEventDto;

pub(crate) type AppService = TaskService<SqliteRepository, BroadcastEventSink>;

// Hard cap: bearer holders are untrusted for availability. Not configurable yet.
pub const MAX_SSE_CONNECTIONS: usize = 64;

pub struct SseConnectionPermit {
    connections: Arc<AtomicUsize>,
}

impl SseConnectionPermit {
    pub fn try_acquire(connections: &Arc<AtomicUsize>) -> Option<Self> {
        let mut current = connections.load(Ordering::SeqCst);
        loop {
            if current >= MAX_SSE_CONNECTIONS {
                return None;
            }
            match connections.compare_exchange_weak(
                current,
                current + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    return Some(Self {
                        connections: Arc::clone(connections),
                    });
                }
                Err(observed) => current = observed,
            }
        }
    }
}

impl Drop for SseConnectionPermit {
    fn drop(&mut self) {
        self.connections.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct ForwarderGuard {
    active: Arc<AtomicUsize>,
}

impl ForwarderGuard {
    pub fn enter(active: Arc<AtomicUsize>) -> Self {
        active.fetch_add(1, Ordering::SeqCst);
        Self { active }
    }
}

impl Drop for ForwarderGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

struct ChannelStream {
    receiver: mpsc::Receiver<Result<SseEvent, Infallible>>,
    _permit: SseConnectionPermit,
}

impl Stream for ChannelStream {
    type Item = Result<SseEvent, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.receiver.poll_recv(context)
    }
}

pub fn resync_required_event(latest_revision: u64) -> CommittedEvent {
    CommittedEvent {
        revision: latest_revision,
        operation_id: OperationId::parse(&Uuid::nil().to_string())
            .expect("nil UUID is a valid operation id"),
        event_type: EventType::new("sync.resync_required"),
        occurred_at: Timestamp::now(),
        primary: None,
        snapshot: None,
        affected: AffectedIds::default(),
        resync: ResyncScope::BOTH,
    }
}

pub fn open_sse_stream(
    service: AppService,
    live: broadcast::Receiver<CommittedEvent>,
    catch_up: EventCatchUp,
    since: u64,
    shutdown: CancellationToken,
    permit: SseConnectionPermit,
    active_forwarders: Arc<AtomicUsize>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let (sender, stream_receiver) = mpsc::channel(32);
    let forwarder_guard = ForwarderGuard::enter(active_forwarders);
    tokio::spawn(async move {
        let _forwarder_guard = forwarder_guard;
        forward_events(service, live, catch_up, since, sender, shutdown).await;
    });

    Sse::new(ChannelStream {
        receiver: stream_receiver,
        _permit: permit,
    })
    .keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
}

async fn forward_events(
    service: AppService,
    mut live: broadcast::Receiver<CommittedEvent>,
    catch_up: EventCatchUp,
    since: u64,
    sender: mpsc::Sender<Result<SseEvent, Infallible>>,
    shutdown: CancellationToken,
) {
    let mut last_sent = since;
    if !forward_catch_up(&service, catch_up, &sender, &mut last_sent, &shutdown).await {
        return;
    }
    loop {
        tokio::select! {
            biased;
            () = sender.closed() => return,
            () = shutdown.cancelled() => return,
            result = live.recv() => match result {
                Ok(event) => {
                    if !send_event(&sender, &event, &mut last_sent, &shutdown).await {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let catch_up = tokio::select! {
                        biased;
                        () = sender.closed() => return,
                        () = shutdown.cancelled() => return,
                        result = service.list_events(last_sent) => {
                            let Ok(catch_up) = result else {
                                return;
                            };
                            catch_up
                        }
                    };
                    if !forward_catch_up(
                        &service,
                        catch_up,
                        &sender,
                        &mut last_sent,
                        &shutdown,
                    ).await {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

async fn forward_catch_up(
    service: &AppService,
    mut catch_up: EventCatchUp,
    sender: &mpsc::Sender<Result<SseEvent, Infallible>>,
    last_sent: &mut u64,
    shutdown: &CancellationToken,
) -> bool {
    loop {
        match catch_up {
            EventCatchUp::ResyncRequired { latest_revision } => {
                return send_event(
                    sender,
                    &resync_required_event(latest_revision),
                    last_sent,
                    shutdown,
                )
                .await;
            }
            EventCatchUp::Page {
                events, has_more, ..
            } => {
                let previous_revision = *last_sent;
                for event in events {
                    if !send_event(sender, &event, last_sent, shutdown).await {
                        return false;
                    }
                }
                if !has_more {
                    return true;
                }
                if *last_sent == previous_revision {
                    return false;
                }
                catch_up = tokio::select! {
                    biased;
                    () = sender.closed() => return false,
                    () = shutdown.cancelled() => return false,
                    result = service.list_events(*last_sent) => {
                        let Ok(next) = result else {
                            return false;
                        };
                        next
                    }
                };
            }
        }
    }
}

/// Serialize and enqueue one event. Duplicate revisions are suppressed.
pub async fn send_event(
    sender: &mpsc::Sender<Result<SseEvent, Infallible>>,
    event: &CommittedEvent,
    last_sent: &mut u64,
    shutdown: &CancellationToken,
) -> bool {
    if event.revision <= *last_sent {
        return true;
    }
    // Full CommittedEvent envelope; never aggregate retained history.
    let Ok(data) = serde_json::to_string(&CommittedEventDto::from(event.clone())) else {
        return false;
    };
    let message = Ok(SseEvent::default()
        .id(event.revision.to_string())
        .event(event.event_type.as_str())
        .data(data));
    // A full mpsc buffer must not ignore shutdown or client disconnect.
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
    *last_sent = event.revision;
    true
}
