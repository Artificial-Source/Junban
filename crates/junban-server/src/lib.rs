//! Axum router, HTTP contract, authentication, static serving, and SSE delivery.

mod cursor;
mod diagnostics;
mod dto;
mod error;
mod maintenance;
mod reminder_wake;
mod routes;
mod sse;

use std::{
    collections::HashSet,
    fs, io,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
};
use junban_app::{CommittedEvent, EventSink, TaskService};
use junban_domain::{OperationId, sha256_hex};
use junban_storage::{
    RecoveryOwner, SqliteRepository, atomic_replace_private_file, load_allowed_hosts,
    save_allowed_hosts, write_private_file,
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tower_http::services::{ServeDir, ServeFile};
use utoipa::{
    Modify, OpenApi,
    openapi::security::{Http, HttpAuthScheme, SecurityScheme},
};
use uuid::Uuid;

use crate::diagnostics::{DIAGNOSTIC_RING_CAPACITY, DiagnosticRing};
use crate::error::{ApiError, ErrorBody, ErrorEnvelope};
use crate::reminder_wake::{ReminderWakeEventDto, ReminderWakeHub, start_reminder_coordinator};
use crate::routes::{
    acquire_reminder_lease, add_relation, api_not_found, append_time_slot_task, apply_import,
    apply_template, bulk_tasks, calendar_tasks, cancel_task, claim_due_reminders,
    clear_diagnostics, complete_task, create_backup, create_comment, create_project,
    create_saved_filter, create_section, create_tag, create_task, create_template,
    create_time_block, create_time_slot, delete_comment, delete_project, delete_saved_filter,
    delete_section, delete_tag, delete_task, delete_template, delete_time_block, delete_time_slot,
    dismiss_reminder, events, export_tasks, get_allowed_hosts, get_catalog, get_diagnostics,
    get_maintenance_status, get_profile, get_recovery_status, get_settings, get_sync_state,
    get_task, get_temporal_settings, health, list_comments, list_relations, list_task_activity,
    list_task_reminders, list_tasks, list_time_blocks, list_time_slots, mark_owner_lost_reminders,
    motivation_dopamine_menu, motivation_eat_the_frog, motivation_task_jar, move_task,
    move_time_block, nudges, parse_filter_route, parse_quick_entry_route, parse_text_import_route,
    patch_comment, patch_project, patch_saved_filter, patch_section, patch_settings, patch_tag,
    patch_task, patch_template, patch_time_block, patch_time_slot, planning_daily,
    planning_end_of_day, planning_weekly, preview_import, preview_replan_time_blocks,
    put_allowed_hosts, recovery_api_unavailable, release_reminder_lease, reminder_events,
    remove_relation, remove_time_slot_task, renew_reminder_lease, reopen_task, reorder_tasks,
    replace_time_slot_tasks, replan_time_blocks, reschedule_reminder, resize_time_block,
    restore_backup, rotate_token, settle_reminder_delivered, settle_reminder_failed, stats,
    uncomplete_task, undo_operation,
};
use crate::sse::{AppService, SseConnectionPermit};

pub use crate::diagnostics::{DiagnosticEntry, DiagnosticSeverity, redact_secrets};
pub use crate::maintenance::MaintenanceGate;
pub use crate::reminder_wake::{REMINDER_OVERDUE_WAKE_THROTTLE, REMINDER_WAKE_EVENT_TYPE};

/// Phase 2 HTTP body ceiling (matches frozen transport plan).
pub const MAX_BODY_BYTES: usize = 512 * 1024;
/// Transfer upload ceiling for import preview/apply bodies.
pub const MAX_TRANSFER_BODY_BYTES: usize = 8 * 1024 * 1024;
/// Complete envelope ceiling: 512 MiB SQLite payload plus bounded manifest and framing.
pub const MAX_BACKUP_BODY_BYTES: usize = junban_domain::MAX_BACKUP_PAYLOAD_BYTES as usize
    + junban_domain::MAX_BACKUP_MANIFEST_BYTES as usize
    + junban_domain::BACKUP_HEADER_LEN;
/// Bounded drain deadline for restore under the maintenance barrier.
pub const RESTORE_DRAIN_DEADLINE: Duration = Duration::from_secs(5);
const AUTH_ATTEMPTS: usize = 8;
const AUTH_WINDOW: Duration = Duration::from_secs(30);
pub const TOKEN_FILE: &str = "access-token";
pub const TOKEN_ROTATION_RECEIPT_FILE: &str = "access-token-rotation-receipt.json";
pub const RUNTIME_FILE: &str = "runtime.json";
const TOKEN_ROTATION_RECEIPT_VERSION: u8 = 1;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenRotationReceipt {
    version: u8,
    operation_id: String,
    previous_token_sha256: String,
    issued_token: String,
    new_token_sha256: String,
}

impl TokenRotationReceipt {
    fn new(operation_id: OperationId, previous_token: &str, issued_token: String) -> Self {
        Self {
            version: TOKEN_ROTATION_RECEIPT_VERSION,
            operation_id: operation_id.to_string(),
            previous_token_sha256: sha256_hex(previous_token.as_bytes()),
            new_token_sha256: sha256_hex(issued_token.as_bytes()),
            issued_token,
        }
    }

    fn validate(&self) -> io::Result<()> {
        let valid = self.version == TOKEN_ROTATION_RECEIPT_VERSION
            && OperationId::parse(&self.operation_id).is_ok()
            && is_lower_hex_256(&self.issued_token)
            && self.new_token_sha256 == sha256_hex(self.issued_token.as_bytes())
            && is_lower_hex_256(&self.previous_token_sha256);
        if valid {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid token rotation receipt",
            ))
        }
    }

    fn matches_operation(&self, operation_id: &OperationId) -> bool {
        self.operation_id == operation_id.to_string()
    }

    fn token_is_previous(&self, token: &str) -> bool {
        self.previous_token_sha256 == sha256_hex(token.as_bytes())
    }

    fn token_is_issued(&self, token: &str) -> bool {
        self.new_token_sha256 == sha256_hex(token.as_bytes())
    }
}

fn is_lower_hex_256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone)]
pub struct BroadcastEventSink {
    sender: broadcast::Sender<CommittedEvent>,
    reminder_wakes: Arc<ReminderWakeHub>,
}

