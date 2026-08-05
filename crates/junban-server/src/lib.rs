//! Axum router, HTTP contract, authentication, static serving, and SSE delivery.

mod ai_approval_dispatch;
mod ai_chat;
mod ai_context;
mod ai_identity;
mod ai_response_actions;
mod ai_runtime;
mod ai_tool_executor;
mod ai_tool_registry;
mod ai_tool_transcript;
mod authz;
mod credentials;
mod cursor;
mod diagnostics;
mod dto;
mod error;
mod maintenance;
mod owner_runtime;
mod reminder_wake;
mod routes;
mod routes_ai;
mod routes_ai_approvals;
mod routes_ai_turns;
mod routes_voice;
mod speech_runtime;
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
#[cfg(test)]
use std::sync::atomic::AtomicU8;
use thiserror::Error;
#[cfg(test)]
use tokio::sync::Notify;
use tokio::sync::{Mutex as AsyncMutex, broadcast};
use tokio_util::sync::CancellationToken;
use tower_http::services::{ServeDir, ServeFile};
use utoipa::{
    Modify, OpenApi,
    openapi::security::{Http, HttpAuthScheme, SecurityScheme},
};
use uuid::Uuid;

use crate::authz::{AuthorizationDecision, Principal, authorize, classify_request};
use crate::diagnostics::{DIAGNOSTIC_RING_CAPACITY, DiagnosticRing};
use crate::error::{ApiError, ErrorBody, ErrorEnvelope};
use crate::reminder_wake::{ReminderWakeEventDto, ReminderWakeHub, start_reminder_coordinator};
use crate::routes::{
    acquire_reminder_lease, add_relation, api_not_found, append_time_slot_task, apply_import,
    apply_template, bulk_tasks, calendar_tasks, cancel_task, claim_due_reminders,
    clear_diagnostics, complete_task, create_automation_credential, create_backup, create_comment,
    create_project, create_saved_filter, create_section, create_tag, create_task, create_template,
    create_time_block, create_time_slot, delete_comment, delete_project, delete_saved_filter,
    delete_section, delete_tag, delete_task, delete_template, delete_time_block, delete_time_slot,
    dismiss_reminder, events, export_tasks, get_allowed_hosts, get_catalog, get_diagnostics,
    get_maintenance_status, get_principal, get_profile, get_recovery_status, get_settings,
    get_sync_state, get_task, get_temporal_settings, health, list_automation_credentials,
    list_comments, list_relations, list_task_activity, list_task_reminders, list_tasks,
    list_time_blocks, list_time_slots, mark_owner_lost_reminders, motivation_dopamine_menu,
    motivation_eat_the_frog, motivation_task_jar, move_task, move_time_block, nudges,
    parse_filter_route, parse_quick_entry_route, parse_text_import_route, patch_comment,
    patch_project, patch_saved_filter, patch_section, patch_settings, patch_tag, patch_task,
    patch_template, patch_time_block, patch_time_slot, planning_daily, planning_end_of_day,
    planning_weekly, preview_import, preview_replan_time_blocks, put_allowed_hosts,
    recovery_api_unavailable, release_reminder_lease, reminder_events, remove_relation,
    remove_time_slot_task, renew_reminder_lease, reopen_task, reorder_tasks,
    replace_time_slot_tasks, replan_time_blocks, reschedule_reminder, resize_time_block,
    restore_backup, revoke_automation_credential, rotate_token, settle_reminder_delivered,
    settle_reminder_failed, stats, uncomplete_task, undo_operation,
};
use crate::routes_ai::{
    cancel_ai_run, clear_ai_session, create_ai_memory, create_ai_response, create_ai_session,
    delete_ai_config, delete_ai_credential, delete_ai_memory, delete_ai_session,
    discover_ai_provider_models, get_ai_config, get_ai_memory, get_ai_session, list_ai_memories,
    list_ai_messages, list_ai_providers, list_ai_sessions, patch_ai_memory, patch_ai_session,
    put_ai_config, put_ai_credential,
};
use crate::routes_ai_approvals::{approve_ai_approval, get_ai_approval, reject_ai_approval};
use crate::routes_ai_turns::{
    create_ai_daily_briefing, edit_ai_response, regenerate_ai_response, retry_ai_response,
};
use crate::routes_voice::{create_voice_speech, create_voice_transcription};
use crate::sse::{AppService, SseConnectionPermit};