impl BroadcastEventSink {
    #[must_use]
    pub fn new(capacity: usize, reminder_wakes: Arc<ReminderWakeHub>) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self {
            sender,
            reminder_wakes,
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<CommittedEvent> {
        self.sender.subscribe()
    }
}

impl EventSink for BroadcastEventSink {
    fn publish(&self, event: CommittedEvent) {
        // No active SSE client is a normal state; durability lives in SQLite.
        let _ = self.sender.send(event);
        // Every committed user mutation may affect reminder eligibility.
        self.reminder_wakes.notify_recompute();
    }
}

#[derive(Clone)]
pub struct RecoveryState {
    owner: Arc<RecoveryOwner>,
    access_token: Arc<RwLock<String>>,
    allowed_hosts: Arc<RwLock<HashSet<String>>>,
    auth_limiter: Arc<AuthLimiter>,
    restore_active: Arc<AtomicBool>,
    restore_complete: Arc<AtomicBool>,
}

impl RecoveryState {
    pub fn new(
        owner: RecoveryOwner,
        access_token: String,
        allowed_hosts: impl IntoIterator<Item = String>,
    ) -> io::Result<Self> {
        let cli_hosts: Vec<String> = allowed_hosts.into_iter().collect();
        let hosts = load_allowed_hosts(owner.profile_dir(), cli_hosts)?;
        Ok(Self {
            owner: Arc::new(owner),
            access_token: Arc::new(RwLock::new(access_token)),
            allowed_hosts: Arc::new(RwLock::new(hosts)),
            auth_limiter: Arc::new(AuthLimiter::new()),
            restore_active: Arc::new(AtomicBool::new(false)),
            restore_complete: Arc::new(AtomicBool::new(false)),
        })
    }

    fn authenticate(&self, headers: &HeaderMap) -> bool {
        let Some(raw) = headers.get(header::AUTHORIZATION) else {
            return false;
        };
        let Ok(raw) = raw.to_str() else {
            return false;
        };
        let Some(presented) = raw.strip_prefix("Bearer ") else {
            return false;
        };
        let expected = self.access_token.read().expect("token lock poisoned");
        presented.as_bytes() == expected.as_bytes()
    }

    fn host_allowed(&self, host: &str) -> bool {
        let hosts = self.allowed_hosts.read().expect("host lock poisoned");
        hosts.contains(host)
    }

    #[must_use]
    pub fn owner(&self) -> Arc<RecoveryOwner> {
        Arc::clone(&self.owner)
    }

    pub(crate) fn try_begin_restore(&self) -> Option<RecoveryRestorePermit> {
        if self.restore_complete.load(Ordering::Acquire)
            || self
                .restore_active
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return None;
        }
        Some(RecoveryRestorePermit {
            active: Arc::clone(&self.restore_active),
        })
    }

    pub(crate) fn mark_restore_complete(&self) {
        self.restore_complete.store(true, Ordering::Release);
    }
}

pub(crate) struct RecoveryRestorePermit {
    active: Arc<AtomicBool>,
}

impl Drop for RecoveryRestorePermit {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

#[derive(Clone)]
pub struct ServerState {
    pub(crate) service: AppService,
    pub(crate) events: Arc<BroadcastEventSink>,
    pub(crate) reminder_wakes: Arc<ReminderWakeHub>,
    maintenance: Arc<MaintenanceGate>,
    bearer_token: Arc<RwLock<Arc<str>>>,
    /// Hosts supplied at process start (CLI / bind address); never removed via API.
    cli_hosts: Arc<Vec<String>>,
    allowed_hosts: Arc<RwLock<HashSet<String>>>,
    pub(crate) profile_dir: PathBuf,
    auth_limiter: Arc<AuthLimiter>,
    shutdown: CancellationToken,
    /// Replaced on token rotation so active SSE forwarders observe cancellation.
    session_cancel: Arc<Mutex<CancellationToken>>,
    /// The sole durable token-rotation receipt, mirrored for request authentication.
    rotation_receipt: Arc<Mutex<Option<TokenRotationReceipt>>>,
    /// Only one normal backup, restore, or export may own staged files at a time.
    staged_artifact_active: Arc<AtomicBool>,
    pub(crate) diagnostics: Arc<DiagnosticRing>,
    sse_connections: Arc<AtomicUsize>,
    /// Live SSE forwarder tasks (revisioned events + reminder wakes); test-observable.
    pub(crate) active_forwarders: Arc<AtomicUsize>,
    reminder_coordinator: Arc<Mutex<Option<RunningReminderCoordinator>>>,
    reminder_coordinator_stopped: Arc<AtomicBool>,
}

struct RunningReminderCoordinator {
    cancel: CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

pub(crate) struct StagedArtifactPermit {
    active: Arc<AtomicBool>,
}

impl Drop for StagedArtifactPermit {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

impl ServerState {
    /// Build server state without starting the reminder coordinator.
    ///
    /// Router/unit tests use this path so they never accidentally spawn the
    /// process-global wake loop. Production `main` must call
    /// [`ServerState::start_reminder_coordinator`] exactly once after construction.
    ///
    /// `cli_hosts` are always allowed and are not removed by the hosts API.
    /// Additional hosts are loaded from the profile's `allowed-hosts.json`.
    pub fn new(
        repository: SqliteRepository,
        bearer_token: String,
        cli_hosts: impl IntoIterator<Item = String>,
        profile_dir: impl Into<PathBuf>,
    ) -> io::Result<Self> {
        let profile_dir = profile_dir.into();
        let cli_hosts: Vec<String> = cli_hosts.into_iter().collect();
        let allowed_hosts = load_allowed_hosts(&profile_dir, cli_hosts.clone())?;
        let rotation_receipt = load_token_rotation_receipt(&profile_dir)?;
        if rotation_receipt
            .as_ref()
            .is_some_and(|receipt| !receipt.token_is_issued(&bearer_token))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "access token was not reconciled with rotation receipt",
            ));
        }
        let reminder_wakes = Arc::new(ReminderWakeHub::new());
        let events = Arc::new(BroadcastEventSink::new(128, Arc::clone(&reminder_wakes)));
        let service = TaskService::new(Arc::new(repository), Arc::clone(&events));
        let diagnostics = Arc::new(DiagnosticRing::new(DIAGNOSTIC_RING_CAPACITY));
        diagnostics.log(
            DiagnosticSeverity::Info,
            "server_state_created",
            None,
            "server state initialized",
        );
        Ok(Self {
            service,
            events,
            reminder_wakes,
            maintenance: MaintenanceGate::new(),
            bearer_token: Arc::new(RwLock::new(Arc::from(bearer_token))),
            cli_hosts: Arc::new(cli_hosts),
            allowed_hosts: Arc::new(RwLock::new(allowed_hosts)),
            profile_dir,
            auth_limiter: Arc::new(AuthLimiter::new()),
            shutdown: CancellationToken::new(),
            session_cancel: Arc::new(Mutex::new(CancellationToken::new())),
            rotation_receipt: Arc::new(Mutex::new(rotation_receipt)),
            staged_artifact_active: Arc::new(AtomicBool::new(false)),
            diagnostics,
            sse_connections: Arc::new(AtomicUsize::new(0)),
            active_forwarders: Arc::new(AtomicUsize::new(0)),
            reminder_coordinator: Arc::new(Mutex::new(None)),
            reminder_coordinator_stopped: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Process-wide maintenance / recovery barrier.
    #[must_use]
    pub fn maintenance(&self) -> &MaintenanceGate {
        self.maintenance.as_ref()
    }

    /// Cancelled when the process begins graceful shutdown.
    #[must_use]
    pub fn shutdown_token(&self) -> CancellationToken {
        self.shutdown.clone()
    }

    /// Token cancelled on process shutdown or session invalidation (token rotation).
    #[must_use]
    pub(crate) fn stream_cancel_token(&self) -> CancellationToken {
        let linked = CancellationToken::new();
        let shutdown = self.shutdown.clone();
        let session = self
            .session_cancel
            .lock()
            .expect("session cancel poisoned")
            .clone();
        let stop = linked.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = shutdown.cancelled() => {}
                () = session.cancelled() => {}
            }
            stop.cancel();
        });
        linked
    }

    /// Snapshot of the current bearer token (never log or put in diagnostics).
    #[must_use]
    pub(crate) fn current_token(&self) -> Arc<str> {
        self.bearer_token
            .read()
            .expect("bearer token poisoned")
            .clone()
    }

    /// Snapshot of the effective Host allowlist.
    #[must_use]
    pub(crate) fn current_allowed_hosts(&self) -> HashSet<String> {
        self.allowed_hosts
            .read()
            .expect("allowed hosts poisoned")
            .clone()
    }

    /// Replace persisted hosts and refresh the effective allowlist.
    pub(crate) fn set_persisted_hosts(
        &self,
        persisted: Vec<String>,
    ) -> io::Result<HashSet<String>> {
        let mut effective: HashSet<String> = self.cli_hosts.iter().cloned().collect();
        effective.extend(persisted);
        save_allowed_hosts(&self.profile_dir, &effective, self.cli_hosts.as_slice())?;
        *self.allowed_hosts.write().expect("allowed hosts poisoned") = effective.clone();
        self.diagnostics.log(
            DiagnosticSeverity::Info,
            "hosts_updated",
            None,
            &format!("allowed host count is now {}", effective.len()),
        );
        Ok(effective)
    }

    /// Rotate the access token using a receipt-first crash-recovery protocol.
    pub(crate) fn rotate_token(&self, operation_id: OperationId) -> io::Result<String> {
        let mut receipt_guard = self
            .rotation_receipt
            .lock()
            .expect("rotation receipt poisoned");
        if let Some(receipt) = receipt_guard
            .as_ref()
            .filter(|receipt| receipt.matches_operation(&operation_id))
        {
            let issued_token = receipt.issued_token.clone();
            self.finish_token_rotation(receipt)?;
            return Ok(issued_token);
        }

        let previous_token = self.current_token();
        let receipt = TokenRotationReceipt::new(
            operation_id,
            previous_token.as_ref(),
            generate_access_token(),
        );
        if let Err(error) = persist_token_rotation_receipt(&self.profile_dir, &receipt) {
            // A rename may have completed even when the following directory sync failed.
            // Mirror the exact on-disk receipt so the same old-token retry remains recoverable.
            if let Ok(Some(persisted)) = load_token_rotation_receipt(&self.profile_dir)
                && persisted.operation_id == receipt.operation_id
                && persisted.previous_token_sha256 == receipt.previous_token_sha256
                && persisted.new_token_sha256 == receipt.new_token_sha256
            {
                *receipt_guard = Some(persisted);
            }
            return Err(error);
        }
        *receipt_guard = Some(receipt.clone());
        self.finish_token_rotation(&receipt)?;
        Ok(receipt.issued_token)
    }