pub use crate::ai_runtime::{
    AiDecisionCompletion, AiDecisionCompletionState, AiDecisionNotification, AiDecisionPayload,
    AiDecisionPermit, AiRunGuard, AiRuntimeError, AiRuntimeSupervisor, AiTerminalOutcome,
    MAX_ACTIVE_AI_RUNS, MAX_AI_DECISION_PAYLOAD_BYTES,
};
pub use crate::ai_tool_executor::{ToolExecContext, derive_child_operation_id, execute_tool};
pub use crate::ai_tool_registry::{
    AI_TOOL_COUNT, AI_TOOL_DEFAULT_COLOR, AI_TOOL_NAME_MAX_BYTES, AI_TOOL_RESULT_ENTITY_MAX,
    ToolEffect, ToolOutcome, ToolRegistration, ToolResultEnvelope, ToolValidationError,
    ValidatedToolAction, extract_task_titles_from_text, forbidden_argument_names, registration,
    tool_registrations, tool_specs, validate_tool_call,
};
pub use crate::authz::{
    AutomationScope, ClassifiedRoute, Principal as RequestPrincipal, RouteAccess, classified_routes,
};
pub use crate::credentials::{
    AUTOMATION_CREDENTIALS_FILE, AUTOMATION_TOKEN_PREFIX, AutomationCredentialMetadata,
    AutomationCredentialStore, MAX_AUTOMATION_CREDENTIALS, mint_automation_token,
    parse_automation_token, validate_create_token, validate_credential_label, validate_scope_list,
};
pub use crate::diagnostics::{DiagnosticEntry, DiagnosticSeverity, redact_secrets};
pub use crate::dto::{PrincipalKindDto, PrincipalResponse};
pub use crate::maintenance::MaintenanceGate;
pub use crate::owner_runtime::{
    DataDirPlatform, LocalApiOwner, LocalApiOwnerError, default_profile_dir,
    resolve_default_profile_dir,
};
pub use crate::reminder_wake::{REMINDER_OVERDUE_WAKE_THROTTLE, REMINDER_WAKE_EVENT_TYPE};
pub use crate::speech_runtime::{
    MAX_ACTIVE_CLOUD_SPEECH, SpeechActivityGuard, SpeechActivityKind, SpeechActivitySupervisor,
    SpeechRuntimeError,
};

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
/// Bounded AI cancel/drain deadline during process shutdown.
pub const AI_SHUTDOWN_DRAIN_DEADLINE: Duration = Duration::from_secs(5);
/// Bounded cancel/drain deadline before confirmed AI/voice reconfiguration.
pub const AI_RECONFIGURE_DRAIN_DEADLINE: Duration = Duration::from_secs(5);
/// Strict ceiling for typed AI/voice configuration and credential request bodies.
pub const MAX_AI_CONFIG_BODY_BYTES: usize = 32 * 1024;
/// Strict ceiling for one basic AI response request body.
pub const MAX_AI_RESPONSE_BODY_BYTES: usize = 32 * 1024;
/// Strict JSON ceiling for one speech synthesis request.
pub const MAX_SPEECH_SYNTHESIS_BODY_BYTES: usize = 32 * 1024;
/// Multipart envelope ceiling around one independently bounded 25 MiB audio field.
pub const MAX_SPEECH_MULTIPART_BODY_BYTES: usize = junban_ai::MAX_SPEECH_AUDIO_BYTES + 16 * 1024;
const AUTH_ATTEMPTS: usize = 8;
const AUTH_WINDOW: Duration = Duration::from_secs(30);
pub const TOKEN_FILE: &str = "access-token";
pub const TOKEN_ROTATION_RECEIPT_FILE: &str = "access-token-rotation-receipt.json";
pub const RUNTIME_FILE: &str = "runtime.json";
/// Strict version for private `runtime.json` discovery records.
pub const RUNTIME_METADATA_VERSION: u32 = 1;
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
    instance_id: Arc<str>,
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
            instance_id: Arc::from(generate_instance_id()),
        })
    }

    /// Random per-process instance id shared with runtime metadata and health.
    #[must_use]
    pub fn instance_id(&self) -> &str {
        self.instance_id.as_ref()
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

#[cfg(test)]
#[derive(Default)]
pub(crate) struct AiReconfigureTestGate {
    armed: AtomicBool,
    reached: Notify,
    release: Notify,
}

#[cfg(test)]
impl AiReconfigureTestGate {
    pub(crate) fn arm(&self) {
        self.armed.store(true, Ordering::Release);
    }

    pub(crate) async fn wait_reached(&self) {
        self.reached.notified().await;
    }

    pub(crate) fn release(&self) {
        self.release.notify_one();
    }

    pub(crate) async fn pause_after_commit(&self) {
        if self.armed.swap(false, Ordering::AcqRel) {
            self.reached.notify_one();
            self.release.notified().await;
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AiResponseSetupStage {
    BeforeCommit = 1,
    AfterCommit = 2,
    AfterAdmission = 3,
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct AiResponseSetupTestGate {
    armed: AtomicU8,
    reached: Notify,
    release: Notify,
}

#[cfg(test)]
impl AiResponseSetupTestGate {
    pub(crate) fn arm(&self, stage: AiResponseSetupStage) {
        self.armed.store(stage as u8, Ordering::Release);
    }

    pub(crate) async fn wait_reached(&self) {
        self.reached.notified().await;
    }

    pub(crate) fn release(&self) {
        self.release.notify_one();
    }

    pub(crate) async fn pause(&self, stage: AiResponseSetupStage) {
        if self
            .armed
            .compare_exchange(stage as u8, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.reached.notify_one();
            self.release.notified().await;
        }
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
    cli_hosts: Arc<RwLock<Vec<String>>>,
    allowed_hosts: Arc<RwLock<HashSet<String>>>,
    pub(crate) profile_dir: PathBuf,
    auth_limiter: Arc<AuthLimiter>,
    /// Hashed automation credentials loaded fail-closed at startup.
    pub(crate) automation_credentials: Arc<AutomationCredentialStore>,
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
    /// Lazy AI provider runtime + live-run registry (normal owner only).
    ai_runtime: Arc<AiRuntimeSupervisor>,
    /// Independent lazy cloud-speech activity and lifecycle authority.
    speech_runtime: Arc<SpeechActivitySupervisor>,
    /// Serializes atomic AI/speech lifecycle transitions against shutdown.
    ai_speech_transition: Arc<Mutex<()>>,
    /// Serializes confirmed AI/voice reconfiguration and consistent config reads.
    pub(crate) ai_reconfigure: Arc<AsyncMutex<()>>,
    #[cfg(test)]
    pub(crate) ai_reconfigure_test_gate: Arc<AiReconfigureTestGate>,
    #[cfg(test)]
    pub(crate) ai_response_setup_test_gate: Arc<AiResponseSetupTestGate>,
    /// Counts successful post-drop allocator reclaim hooks (tests only).
    #[cfg(test)]
    pub(crate) allocator_reclaim_calls: Arc<AtomicUsize>,
    /// Counts successful post-commit SQLite pager release hooks (tests only).
    #[cfg(test)]
    pub(crate) pager_release_calls: Arc<AtomicUsize>,
    /// Random per-process instance id shared with runtime metadata and health.
    instance_id: Arc<str>,
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
        // Fail closed on malformed automation authority before admitting traffic.
        let automation_credentials = AutomationCredentialStore::load(&profile_dir)?;
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
            cli_hosts: Arc::new(RwLock::new(cli_hosts)),
            allowed_hosts: Arc::new(RwLock::new(allowed_hosts)),
            profile_dir,
            auth_limiter: Arc::new(AuthLimiter::new()),
            automation_credentials: Arc::new(automation_credentials),
            shutdown: CancellationToken::new(),
            session_cancel: Arc::new(Mutex::new(CancellationToken::new())),
            rotation_receipt: Arc::new(Mutex::new(rotation_receipt)),
            staged_artifact_active: Arc::new(AtomicBool::new(false)),
            diagnostics,
            sse_connections: Arc::new(AtomicUsize::new(0)),
            active_forwarders: Arc::new(AtomicUsize::new(0)),
            reminder_coordinator: Arc::new(Mutex::new(None)),
            reminder_coordinator_stopped: Arc::new(AtomicBool::new(false)),
            ai_runtime: AiRuntimeSupervisor::new(),
            speech_runtime: Arc::new(SpeechActivitySupervisor::new()),
            ai_speech_transition: Arc::new(Mutex::new(())),
            ai_reconfigure: Arc::new(AsyncMutex::new(())),
            #[cfg(test)]
            ai_reconfigure_test_gate: Arc::new(AiReconfigureTestGate::default()),
            #[cfg(test)]
            ai_response_setup_test_gate: Arc::new(AiResponseSetupTestGate::default()),
            #[cfg(test)]
            allocator_reclaim_calls: Arc::new(AtomicUsize::new(0)),
            #[cfg(test)]
            pager_release_calls: Arc::new(AtomicUsize::new(0)),
            instance_id: Arc::from(generate_instance_id()),
        })
    }

    /// Random per-process instance id shared with runtime metadata and health.
    #[must_use]
    pub fn instance_id(&self) -> &str {
        self.instance_id.as_ref()
    }

    /// Process-wide maintenance / recovery barrier.
    #[must_use]
    pub fn maintenance(&self) -> &MaintenanceGate {
        self.maintenance.as_ref()
    }

    /// Lazy AI runtime supervisor owned by the normal profile owner only.
    #[must_use]
    pub fn ai_runtime(&self) -> &Arc<AiRuntimeSupervisor> {
        &self.ai_runtime
    }

    /// Independent lazy cloud-speech activity authority.
    #[must_use]
    pub fn speech_runtime(&self) -> &Arc<SpeechActivitySupervisor> {
        &self.speech_runtime
    }

    /// Observation helper: provider HTTP client construction count at/after startup.
    #[must_use]
    pub fn ai_provider_client_construct_calls(&self) -> usize {
        self.ai_runtime.provider_client_construct_calls()
    }

    /// Observation helper for the independently lazy speech HTTP client.
    #[must_use]
    pub fn speech_provider_client_construct_calls(&self) -> usize {
        self.speech_runtime.provider_client_construct_calls()
    }

    pub(crate) fn begin_ai_speech_reconfigure(
        &self,
    ) -> Result<(crate::ai_runtime::ReconfigureEpoch, u64), ()> {
        let _transition = self
            .ai_speech_transition
            .lock()
            .expect("AI/speech transition poisoned");
        let ai_epoch = match self.ai_runtime.begin_reconfigure() {
            Ok(epoch) => epoch,
            Err(_) => {
                self.ai_runtime.begin_permanent_drain();
                self.speech_runtime.begin_permanent_drain();
                return Err(());
            }
        };
        match self.speech_runtime.begin_reconfigure() {
            Ok(speech_epoch) => Ok((ai_epoch, speech_epoch)),
            Err(_) => {
                // This can occur only after a permanent speech drain. Invalidate
                // the temporary AI epoch rather than allowing asymmetric resume.
                self.ai_runtime.begin_permanent_drain();
                self.speech_runtime.begin_permanent_drain();
                Err(())
            }
        }
    }

    pub(crate) fn drop_ai_speech_reconfigure(
        &self,
        ai_epoch: crate::ai_runtime::ReconfigureEpoch,
        speech_epoch: u64,
    ) -> Result<(), ()> {
        {
            let _transition = self
                .ai_speech_transition
                .lock()
                .expect("AI/speech transition poisoned");
            self.ai_runtime
                .drop_reconfigure_runtime(ai_epoch)
                .map_err(|_| ())?;
            self.speech_runtime
                .drop_reconfigure_runtime(speech_epoch)
                .map_err(|_| ())?;
        }
        // Outside `ai_speech_transition`: glibc heap walks must not stall permanent drain.
        reclaim_allocator_after_runtime_drop();
        #[cfg(test)]
        self.allocator_reclaim_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    pub(crate) fn finish_ai_speech_reconfigure(
        &self,
        ai_epoch: crate::ai_runtime::ReconfigureEpoch,
        speech_epoch: u64,
    ) -> Result<(), ()> {
        let _transition = self
            .ai_speech_transition
            .lock()
            .expect("AI/speech transition poisoned");
        // Both exact dropped epochs are checked before either is resumed.
        self.ai_runtime
            .validate_finish_reconfigure(ai_epoch)
            .map_err(|_| ())?;
        self.speech_runtime
            .validate_finish_reconfigure(speech_epoch)
            .map_err(|_| ())?;
        // Neither finish can race permanent drain while this lock is retained.
        self.speech_runtime
            .finish_reconfigure(speech_epoch)
            .map_err(|_| ())?;
        self.ai_runtime.finish_reconfigure(ai_epoch).map_err(|_| ())
    }

    /// Test-only observation of successful post-drop allocator reclaim hooks.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn allocator_reclaim_calls(&self) -> usize {
        self.allocator_reclaim_calls.load(Ordering::SeqCst)
    }

    /// Test-only observation of successful post-commit SQLite pager release hooks.
    #[cfg(test)]
    #[must_use]
    pub(crate) fn pager_release_calls(&self) -> usize {
        self.pager_release_calls.load(Ordering::SeqCst)
    }

    /// Test-only counter for a successful `release_cached_memory` after reconfigure commit.
    #[cfg(test)]
    pub(crate) fn record_pager_release_success(&self) {
        self.pager_release_calls.fetch_add(1, Ordering::SeqCst);
    }

    /// Recover every exact consumed mutation approval before any normal service starts.
    ///
    /// Thin lifecycle delegate; validation, execution, transcript, and terminalization
    /// live in [`ai_approval_dispatch`]. Never constructs a provider runtime.
    pub async fn recover_ai_dispatches(&self) -> io::Result<()> {
        ai_approval_dispatch::recover_ai_dispatches(self).await
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
    /// Add listener-derived hosts after startup recovery and listener binding.
    pub fn add_cli_hosts(&self, hosts: impl IntoIterator<Item = String>) {
        let mut cli_hosts = self.cli_hosts.write().expect("CLI hosts poisoned");
        let mut allowed_hosts = self.allowed_hosts.write().expect("allowed hosts poisoned");
        for host in hosts {
            allowed_hosts.insert(host.clone());
            if !cli_hosts.contains(&host) {
                cli_hosts.push(host);
            }
        }
    }

    pub(crate) fn set_persisted_hosts(
        &self,
        persisted: Vec<String>,
    ) -> io::Result<HashSet<String>> {
        let cli_hosts = self.cli_hosts.read().expect("CLI hosts poisoned");
        let mut effective: HashSet<String> = cli_hosts.iter().cloned().collect();
        effective.extend(persisted);
        save_allowed_hosts(&self.profile_dir, &effective, cli_hosts.as_slice())?;
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

    /// Synchronously close AI and cloud-speech admission and cancel all provider work.
    ///
    /// The shared transition lock prevents a temporary reconfiguration epoch from
    /// reopening only one authority while shutdown begins.
    pub fn begin_ai_shutdown(&self) {
        let _transition = self
            .ai_speech_transition
            .lock()
            .expect("AI/speech transition poisoned");
        self.ai_runtime.begin_permanent_drain();
        self.speech_runtime.begin_permanent_drain();
    }

    /// Permanently cancel and drain AI and speech work, then drop both lazy runtimes.
    ///
    /// On timeout, both lifecycles stay permanently draining and fail-closed.
    pub async fn drain_ai_runtime(&self, deadline: Duration) -> bool {
        self.begin_ai_shutdown();
        let started = tokio::time::Instant::now();
        if !self.ai_runtime.wait_drained(deadline).await {
            return false;
        }
        let remaining = deadline.saturating_sub(started.elapsed());
        if !self.speech_runtime.wait_drained(remaining).await {
            return false;
        }
        let _transition = self
            .ai_speech_transition
            .lock()
            .expect("AI/speech transition poisoned");
        self.ai_runtime.drop_permanent_runtime().is_ok()
            && self.speech_runtime.drop_permanent_runtime().is_ok()
    }

    /// Hosted-process AI/speech teardown. A timeout may continue process exit,
    /// but cancellation must already have begun before Axum graceful drain.
    pub async fn shutdown_ai_runtime(&self, deadline: Duration) {
        if self.drain_ai_runtime(deadline).await {
            return;
        }
        tracing::warn!(
            "AI or speech runtime drain timed out during shutdown; continuing process shutdown"
        );
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

/// API routes shared by hosted and API-only runtimes (no static asset fallback).
fn api_route_table() -> Router<ServerState> {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/auth/principal", get(get_principal))
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
            "/api/v1/voice/transcriptions",
            post(create_voice_transcription)
                .layer(DefaultBodyLimit::max(MAX_SPEECH_MULTIPART_BODY_BYTES)),
        )
        .route(
            "/api/v1/voice/speech",
            post(create_voice_speech).layer(DefaultBodyLimit::max(MAX_SPEECH_SYNTHESIS_BODY_BYTES)),
        )
        .route("/api/v1/ai/providers", get(list_ai_providers))
        .route(
            "/api/v1/ai/providers/{provider}/models",
            get(discover_ai_provider_models),
        )
        .route(
            "/api/v1/ai/config",
            get(get_ai_config)
                .put(put_ai_config)
                .delete(delete_ai_config)
                .layer(DefaultBodyLimit::max(MAX_AI_CONFIG_BODY_BYTES)),
        )
        .route(
            "/api/v1/ai/credentials/{target}",
            axum::routing::put(put_ai_credential)
                .delete(delete_ai_credential)
                .layer(DefaultBodyLimit::max(MAX_AI_CONFIG_BODY_BYTES)),
        )
        .route(
            "/api/v1/ai/sessions",
            get(list_ai_sessions)
                .post(create_ai_session)
                .layer(DefaultBodyLimit::max(MAX_AI_CONFIG_BODY_BYTES)),
        )
        .route(
            "/api/v1/ai/sessions/{session_id}",
            get(get_ai_session)
                .patch(patch_ai_session)
                .delete(delete_ai_session)
                .layer(DefaultBodyLimit::max(MAX_AI_CONFIG_BODY_BYTES)),
        )
        .route(
            "/api/v1/ai/sessions/{session_id}/messages",
            get(list_ai_messages),
        )
        .route(
            "/api/v1/ai/sessions/{session_id}/responses",
            post(create_ai_response).layer(DefaultBodyLimit::max(MAX_AI_RESPONSE_BODY_BYTES)),
        )
        .route(
            "/api/v1/ai/sessions/{session_id}/daily-briefing",
            post(create_ai_daily_briefing).layer(DefaultBodyLimit::max(MAX_AI_RESPONSE_BODY_BYTES)),
        )
        .route(
            "/api/v1/ai/sessions/{session_id}/messages/{message_id}/edit",
            post(edit_ai_response).layer(DefaultBodyLimit::max(MAX_AI_RESPONSE_BODY_BYTES)),
        )
        .route(
            "/api/v1/ai/sessions/{session_id}/messages/{message_id}/retry",
            post(retry_ai_response).layer(DefaultBodyLimit::max(MAX_AI_RESPONSE_BODY_BYTES)),
        )
        .route(
            "/api/v1/ai/sessions/{session_id}/messages/{message_id}/regenerate",
            post(regenerate_ai_response).layer(DefaultBodyLimit::max(MAX_AI_RESPONSE_BODY_BYTES)),
        )
        .route("/api/v1/ai/runs/{run_id}/cancel", post(cancel_ai_run))
        .route("/api/v1/ai/approvals/{approval_id}", get(get_ai_approval))
        .route(
            "/api/v1/ai/approvals/{approval_id}/approve",
            post(approve_ai_approval).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/v1/ai/approvals/{approval_id}/reject",
            post(reject_ai_approval).layer(DefaultBodyLimit::max(4 * 1024)),
        )
        .route(
            "/api/v1/ai/sessions/{session_id}/clear",
            post(clear_ai_session),
        )
        .route(
            "/api/v1/ai/memories",
            get(list_ai_memories)
                .post(create_ai_memory)
                .layer(DefaultBodyLimit::max(MAX_AI_CONFIG_BODY_BYTES)),
        )
        .route(
            "/api/v1/ai/memories/{memory_id}",
            get(get_ai_memory)
                .patch(patch_ai_memory)
                .delete(delete_ai_memory)
                .layer(DefaultBodyLimit::max(MAX_AI_CONFIG_BODY_BYTES)),
        )
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
            "/api/v1/auth/credentials",
            get(list_automation_credentials).post(create_automation_credential),
        )
        .route(
            "/api/v1/auth/credentials/{credential_id}",
            delete(revoke_automation_credential),
        )
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
}

fn finish_api_router(router: Router<ServerState>, state: ServerState) -> Router {
    // Layer order (outermost last): security → maintenance → body limit → handler.
    // Authorization must reject before oversized/malformed body processing and before
    // maintenance/staging admission so missing scope cannot probe those surfaces.
    router
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            maintenance_guard,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_guard,
        ))
        .with_state(state)
}

/// Builds the reusable API + static UI router.
pub fn router(state: ServerState, web_dir: impl Into<PathBuf>) -> Router {
    let web_dir = web_dir.into();
    let index = web_dir.join("index.html");
    let static_files = ServeDir::new(web_dir).fallback(ServeFile::new(index));
    finish_api_router(api_route_table().fallback_service(static_files), state)
}

/// API-only router for in-process temporary owners (no frontend assets).
pub fn api_only_router(state: ServerState) -> Router {
    finish_api_router(api_route_table().fallback(api_not_found), state)
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
    // Only the versioned API surface is authenticated. Bare `/api` and unknown
    // `/api/*` fallbacks stay public so they can return JSON 404 without a bearer.
    let access = if path.starts_with("/api/v1") {
        classify_request(request.method(), path)
    } else if path.starts_with("/api") {
        RouteAccess::Public
    } else {
        classify_request(request.method(), path)
    };
    if !matches!(access, RouteAccess::Public) {
        let presented = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        let principal = match resolve_principal(&state, &request, presented) {
            Some(principal) => principal,
            None => {
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
        };

        match authorize(&principal, access) {
            AuthorizationDecision::Allow => {
                request.extensions_mut().insert(principal);
            }
            AuthorizationDecision::DenyOperatorOnly => {
                state.log_diagnostic(
                    DiagnosticSeverity::Warning,
                    "operator_required",
                    Some(&request_id.0),
                    "operator credential required",
                );
                return secure_response(
                    ApiError::new(
                        StatusCode::FORBIDDEN,
                        "operator_required",
                        "this route requires the operator credential",
                        false,
                        &request_id,
                    )
                    .into_response(),
                    &request_id,
                );
            }
            AuthorizationDecision::DenyScope(scope) => {
                state.log_diagnostic(
                    DiagnosticSeverity::Warning,
                    "insufficient_scope",
                    Some(&request_id.0),
                    &format!("missing required scope {scope}"),
                );
                return secure_response(
                    ApiError::new(
                        StatusCode::FORBIDDEN,
                        "insufficient_scope",
                        format!("this route requires the `{scope}` scope"),
                        false,
                        &request_id,
                    )
                    .with_field("required_scope", scope.as_str())
                    .into_response(),
                    &request_id,
                );
            }
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

fn resolve_principal(
    state: &ServerState,
    request: &Request,
    presented: Option<&str>,
) -> Option<Principal> {
    let presented = presented?;
    if state.previous_token_retry_allowed(request, presented) {
        return Some(Principal::Operator);
    }
    let current = state.current_token();
    // A receipt-first rotation whose token-file write failed has not completed;
    // the still-current credential remains valid while an exact retry can finish it.
    if presented.as_bytes() == current.as_bytes() {
        return Some(Principal::Operator);
    }
    let now = jiff::Timestamp::now();
    state
        .automation_credentials
        .authenticate(presented, now)
        .map(|automation| Principal::Automation {
            id: automation.id,
            scopes: automation.scopes,
        })
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
            "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://huggingface.co https://*.huggingface.co https://hf.co https://*.hf.co; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; manifest-src 'self'",
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
        routes_voice::create_voice_transcription,
        routes_voice::create_voice_speech,
        routes_ai::list_ai_providers,
        routes_ai::get_ai_config,
        routes_ai::put_ai_config,
        routes_ai::delete_ai_config,
        routes_ai::put_ai_credential,
        routes_ai::delete_ai_credential,
        routes_ai::discover_ai_provider_models,
        routes_ai::list_ai_sessions,
        routes_ai::create_ai_session,
        routes_ai::get_ai_session,
        routes_ai::patch_ai_session,
        routes_ai::delete_ai_session,
        routes_ai::list_ai_messages,
        routes_ai::create_ai_response,
        routes_ai_turns::create_ai_daily_briefing,
        routes_ai_turns::edit_ai_response,
        routes_ai_turns::retry_ai_response,
        routes_ai_turns::regenerate_ai_response,
        routes_ai::cancel_ai_run,
        routes_ai_approvals::get_ai_approval,
        routes_ai_approvals::approve_ai_approval,
        routes_ai_approvals::reject_ai_approval,
        routes_ai::clear_ai_session,
        routes_ai::list_ai_memories,
        routes_ai::create_ai_memory,
        routes_ai::get_ai_memory,
        routes_ai::patch_ai_memory,
        routes_ai::delete_ai_memory,
        routes::preview_import,
        routes::apply_import,
        routes::export_tasks,
        routes::create_backup,
        routes::restore_backup,
        routes::motivation_eat_the_frog,
        routes::motivation_task_jar,
        routes::motivation_dopamine_menu,
        routes::get_principal,
        routes::rotate_token,
        routes::list_automation_credentials,
        routes::create_automation_credential,
        routes::revoke_automation_credential,
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
        dto::PrincipalKindDto,
        dto::PrincipalResponse,
        dto::AutomationScopeDto,
        dto::AutomationCredentialDto,
        dto::AutomationCredentialListResponse,
        dto::CreateAutomationCredentialRequest,
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
        routes_voice::SpeechTranscriptionMultipart,
        routes_voice::SpeechBinaryResponse,
        routes_voice::SpeechSynthesisRequest,
        routes_voice::TranscriptionResponse,
        routes_ai::AiProviderPresetDto,
        routes_ai::SpeechProviderPresetDto,
        routes_ai::VoiceModeDto,
        routes_ai::AiSecretKindDto,
        routes_ai::AiCredentialTargetDto,
        routes_ai::ProviderOriginClassDto,
        routes_ai::ProviderCapabilityDto,
        routes_ai::AiProviderRegistryEntry,
        routes_ai::AiProviderRegistryResponse,
        routes_ai::AiSettingsDto,
        routes_ai::VoiceSettingsDto,
        routes_ai::AiCredentialMetadataDto,
        routes_ai::AiCredentialBindingsDto,
        routes_ai::AiConfigResponse,
        routes_ai::AiConfigPutRequest,
        routes_ai::AiConfigInput,
        routes_ai::VoiceConfigInput,
        routes_ai::PutAiCredentialRequest,
        routes_ai::AiCredentialBindingResponse,
        routes_ai::DiscoveredModelDto,
        routes_ai::ModelDiscoveryResponse,
        routes_ai::CreateAiResponseRequest,
        routes_ai_turns::EmptyAiResponseActionRequest,
        routes_ai_turns::EditAiResponseRequest,
        routes_ai::CancelAiRunResponse,
        ai_chat::AiRunSseEnvelope,
        ai_chat::AiRunEventType,
        ai_context::AiContextMetadata,
        routes_ai::AiSessionStatusDto,
        routes_ai::AiSessionDto,
        routes_ai::AiMemoryDto,
        routes_ai::AiMessageRoleDto,
        routes_ai::AiMessageStatusDto,
        routes_ai::AiMessageContentDto,
        routes_ai::AiMessageDto,
        routes_ai::CreateAiSessionHttpRequest,
        routes_ai::PatchAiSessionRequest,
        routes_ai::CreateAiMemoryHttpRequest,
        routes_ai::PatchAiMemoryRequest,
        routes_ai::AiSessionListResponse,
        routes_ai::AiMessageListResponse,
        routes_ai::AiMemoryListResponse,
        routes_ai::AiSessionMutationResponse,
        routes_ai::AiMemoryMutationResponse,
        routes_ai_approvals::AiApprovalDecisionRequest,
        routes_ai_approvals::AiApprovalDto,
        routes_ai_approvals::AiApprovalMessageDto,
        routes_ai_approvals::AiApprovalRunDto,
        routes_ai_approvals::AiApprovalResponse,
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

/// Generate a random per-process instance id for runtime discovery matching.
#[must_use]
pub fn generate_instance_id() -> String {
    Uuid::new_v4().to_string()
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

/// Private discovery record published by an active owner. Not authoritative and never secret-bearing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeMetadata {
    pub version: u32,
    pub address: SocketAddr,
    pub pid: u32,
    pub instance_id: String,
}

/// Strict decode failure for private runtime metadata.
#[derive(Debug, Error)]
pub enum RuntimeMetadataError {
    #[error("runtime metadata is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported runtime metadata version {found} (expected {RUNTIME_METADATA_VERSION})")]
    UnsupportedVersion { found: u32 },
    #[error("runtime metadata instance_id must be non-empty")]
    EmptyInstanceId,
}

impl RuntimeMetadata {
    /// Parse and validate a versioned runtime metadata record.
    pub fn parse(data: &[u8]) -> Result<Self, RuntimeMetadataError> {
        let metadata: Self = serde_json::from_slice(data)?;
        metadata.validate()?;
        Ok(metadata)
    }

    fn validate(&self) -> Result<(), RuntimeMetadataError> {
        if self.version != RUNTIME_METADATA_VERSION {
            return Err(RuntimeMetadataError::UnsupportedVersion {
                found: self.version,
            });
        }
        if self.instance_id.is_empty() {
            return Err(RuntimeMetadataError::EmptyInstanceId);
        }
        Ok(())
    }
}

/// Read and strictly parse `runtime.json` when present.
pub fn read_runtime_metadata(
    profile_dir: &Path,
) -> io::Result<Option<Result<RuntimeMetadata, RuntimeMetadataError>>> {
    let path = profile_dir.join(RUNTIME_FILE);
    match fs::read(&path) {
        Ok(data) => Ok(Some(RuntimeMetadata::parse(&data))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub struct RuntimeMetadataFile {
    path: PathBuf,
}

impl RuntimeMetadataFile {
    pub fn create(profile_dir: &Path, address: SocketAddr, instance_id: &str) -> io::Result<Self> {
        if instance_id.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "runtime metadata instance_id must be non-empty",
            ));
        }
        let path = profile_dir.join(RUNTIME_FILE);
        let metadata = RuntimeMetadata {
            version: RUNTIME_METADATA_VERSION,
            address,
            pid: std::process::id(),
            instance_id: instance_id.to_owned(),
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

/// Return freeable heap pages to the OS after optional AI/speech runtimes drop.
///
/// First reqwest/rustls/TTS use warms multi-MiB glibc arenas whose free lists
/// stay in anonymous cgroup memory after Rust `Drop`. Call only after both
/// supervisors confirm an exact-epoch runtime drop during clean temporary
/// reconfiguration. Never call on disabled startup, per-request hot paths, or
/// while holding [`ServerState::ai_speech_transition`] (which would stall
/// permanent drain). Non-Linux-GNU targets are a documented no-op.
fn reclaim_allocator_after_runtime_drop() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // SAFETY: `malloc_trim` is a glibc extension that walks free heap chunks
        // and returns unused pages to the OS. `pad == 0` trims as aggressively as
        // glibc allows. It does not free live allocations, does not touch Junban
        // locks or SQLite state, and is safe concurrent with other malloc/free.
        // We never call it while holding `ai_speech_transition`.
        #[allow(unsafe_code)]
        unsafe {
            let _released = libc::malloc_trim(0);
        }
    }
}

#[cfg(test)]
mod allocator_reclaim_tests {
    use super::reclaim_allocator_after_runtime_drop;
    use junban_storage::ProfileOwner;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: PathBuf,
        _owner: ProfileOwner,
        state: super::ServerState,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "junban-alloc-reclaim-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            ));
            let profile = root.join("profile");
            fs::create_dir_all(&profile).unwrap();
            let owner = ProfileOwner::open(&profile).unwrap();
            let state = super::ServerState::new(
                owner.repository(),
                "test-token".to_owned(),
                ["127.0.0.1".to_owned()],
                profile,
            )
            .unwrap();
            Self {
                root,
                _owner: owner,
                state,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn disabled_startup_does_not_reclaim() {
        let fixture = Fixture::new();
        assert_eq!(fixture.state.allocator_reclaim_calls(), 0);
        // Direct helper is a platform no-op or glibc trim; it must not touch lifecycle counts.
        reclaim_allocator_after_runtime_drop();
        assert_eq!(fixture.state.allocator_reclaim_calls(), 0);
    }

    #[test]
    fn successful_exact_epoch_drop_reaches_reclaim_hook_once() {
        let fixture = Fixture::new();
        let (ai_epoch, speech_epoch) = fixture.state.begin_ai_speech_reconfigure().unwrap();
        assert_eq!(fixture.state.allocator_reclaim_calls(), 0);
        fixture
            .state
            .drop_ai_speech_reconfigure(ai_epoch, speech_epoch)
            .unwrap();
        assert_eq!(fixture.state.allocator_reclaim_calls(), 1);
        fixture
            .state
            .finish_ai_speech_reconfigure(ai_epoch, speech_epoch)
            .unwrap();
        assert_eq!(
            fixture.state.allocator_reclaim_calls(),
            1,
            "finish must not reclaim again"
        );
    }

    #[test]
    fn repeated_drop_of_same_epoch_does_not_reclaim_again() {
        let fixture = Fixture::new();
        let (ai_epoch, speech_epoch) = fixture.state.begin_ai_speech_reconfigure().unwrap();
        fixture
            .state
            .drop_ai_speech_reconfigure(ai_epoch, speech_epoch)
            .unwrap();
        assert_eq!(fixture.state.allocator_reclaim_calls(), 1);
        assert!(
            fixture
                .state
                .drop_ai_speech_reconfigure(ai_epoch, speech_epoch)
                .is_err()
        );
        assert_eq!(fixture.state.allocator_reclaim_calls(), 1);
    }

    #[test]
    fn asymmetric_speech_drop_failure_does_not_reclaim() {
        let fixture = Fixture::new();
        let (ai_epoch, speech_epoch) = fixture.state.begin_ai_speech_reconfigure().unwrap();
        assert!(
            fixture
                .state
                .drop_ai_speech_reconfigure(ai_epoch, speech_epoch.wrapping_add(1))
                .is_err()
        );
        assert_eq!(
            fixture.state.allocator_reclaim_calls(),
            0,
            "reclaim only after both AI and speech exact-epoch drops succeed"
        );
        // Permanent drain invalidates the temporary epoch; reclaim stays closed.
        fixture.state.begin_ai_shutdown();
        assert!(
            fixture
                .state
                .drop_ai_speech_reconfigure(ai_epoch, speech_epoch)
                .is_err()
        );
        assert_eq!(fixture.state.allocator_reclaim_calls(), 0);
    }

    #[test]
    fn permanent_drain_drop_path_does_not_use_reconfigure_reclaim() {
        let fixture = Fixture::new();
        assert_eq!(fixture.state.allocator_reclaim_calls(), 0);
        // Permanent drain drops under a different lifecycle than temporary reconfigure.
        let drained = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(
                fixture
                    .state
                    .drain_ai_runtime(std::time::Duration::from_secs(1)),
            );
        assert!(drained);
        assert_eq!(fixture.state.allocator_reclaim_calls(), 0);
    }
}

#[cfg(test)]
#[path = "tests_api.rs"]
mod tests;