    fn finish_token_rotation(&self, receipt: &TokenRotationReceipt) -> io::Result<()> {
        let current = self.current_token();
        if receipt.token_is_previous(current.as_ref()) {
            write_token_atomic(&self.profile_dir, &receipt.issued_token)?;
            {
                let mut guard = self.bearer_token.write().expect("bearer token poisoned");
                *guard = Arc::from(receipt.issued_token.as_str());
            }
            self.invalidate_sessions();
            self.diagnostics.log(
                DiagnosticSeverity::Info,
                "token_rotated",
                None,
                "access token rotated; active streams closed",
            );
            return Ok(());
        }
        if receipt.token_is_issued(current.as_ref()) {
            return Ok(());
        }
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "token rotation receipt does not match current token",
        ))
    }

    fn previous_token_retry_allowed(&self, request: &Request, presented_token: &str) -> bool {
        if request.method() != Method::POST || request.uri().path() != "/api/v1/auth/rotate" {
            return false;
        }
        let Some(raw_operation_id) = request
            .headers()
            .get("idempotency-key")
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        let Ok(operation_id) = OperationId::parse(raw_operation_id) else {
            return false;
        };
        self.rotation_receipt
            .lock()
            .expect("rotation receipt poisoned")
            .as_ref()
            .is_some_and(|receipt| {
                receipt.matches_operation(&operation_id)
                    && receipt.token_is_previous(presented_token)
            })
    }

    pub(crate) fn try_acquire_staged_artifact(&self) -> Option<StagedArtifactPermit> {
        if self
            .staged_artifact_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return None;
        }
        Some(StagedArtifactPermit {
            active: Arc::clone(&self.staged_artifact_active),
        })
    }

    pub(crate) fn invalidate_sessions(&self) {
        let mut guard = self.session_cancel.lock().expect("session cancel poisoned");
        guard.cancel();
        *guard = CancellationToken::new();
    }

    /// Start the single process-global reminder wake coordinator.
    ///
    /// Returns false if this state already owns one. Production calls this once;
    /// restore and process shutdown stop it through [`Self::stop_reminder_coordinator`].
    pub fn start_reminder_coordinator(&self) -> bool {
        let mut running = self
            .reminder_coordinator
            .lock()
            .expect("reminder coordinator poisoned");
        if self.reminder_coordinator_stopped.load(Ordering::Acquire) || running.is_some() {
            return false;
        }
        let cancel = self.shutdown.child_token();
        let handle = start_reminder_coordinator(
            self.service.clone(),
            Arc::clone(&self.reminder_wakes),
            cancel.clone(),
        );
        *running = Some(RunningReminderCoordinator { cancel, handle });
        true
    }

    /// Idempotently stop and join the owned reminder coordinator.
    pub async fn stop_reminder_coordinator(&self) {
        self.reminder_coordinator_stopped
            .store(true, Ordering::Release);
        let running = self
            .reminder_coordinator
            .lock()
            .expect("reminder coordinator poisoned")
            .take();
        let Some(mut running) = running else {
            return;
        };
        running.cancel.cancel();
        self.reminder_wakes.notify_recompute();
        if tokio::time::timeout(Duration::from_secs(2), &mut running.handle)
            .await
            .is_err()
        {
            running.handle.abort();
            let _ = running.handle.await;
        }
    }

    #[must_use]
    pub fn reminder_coordinator_running(&self) -> bool {
        self.reminder_coordinator
            .lock()
            .expect("reminder coordinator poisoned")
            .is_some()
    }

    /// Cancel all event/reminder streams and wait for every forwarder to exit.
    pub(crate) async fn quiesce_streams(&self, deadline: Duration) -> bool {
        self.invalidate_sessions();
        let start = tokio::time::Instant::now();
        loop {
            if self
                .active_forwarders
                .load(std::sync::atomic::Ordering::Acquire)
                == 0
            {
                return true;
            }
            if start.elapsed() >= deadline {
                return self
                    .active_forwarders
                    .load(std::sync::atomic::Ordering::Acquire)
                    == 0;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub(crate) fn try_acquire_sse(&self) -> Option<SseConnectionPermit> {
        SseConnectionPermit::try_acquire(&self.sse_connections)
    }

    pub(crate) fn notify_reminder_wake(&self) {
        self.reminder_wakes.notify_recompute();
    }

    /// Append a redacted diagnostic entry to the process-local ring.
    pub fn log_diagnostic(
        &self,
        severity: DiagnosticSeverity,
        code: &str,
        request_id: Option<&str>,
        message: &str,
    ) {
        let token = self.current_token();
        let redacted = crate::diagnostics::redact_secrets(message, token.as_ref());
        self.diagnostics.log(severity, code, request_id, &redacted);
    }
}

struct AuthLimiter {
    attempts: Mutex<std::collections::VecDeque<Instant>>,
}

impl AuthLimiter {
    fn new() -> Self {
        Self {
            attempts: Mutex::new(std::collections::VecDeque::with_capacity(AUTH_ATTEMPTS)),
        }
    }

    fn rejected_status(&self) -> StatusCode {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().expect("auth limiter poisoned");
        while attempts
            .front()
            .is_some_and(|attempt| now.duration_since(*attempt) >= AUTH_WINDOW)
        {
            attempts.pop_front();
        }
        if attempts.len() >= AUTH_ATTEMPTS {
            StatusCode::TOO_MANY_REQUESTS
        } else {
            attempts.push_back(now);
            StatusCode::UNAUTHORIZED
        }
    }
}

/// Builds the reusable API + static UI router.
pub fn router(state: ServerState, web_dir: impl Into<PathBuf>) -> Router {
    let web_dir = web_dir.into();
    let index = web_dir.join("index.html");
    let static_files = ServeDir::new(web_dir).fallback(ServeFile::new(index));

    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/profile", get(get_profile))
        .route("/api/v1/sync-state", get(get_sync_state))
        .route("/api/v1/tasks", get(list_tasks).post(create_task))
        .route("/api/v1/tasks/actions", post(bulk_tasks))
        .route("/api/v1/tasks/reorder", post(reorder_tasks))
        .route(
            "/api/v1/tasks/{task_id}",
            get(get_task).patch(patch_task).delete(delete_task),
        )
        .route("/api/v1/tasks/{task_id}/complete", post(complete_task))
        .route("/api/v1/tasks/{task_id}/uncomplete", post(uncomplete_task))
        .route("/api/v1/tasks/{task_id}/cancel", post(cancel_task))
        .route("/api/v1/tasks/{task_id}/reopen", post(reopen_task))
        .route("/api/v1/tasks/{task_id}/move", post(move_task))
        .route(
            "/api/v1/tasks/{task_id}/comments",
            get(list_comments).post(create_comment),
        )
        .route(
            "/api/v1/tasks/{task_id}/relations",
            get(list_relations).post(add_relation),
        )
        .route(
            "/api/v1/tasks/{task_id}/relations/{to_task_id}",
            delete(remove_relation),
        )
        .route("/api/v1/tasks/{task_id}/activity", get(list_task_activity))
        .route(
            "/api/v1/tasks/{task_id}/reminders",
            get(list_task_reminders),
        )
        .route(
            "/api/v1/tasks/{task_id}/reminders/reschedule",
            post(reschedule_reminder),
        )
        .route(
            "/api/v1/tasks/{task_id}/reminders/dismiss",
            post(dismiss_reminder),
        )
        .route("/api/v1/reminders/lease", post(acquire_reminder_lease))
        .route("/api/v1/reminders/lease/renew", post(renew_reminder_lease))
        .route(
            "/api/v1/reminders/lease/release",
            post(release_reminder_lease),
        )
        .route("/api/v1/reminders/claim", post(claim_due_reminders))
        .route(
            "/api/v1/reminders/settle/delivered",
            post(settle_reminder_delivered),
        )
        .route(
            "/api/v1/reminders/settle/failed",
            post(settle_reminder_failed),
        )
        .route(
            "/api/v1/reminders/owner-lost",
            post(mark_owner_lost_reminders),
        )
        .route("/api/v1/reminders/events", get(reminder_events))
        .route("/api/v1/catalog", get(get_catalog))
        .route("/api/v1/projects", post(create_project))
        .route(
            "/api/v1/projects/{project_id}",
            patch(patch_project).delete(delete_project),
        )
        .route("/api/v1/sections", post(create_section))
        .route(
            "/api/v1/sections/{section_id}",
            patch(patch_section).delete(delete_section),
        )
        .route("/api/v1/tags", post(create_tag))
        .route("/api/v1/tags/{tag_id}", patch(patch_tag).delete(delete_tag))
        .route("/api/v1/templates", post(create_template))
        .route("/api/v1/templates/apply", post(apply_template))
        .route(
            "/api/v1/templates/{template_id}",
            patch(patch_template).delete(delete_template),
        )
        .route("/api/v1/saved_filters", post(create_saved_filter))
        .route(
            "/api/v1/saved_filters/{filter_id}",
            patch(patch_saved_filter).delete(delete_saved_filter),
        )
        .route(
            "/api/v1/comments/{comment_id}",
            patch(patch_comment).delete(delete_comment),
        )
        .route(
            "/api/v1/operations/{source_operation_id}/undo",
            post(undo_operation),
        )
        .route("/api/v1/parse/quick-entry", post(parse_quick_entry_route))
        .route("/api/v1/parse/filter", post(parse_filter_route))
        .route("/api/v1/parse/text-import", post(parse_text_import_route))
        .route(
            "/api/v1/time-blocks",
            get(list_time_blocks).post(create_time_block),
        )
        .route("/api/v1/time-blocks/replan", post(replan_time_blocks))
        .route(
            "/api/v1/time-blocks/replan/preview",
            get(preview_replan_time_blocks),
        )
        .route(
            "/api/v1/time-blocks/{time_block_id}",
            patch(patch_time_block).delete(delete_time_block),
        )
        .route(
            "/api/v1/time-blocks/{time_block_id}/move",
            post(move_time_block),
        )
        .route(
            "/api/v1/time-blocks/{time_block_id}/resize",
            post(resize_time_block),
        )
        .route(
            "/api/v1/time-slots",
            get(list_time_slots).post(create_time_slot),
        )
        .route(
            "/api/v1/time-slots/{time_slot_id}",
            patch(patch_time_slot).delete(delete_time_slot),
        )
        .route(
            "/api/v1/time-slots/{time_slot_id}/tasks",
            post(append_time_slot_task).put(replace_time_slot_tasks),
        )
        .route(
            "/api/v1/time-slots/{time_slot_id}/tasks/{task_id}",
            delete(remove_time_slot_task),
        )
        .route("/api/v1/calendar/tasks", get(calendar_tasks))
        .route("/api/v1/planning/daily", get(planning_daily))
        .route("/api/v1/planning/end-of-day", get(planning_end_of_day))
        .route("/api/v1/planning/weekly", get(planning_weekly))
        .route("/api/v1/stats", get(stats))
        .route("/api/v1/nudges", get(nudges))
        .route("/api/v1/settings", get(get_settings).patch(patch_settings))
        .route("/api/v1/settings/temporal", get(get_temporal_settings))
        .route(
            "/api/v1/imports/preview",
            post(preview_import).layer(DefaultBodyLimit::max(MAX_TRANSFER_BODY_BYTES)),
        )
        .route(
            "/api/v1/imports/apply",
            post(apply_import).layer(DefaultBodyLimit::max(MAX_TRANSFER_BODY_BYTES)),
        )
        .route(
            "/api/v1/exports/tasks",
            get(export_tasks).layer(DefaultBodyLimit::max(MAX_TRANSFER_BODY_BYTES)),
        )
        // Backup download has no request body; restore needs a dedicated 512 MiB ceiling.
        .route("/api/v1/backup", get(create_backup))
        .route(
            "/api/v1/backup/restore",
            post(restore_backup).layer(DefaultBodyLimit::max(MAX_BACKUP_BODY_BYTES)),
        )
        .route(
            "/api/v1/motivation/eat-the-frog",
            get(motivation_eat_the_frog),
        )
        .route("/api/v1/motivation/task-jar", get(motivation_task_jar))
        .route(
            "/api/v1/motivation/dopamine-menu",
            get(motivation_dopamine_menu),
        )
        .route("/api/v1/events", get(events))
        .route("/api/v1/maintenance/status", get(get_maintenance_status))
        .route("/api/v1/recovery/status", get(get_recovery_status))
        .route("/api/v1/auth/rotate", post(rotate_token))
        .route(
            "/api/v1/hosts",
            get(get_allowed_hosts).put(put_allowed_hosts),
        )
        .route(
            "/api/v1/diagnostics",
            get(get_diagnostics).delete(clear_diagnostics),
        )
        .route("/api", get(api_not_found))
        .route("/api/{*path}", get(api_not_found).fallback(api_not_found))
        .fallback_service(static_files)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_guard,
        ))
        // Outermost: admit/reject before auth so restore can drain cleanly.
        .layer(middleware::from_fn_with_state(
            state.clone(),
            maintenance_guard,
        ))
        .with_state(state)
}

/// Minimal lock-retaining router used when storage cannot open a normal service.
///
/// Serves health, recovery status, static recovery UI, and authenticated complete-
/// backup restore. Every other API path fails closed with 503.
pub fn recovery_router(state: RecoveryState, web_dir: impl Into<PathBuf>) -> Router {
    let web_dir = web_dir.into();
    let index = web_dir.join("index.html");
    let static_files = ServeDir::new(web_dir).fallback(ServeFile::new(index));

    Router::new()
        .route("/", get(routes::recovery_ui))
        .route("/recovery.js", get(routes::recovery_script))
        .route("/api/v1/health", get(routes::recovery_health))
        .route("/api/v1/recovery/status", get(routes::recovery_status))
        .route(
            "/api/v1/backup/restore",
            post(routes::recovery_restore_backup),
        )
        .route(
            "/api",
            get(recovery_api_unavailable).fallback(recovery_api_unavailable),
        )
        .route(
            "/api/{*path}",
            get(recovery_api_unavailable).fallback(recovery_api_unavailable),
        )
        .fallback_service(static_files)
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            recovery_security_guard,
        ))
        .with_state(state)
}

/// Outer middleware: process-wide maintenance / recovery admission.
async fn maintenance_guard(
    State(state): State<ServerState>,
    request: Request,
    next: Next,
) -> Response {
    let request_id = RequestId(Uuid::now_v7().to_string());
    let path = request.uri().path();
    let gate = state.maintenance();

    if gate.recovery_mode() {
        if is_recovery_open_path(path) {
            return next.run(request).await;
        }
        return secure_response(
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "recovery_mode",
                "server is in recovery mode; only health and recovery endpoints are available",
                false,
                &request_id,
            )
            .into_response(),
            &request_id,
        );
    }

    if gate.restart_required() {
        if path == "/api/v1/health" {
            return next.run(request).await;
        }
        return secure_response(
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "restart_required",
                "server restart is required after restore",
                false,
                &request_id,
            )
            .into_response(),
            &request_id,
        );
    }

    if gate.maintenance_active() {
        if path == "/api/v1/health" {
            return next.run(request).await;
        }
        return secure_response(
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "maintenance_mode",
                "server is temporarily unavailable for maintenance",
                true,
                &request_id,
            )
            .into_response(),
            &request_id,
        );
    }

    // The restore handler owns the single-winner maintenance transition and must
    // not count itself among the normal requests it drains.
    if path == "/api/v1/backup/restore" {
        return next.run(request).await;
    }

    if !gate.try_admit() {
        return secure_response(
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "maintenance_mode",
                "server is temporarily unavailable for maintenance",
                true,
                &request_id,
            )
            .into_response(),
            &request_id,
        );
    }

    let response = next.run(request).await;
    gate.release();
    response
}

fn is_recovery_open_path(path: &str) -> bool {
    path == "/api/v1/health"
        || path == "/api/v1/backup/restore"
        || path.starts_with("/api/v1/recovery/")
}

fn is_public_api_path(path: &str) -> bool {
    path == "/api/v1/health" || path.starts_with("/api/v1/recovery/")
}

async fn security_guard(
    State(state): State<ServerState>,
    mut request: Request,
    next: Next,
) -> Response {
    let request_id = RequestId(Uuid::now_v7().to_string());
    request.extensions_mut().insert(request_id.clone());

    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let host_allowed = host.is_some_and(|host| {
        state
            .allowed_hosts
            .read()
            .expect("allowed hosts poisoned")
            .contains(host)
    });
    if !host_allowed {
        state.log_diagnostic(
            DiagnosticSeverity::Warning,
            "host_not_allowed",
            Some(&request_id.0),
            "request Host is not allowed",
        );
        return secure_response(
            ApiError::new(
                StatusCode::MISDIRECTED_REQUEST,
                "host_not_allowed",
                "request Host is not allowed",
                false,
                &request_id,
            )
            .into_response(),
            &request_id,
        );
    }

    if is_unsafe(request.method())
        && let Some(origin) = request.headers().get(header::ORIGIN)
    {
        let origin_matches = origin
            .to_str()
            .ok()
            .and_then(|value| value.parse::<Uri>().ok())
            .is_some_and(|origin| {
                matches!(origin.scheme_str(), Some("http" | "https"))
                    && origin.authority().map(|value| value.as_str()) == host
            });
        if !origin_matches {
            state.log_diagnostic(
                DiagnosticSeverity::Warning,
                "origin_mismatch",
                Some(&request_id.0),
                "request Origin does not match Host",
            );
            return secure_response(
                ApiError::new(
                    StatusCode::FORBIDDEN,
                    "origin_mismatch",
                    "request Origin does not match Host",
                    false,
                    &request_id,
                )
                .into_response(),
                &request_id,
            );
        }
    }

    let path = request.uri().path();
    if path.starts_with("/api/v1") && !is_public_api_path(path) {
        let presented = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        let authenticated = presented.is_some_and(|presented| {
            if state.previous_token_retry_allowed(&request, presented) {
                return true;
            }
            let current = state.current_token();
            // A receipt-first rotation whose token-file write failed has not completed;
            // the still-current credential remains valid while an exact retry can finish it.
            presented.as_bytes() == current.as_bytes()
        });
        if !authenticated {
            let status = state.auth_limiter.rejected_status();
            let (code, message, retryable) = if status == StatusCode::TOO_MANY_REQUESTS {
                (
                    "auth_rate_limited",
                    "too many invalid authentication attempts",
                    true,
                )
            } else {
                (
                    "authentication_required",
                    "a valid bearer token is required",
                    false,
                )
            };
            state.log_diagnostic(
                DiagnosticSeverity::Warning,
                code,
                Some(&request_id.0),
                message,
            );
            return secure_response(
                ApiError::new(status, code, message, retryable, &request_id).into_response(),
                &request_id,
            );
        }
    }

    let api_request = request.uri().path().starts_with("/api");
    let response = next.run(request).await;
    let response = if api_request {
        normalize_api_error(response, &request_id)
    } else {
        response
    };
    if response.status().is_server_error() {
        state.log_diagnostic(
            DiagnosticSeverity::Error,
            "server_error",
            Some(&request_id.0),
            &format!("request failed with status {}", response.status().as_u16()),
        );
    }
    secure_response(response, &request_id)
}

/// Host/origin validation and bearer auth for recovery restore.
async fn recovery_security_guard(
    State(state): State<RecoveryState>,
    mut request: Request,
    next: Next,
) -> Response {
    let request_id = RequestId(Uuid::now_v7().to_string());
    request.extensions_mut().insert(request_id.clone());

    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let host_allowed = host.is_some_and(|host| state.host_allowed(host));
    if !host_allowed {
        return secure_response(
            ApiError::new(
                StatusCode::MISDIRECTED_REQUEST,
                "host_not_allowed",
                "request Host is not allowed",
                false,
                &request_id,
            )
            .into_response(),
            &request_id,
        );
    }

    if is_unsafe(request.method())
        && let Some(origin) = request.headers().get(header::ORIGIN)
    {
        let origin_matches = origin
            .to_str()
            .ok()
            .and_then(|value| value.parse::<Uri>().ok())
            .is_some_and(|origin| {
                matches!(origin.scheme_str(), Some("http" | "https"))
                    && origin.authority().map(|value| value.as_str()) == host
            });
        if !origin_matches {
            return secure_response(
                ApiError::new(
                    StatusCode::FORBIDDEN,
                    "origin_mismatch",
                    "request Origin does not match Host",
                    false,
                    &request_id,
                )
                .into_response(),
                &request_id,
            );
        }
    }

    let path = request.uri().path();
    if path == "/api/v1/backup/restore" && !state.authenticate(request.headers()) {
        let status = state.auth_limiter.rejected_status();
        let (code, message, retryable) = if status == StatusCode::TOO_MANY_REQUESTS {
            (
                "auth_rate_limited",
                "too many invalid authentication attempts",
                true,
            )
        } else {
            (
                "authentication_required",
                "a valid bearer token is required",
                false,
            )
        };
        return secure_response(
            ApiError::new(status, code, message, retryable, &request_id).into_response(),
            &request_id,
        );
    }

    let api_request = request.uri().path().starts_with("/api");
    let response = next.run(request).await;
    let response = if api_request {
        normalize_api_error(response, &request_id)
    } else {
        response
    };
    secure_response(response, &request_id)
}

fn normalize_api_error(response: Response, request_id: &RequestId) -> Response {
    if !response.status().is_client_error() && !response.status().is_server_error() {
        return response;
    }
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("application/json"))
    {
        return response;
    }

    let status = response.status();
    let (code, message, retryable) = match status {
        StatusCode::BAD_REQUEST => ("invalid_request", "request could not be parsed", false),
        StatusCode::NOT_FOUND => ("api_not_found", "API route was not found", false),
        StatusCode::METHOD_NOT_ALLOWED => (
            "method_not_allowed",
            "HTTP method is not allowed for this API route",
            false,
        ),
        StatusCode::PAYLOAD_TOO_LARGE => (
            "body_too_large",
            "request body exceeds the configured limit",
            false,
        ),
        StatusCode::UNSUPPORTED_MEDIA_TYPE => (
            "unsupported_media_type",
            "request Content-Type is not supported",
            false,
        ),
        _ if status.is_server_error() => (
            "internal_error",
            "the server could not complete the request",
            true,
        ),
        _ => ("request_failed", "request was rejected", false),
    };
    ApiError::new(status, code, message, retryable, request_id).into_response()
}

fn is_unsafe(method: &Method) -> bool {
    matches!(
        *method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    )
}

fn secure_response(mut response: Response, request_id: &RequestId) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; connect-src 'self'",
        ),
    );
    if let Ok(value) = HeaderValue::from_str(&request_id.0) {
        headers.insert(HeaderName::from_static("x-request-id"), value);
    }
    response
}

#[derive(Debug, Clone)]
pub struct RequestId(pub(crate) String);

struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        if let Some(components) = openapi.components.as_mut() {
            components.add_security_scheme(
                "bearer_auth",
                SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
            );
        }
    }
}

#[derive(OpenApi)]
#[openapi(
    info(title = "Junban API", version = "1.0.0"),
    paths(
        routes::health,
        routes::get_maintenance_status,
        routes::get_recovery_status,
        routes::get_profile,
        routes::get_sync_state,
        routes::list_tasks,
        routes::create_task,
        routes::get_task,
        routes::patch_task,
        routes::complete_task,
        routes::uncomplete_task,
        routes::cancel_task,
        routes::reopen_task,
        routes::delete_task,
        routes::move_task,
        routes::reorder_tasks,
        routes::bulk_tasks,
        routes::get_catalog,
        routes::create_project,
        routes::patch_project,
        routes::delete_project,
        routes::create_section,
        routes::patch_section,
        routes::delete_section,
        routes::create_tag,
        routes::patch_tag,
        routes::delete_tag,
        routes::create_template,
        routes::patch_template,
        routes::delete_template,
        routes::apply_template,
        routes::create_saved_filter,
        routes::patch_saved_filter,
        routes::delete_saved_filter,
        routes::list_comments,
        routes::create_comment,
        routes::patch_comment,
        routes::delete_comment,
        routes::list_relations,
        routes::add_relation,
        routes::remove_relation,
        routes::list_task_activity,
        routes::undo_operation,
        routes::parse_quick_entry_route,
        routes::parse_filter_route,
        routes::parse_text_import_route,
        routes::events,
        routes::list_task_reminders,
        routes::reschedule_reminder,
        routes::dismiss_reminder,
        routes::acquire_reminder_lease,
        routes::renew_reminder_lease,
        routes::release_reminder_lease,
        routes::claim_due_reminders,
        routes::settle_reminder_delivered,
        routes::settle_reminder_failed,
        routes::mark_owner_lost_reminders,
        routes::reminder_events,
        routes::list_time_blocks,
        routes::create_time_block,
        routes::patch_time_block,
        routes::delete_time_block,
        routes::move_time_block,
        routes::resize_time_block,
        routes::preview_replan_time_blocks,
        routes::replan_time_blocks,
        routes::list_time_slots,
        routes::create_time_slot,
        routes::patch_time_slot,
        routes::delete_time_slot,
        routes::append_time_slot_task,
        routes::replace_time_slot_tasks,
        routes::remove_time_slot_task,
        routes::calendar_tasks,
        routes::planning_daily,
        routes::planning_end_of_day,
        routes::planning_weekly,
        routes::stats,
        routes::nudges,
        routes::get_settings,
        routes::patch_settings,
        routes::get_temporal_settings,
        routes::preview_import,
        routes::apply_import,
        routes::export_tasks,
        routes::create_backup,
        routes::restore_backup,
        routes::motivation_eat_the_frog,
        routes::motivation_task_jar,
        routes::motivation_dopamine_menu,
        routes::rotate_token,
        routes::get_allowed_hosts,
        routes::put_allowed_hosts,
        routes::get_diagnostics,
        routes::clear_diagnostics
    ),
    components(schemas(
        ErrorEnvelope,
        ErrorBody,
        dto::HealthResponse,
        dto::MaintenanceStatusResponse,
        dto::RecoveryStatusResponse,
        dto::ProfileResponse,
        dto::SyncStateResponse,
        dto::TokenRotationResponse,
        dto::HostListResponse,
        dto::HostListRequest,
        dto::DiagnosticsResponse,
        diagnostics::DiagnosticEntry,
        diagnostics::DiagnosticSeverity,
        dto::TaskStatusDto,
        dto::UncompleteOutcomeDto,
        dto::TaskSortDto,
        dto::TaskViewPresetDto,
        dto::ProjectViewDto,
        dto::LocalDueTimeDto,
        dto::TaskDto,
        dto::CreateTaskRequest,
        dto::PatchTaskRequest,
        dto::TaskListResponse,
        dto::OrderAnchorDto,
        dto::MoveTaskRequest,
        dto::ReorderTasksRequest,
        dto::BulkScheduleDto,
        dto::BulkTagChangeDto,
        dto::BulkActionDto,
        dto::BulkTasksRequest,
        dto::ProjectDto,
        dto::SectionDto,
        dto::TagDto,
        dto::TemplateDto,
        dto::SavedFilterDto,
        dto::CatalogResponse,
        dto::CreateProjectRequest,
        dto::PatchProjectRequest,
        dto::CreateSectionRequest,
        dto::PatchSectionRequest,
        dto::CreateTagRequest,
        dto::PatchTagRequest,
        dto::CreateTemplateRequest,
        dto::PatchTemplateRequest,
        dto::ApplyTemplateRequest,
        dto::TemplateVariableDto,
        dto::CreateSavedFilterRequest,
        dto::PatchSavedFilterRequest,
        dto::CommentDto,
        dto::CreateCommentRequest,
        dto::PatchCommentRequest,
        dto::CommentListResponse,
        dto::RelationDto,
        dto::AddRelationRequest,
        dto::RelationListResponse,
        dto::TaskActivityDto,
        dto::TaskActivityResponse,
        dto::ResourceTypeDto,
        dto::ResourceRefDto,
        dto::ResourceSnapshotDto,
        dto::TimeBlockDto,
        dto::TimeSlotDto,
        dto::TimeBlockListResponse,
        dto::TimeSlotListResponse,
        dto::CreateTimeBlockRequest,
        dto::PatchTimeBlockRequest,
        dto::MoveTimeBlockRequest,
        dto::ResizeTimeBlockRequest,
        dto::ReplanTimeBlocksRequest,
        dto::ReplanTimeBlocksActionDto,
        dto::CreateTimeSlotRequest,
        dto::PatchTimeSlotRequest,
        dto::AppendTimeSlotTaskRequest,
        dto::ReplaceTimeSlotTasksRequest,
        dto::AffectedIdsDto,
        dto::ResyncScopeDto,
        dto::CommittedEventDto,
        dto::MutationResponse,
        dto::ParseQuickEntryRequest,
        dto::QuickEntryDto,
        dto::ParseFilterRequest,
        dto::ParsedFilterResponse,
        dto::TaskFilterDto,
        dto::ParseTextImportRequest,
        dto::TextImportDraftDto,
        dto::TextImportResponse,
        dto::ReminderChannelDto,
        dto::ReminderOccurrenceStateDto,
        dto::ReminderFailureCodeDto,
        dto::ReminderOccurrenceDto,
        dto::ReminderListResponse,
        dto::RescheduleReminderRequest,
        dto::AcquireReminderLeaseRequest,
        dto::RenewReminderLeaseRequest,
        dto::ReleaseReminderLeaseRequest,
        dto::ClaimRemindersRequest,
        dto::SettleReminderDeliveredRequest,
        dto::SettleReminderFailedRequest,
        dto::MarkOwnerLostRemindersRequest,
        dto::ReminderDeliveryLeaseDto,
        dto::ClaimedReminderDto,
        dto::ClaimRemindersResponse,
        dto::MarkOwnerLostRemindersResponse,
        dto::CalendarTasksResponse,
        dto::DailyPlanResponse,
        dto::EndOfDayResponse,
        dto::WeekStartDto,
        dto::CompletionTimeBucketDto,
        dto::CompletionTimeBucketsDto,
        dto::WeeklyDayStatsDto,
        dto::NeglectedProjectReasonDto,
        dto::NeglectedProjectFactDto,
        dto::WeeklySuggestionDto,
        dto::WeeklyReviewResponse,
        dto::DailyStatBucketDto,
        dto::StatsResponse,
        dto::NudgeRuleKindDto,
        dto::NudgeRuleFactsDto,
        dto::NudgesResponse,
        dto::ThemeDto,
        dto::DensityDto,
        dto::FontSizeDto,
        dto::FontFamilyDto,
        dto::CalendarDefaultDto,
        dto::DateFormatDto,
        dto::TimeFormatDto,
        dto::WorkHoursDto,
        dto::NudgeRuleSettingsDto,
        dto::KeyboardShortcutDto,
        dto::AppearanceSettingsDto,
        dto::DateTimeSettingsDto,
        dto::TaskDefaultsDto,
        dto::NotificationSettingsDto,
        dto::FeatureSettingsDto,
        dto::PlanningSettingsDto,
        dto::AppSettingsResponse,
        dto::PatchSettingsRequest,
        dto::TemporalSettingsResponse,
        dto::EatTheFrogResponse,
        dto::TaskJarResponse,
        dto::DopamineMenuResponse,
        dto::TransferFormatDto,
        dto::ImportPreviewRequest,
        dto::ImportDraftDto,
        dto::TransferWarningDto,
        dto::TransferPreviewResponse,
        dto::NameMappingDto,
        dto::ImportApplyRequest,
        dto::ExportTasksQuery,
        dto::BackupManifestDto,
        dto::RestoreResponse,
        ReminderWakeEventDto
    )),
    modifiers(&SecurityAddon)
)]
struct ApiDoc;

#[must_use]
pub fn openapi_json() -> String {
    let mut json = ApiDoc::openapi()
        .to_pretty_json()
        .expect("OpenAPI document is serializable");
    json.push('\n');
    json
}

/// Generate a 32-byte random token encoded as 64 lowercase hex characters.
#[must_use]
pub fn generate_access_token() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    let mut token = String::with_capacity(64);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(token, "{byte:02x}");
    }
    token
}

/// Atomically replace the operator-facing private access-token file.
pub fn write_token_atomic(profile_dir: &Path, token: &str) -> io::Result<()> {
    atomic_replace_private_file(
        &profile_dir.join(TOKEN_FILE),
        format!("{token}\n").as_bytes(),
    )
}

fn persist_token_rotation_receipt(
    profile_dir: &Path,
    receipt: &TokenRotationReceipt,
) -> io::Result<()> {
    receipt.validate()?;
    let mut json = serde_json::to_vec(receipt).map_err(io::Error::other)?;
    json.push(b'\n');
    atomic_replace_private_file(&profile_dir.join(TOKEN_ROTATION_RECEIPT_FILE), &json)
}

fn load_token_rotation_receipt(profile_dir: &Path) -> io::Result<Option<TokenRotationReceipt>> {
    let path = profile_dir.join(TOKEN_ROTATION_RECEIPT_FILE);
    let data = match fs::read(&path) {
        Ok(data) => data,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let receipt: TokenRotationReceipt = serde_json::from_slice(&data).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid token rotation receipt: {error}"),
        )
    })?;
    receipt.validate()?;
    Ok(Some(receipt))
}

fn reconcile_token_rotation(
    profile_dir: &Path,
    receipt: &TokenRotationReceipt,
    token: Option<&str>,
) -> io::Result<String> {
    if token.is_some_and(|token| receipt.token_is_issued(token)) {
        return Ok(receipt.issued_token.clone());
    }
    if token.is_none_or(|token| receipt.token_is_previous(token)) {
        write_token_atomic(profile_dir, &receipt.issued_token)?;
        return Ok(receipt.issued_token.clone());
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "access token does not match durable rotation receipt",
    ))
}

pub fn load_or_create_token(profile_dir: &Path) -> io::Result<String> {
    let path = profile_dir.join(TOKEN_FILE);
    let existing = match fs::read_to_string(&path) {
        Ok(value) => Some(value.trim().to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    if let Some(receipt) = load_token_rotation_receipt(profile_dir)? {
        return reconcile_token_rotation(profile_dir, &receipt, existing.as_deref());
    }

    let token = existing
        .filter(|value| value.len() >= 64)
        .unwrap_or_else(generate_access_token);
    write_token_atomic(profile_dir, &token)?;
    Ok(token)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimeMetadata {
    pub address: SocketAddr,
    pub pid: u32,
}

pub struct RuntimeMetadataFile {
    path: PathBuf,
}

impl RuntimeMetadataFile {
    pub fn create(profile_dir: &Path, address: SocketAddr) -> io::Result<Self> {
        let path = profile_dir.join(RUNTIME_FILE);
        let metadata = RuntimeMetadata {
            address,
            pid: std::process::id(),
        };
        let mut json = serde_json::to_vec_pretty(&metadata).map_err(io::Error::other)?;
        json.push(b'\n');
        write_private_file(&path, &json)?;
        Ok(Self { path })
    }
}

impl Drop for RuntimeMetadataFile {
    fn drop(&mut self) {
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(path = %self.path.display(), %error, "could not remove runtime metadata")
            }
        }
    }
}

// Keep HeaderMap available for security_guard signature stability across refactors.
#[allow(dead_code)]
fn _touch_headers(_: &HeaderMap) {}

#[cfg(test)]
#[path = "tests_api.rs"]
mod tests;
