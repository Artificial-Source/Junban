//! Runtime-local bounded resync transcript authority.
//!
//! The accumulator retains only delivery/session authority, compact counters and
//! digests, traversal position, and the bounded staged KV candidate. Request and
//! outcome bodies are validated, hashed, and immediately discarded.

use std::collections::BTreeMap;

use junban_plugin_sdk::{
    InvocationKind, InvocationOutcome, InvocationRequest, Sha256Digest, decode_invocation_outcome,
    decode_invocation_request,
    private_body_types::{
        FinalKvChoice, FlushState, KvOperation, KvSegment, ResourceKind, ResyncPage,
        ResyncPageOutcome, SnapshotRecords, WitResult,
    },
};

use crate::{
    PLUGIN_KV_BYTES_MAX, PLUGIN_KV_KEYS_MAX, PLUGIN_KV_VALUE_BYTES_MAX,
    PLUGIN_RESYNC_PAGE_BYTES_MAX, PLUGIN_RESYNC_PAGE_ITEMS_MAX, PluginDeliveryMode,
    PluginInvocationDelivery, PluginInvocationDeliveryCheck, PluginResyncPage,
    PluginResyncPageRequest, PluginResyncSession, PluginSnapshotItem, PluginSnapshotKind,
    RepositoryError, plugin_resync_payload_hash,
};

const TRANSCRIPT_INITIAL_DOMAIN: &[u8] = b"junban.plugin.resync-transcript.v1\0";
const TRANSCRIPT_STEP_DOMAIN: &[u8] = b"junban.plugin.resync-transcript-step.v1\0";
const REPLACEMENT_MAP_DOMAIN: &[u8] = b"junban.plugin.resync-kv.v1\0";
const COMMIT_AUTHORITY_DOMAIN: &[u8] = b"junban.plugin.resync.commit-authority.v1\0";
const RESYNC_PERSISTED_ENTRY_ID: &str = "resync";
const FLUSH_REQUESTS_MAX: u8 = 10;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TranscriptPhase {
    Snapshot(PluginSnapshotKind),
    Flush,
    Finalized,
}

/// Nonpersisted accumulator for one exact bounded resync exchange.
#[derive(Debug)]
pub struct PluginResyncTranscript {
    delivery: PluginInvocationDelivery,
    session: PluginResyncSession,
    transcript_sha256: Sha256Digest,
    step_count: u32,
    snapshot_pages: u32,
    snapshot_pages_by_kind: [u32; 3],
    snapshot_items_by_kind: [u64; 3],
    snapshot_bytes_by_kind: [u64; 3],
    last_snapshot_ids: [Option<String>; 3],
    last_snapshot_page_sha256: [Option<Sha256Digest>; 3],
    flush_requests: u8,
    finalize_count: u8,
    phase: TranscriptPhase,
    after_id: Option<String>,
    staged_kv: BTreeMap<String, Vec<u8>>,
    staged_kv_bytes: usize,
    last_staged_key: Option<String>,
    final_choice: Option<FinalKvChoice>,
    final_request_sha256: Option<Sha256Digest>,
}

impl PluginResyncTranscript {
    /// Start a transcript bound to one exact authorized resync invocation.
    pub fn new(
        delivery: PluginInvocationDelivery,
        session: PluginResyncSession,
    ) -> Result<Self, RepositoryError> {
        validate_delivery_session(&delivery, &session)?;
        let transcript_sha256 = initial_transcript_hash(&delivery, &session)?;
        Ok(Self {
            delivery,
            session,
            transcript_sha256,
            step_count: 0,
            snapshot_pages: 0,
            snapshot_pages_by_kind: [0; 3],
            snapshot_items_by_kind: [0; 3],
            snapshot_bytes_by_kind: [0; 3],
            last_snapshot_ids: std::array::from_fn(|_| None),
            last_snapshot_page_sha256: std::array::from_fn(|_| None),
            flush_requests: 0,
            finalize_count: 0,
            phase: TranscriptPhase::Snapshot(PluginSnapshotKind::Task),
            after_id: None,
            staged_kv: BTreeMap::new(),
            staged_kv_bytes: 0,
            last_staged_key: None,
            final_choice: None,
            final_request_sha256: None,
        })
    }

    #[must_use]
    pub fn delivery(&self) -> &PluginInvocationDelivery {
        &self.delivery
    }

    #[must_use]
    pub fn session(&self) -> &PluginResyncSession {
        &self.session
    }

    #[must_use]
    pub fn next_step_index(&self) -> u32 {
        self.step_count
    }

    /// Validate and absorb one mandatory snapshot page and its exact guest ack.
    pub fn record_snapshot(
        &mut self,
        page_request: &PluginResyncPageRequest,
        page: &PluginResyncPage,
        request_body: &[u8],
        outcome_body: &[u8],
    ) -> Result<(), RepositoryError> {
        let TranscriptPhase::Snapshot(expected_kind) = self.phase else {
            return Err(RepositoryError::Conflict);
        };
        if page_request.session != self.session
            || page_request.kind != expected_kind
            || page_request.after_id != self.after_id
            || page.operation_id != self.session.operation_id
            || page.kind != expected_kind
        {
            return Err(RepositoryError::Conflict);
        }
        validate_page_position(page_request.after_id.as_deref(), page)?;

        let request = decode_resync_request(&self.delivery, request_body)?;
        let ResyncPage::Snapshot(snapshot) = request else {
            return Err(RepositoryError::Conflict);
        };
        let final_snapshot_page = expected_kind == PluginSnapshotKind::Tag && page.exhausted;
        let expected_records = snapshot_records(page, self.session.snapshot_revision)?;
        if snapshot.session_id != self.session.operation_id.to_string()
            || snapshot.event_epoch != self.session.snapshot_event_epoch
            || snapshot.head_revision != self.session.snapshot_revision
            || snapshot.kind != resource_kind(expected_kind)
            || snapshot.page_index != self.step_count
            || snapshot.records != expected_records
            || snapshot.final_snapshot_page != final_snapshot_page
        {
            return Err(RepositoryError::Conflict);
        }

        let outcome = decode_resync_outcome(outcome_body)?;
        let ResyncPageOutcome::SnapshotAck(ack) = outcome else {
            return Err(RepositoryError::Conflict);
        };
        if ack.session_id != snapshot.session_id
            || ack.page_index != snapshot.page_index
            || ack.kind != snapshot.kind
        {
            return Err(RepositoryError::Conflict);
        }
        self.validate_segment(ack.segment.as_ref())?;

        let next_phase = if page.exhausted {
            match expected_kind {
                PluginSnapshotKind::Task => TranscriptPhase::Snapshot(PluginSnapshotKind::Project),
                PluginSnapshotKind::Project => TranscriptPhase::Snapshot(PluginSnapshotKind::Tag),
                PluginSnapshotKind::Tag => TranscriptPhase::Flush,
            }
        } else {
            TranscriptPhase::Snapshot(expected_kind)
        };
        let next_after_id = if page.exhausted {
            None
        } else {
            page.next_after_id.clone()
        };
        let next_digest = step_transcript_hash(
            &self.transcript_sha256,
            self.step_count,
            0x00,
            request_body,
            outcome_body,
        )?;
        self.append_segment(ack.segment);
        self.transcript_sha256 = next_digest.clone();
        self.step_count = self
            .step_count
            .checked_add(1)
            .ok_or(RepositoryError::OperationTooLarge)?;
        self.snapshot_pages = self
            .snapshot_pages
            .checked_add(1)
            .ok_or(RepositoryError::OperationTooLarge)?;
        let kind_index = snapshot_kind_index(expected_kind);
        self.snapshot_pages_by_kind[kind_index] = self.snapshot_pages_by_kind[kind_index]
            .checked_add(1)
            .ok_or(RepositoryError::OperationTooLarge)?;
        self.snapshot_items_by_kind[kind_index] = self.snapshot_items_by_kind[kind_index]
            .checked_add(
                u64::try_from(page.items.len()).map_err(|_| RepositoryError::OperationTooLarge)?,
            )
            .ok_or(RepositoryError::OperationTooLarge)?;
        self.snapshot_bytes_by_kind[kind_index] = self.snapshot_bytes_by_kind[kind_index]
            .checked_add(
                u64::try_from(page.material_bytes)
                    .map_err(|_| RepositoryError::OperationTooLarge)?,
            )
            .ok_or(RepositoryError::OperationTooLarge)?;
        if let Some(last_id) = page.next_after_id.clone() {
            self.last_snapshot_ids[kind_index] = Some(last_id);
        }
        self.last_snapshot_page_sha256[kind_index] = Some(next_digest);
        self.phase = next_phase;
        self.after_id = next_after_id;
        Ok(())
    }

    /// Validate and absorb one globally contiguous flush request.
    pub fn record_flush(
        &mut self,
        request_body: &[u8],
        outcome_body: &[u8],
    ) -> Result<(), RepositoryError> {
        if self.phase != TranscriptPhase::Flush || self.flush_requests >= FLUSH_REQUESTS_MAX {
            return Err(RepositoryError::Conflict);
        }
        let request = decode_resync_request(&self.delivery, request_body)?;
        let ResyncPage::FlushStagedKv(flush) = request else {
            return Err(RepositoryError::Conflict);
        };
        if flush.session_id != self.session.operation_id.to_string()
            || flush.request_index != self.flush_requests
        {
            return Err(RepositoryError::Conflict);
        }
        let outcome = decode_resync_outcome(outcome_body)?;
        let ResyncPageOutcome::FlushAck(ack) = outcome else {
            return Err(RepositoryError::Conflict);
        };
        if ack.session_id != flush.session_id || ack.request_index != flush.request_index {
            return Err(RepositoryError::Conflict);
        }
        if ack.state == FlushState::More
            && ack
                .segment
                .as_ref()
                .is_none_or(|segment| segment.operations.is_empty())
        {
            return Err(RepositoryError::Conflict);
        }
        if ack.state == FlushState::More && self.flush_requests == FLUSH_REQUESTS_MAX - 1 {
            return Err(RepositoryError::Conflict);
        }
        self.validate_segment(ack.segment.as_ref())?;
        let next_digest = step_transcript_hash(
            &self.transcript_sha256,
            self.step_count,
            0x01,
            request_body,
            outcome_body,
        )?;
        self.append_segment(ack.segment);
        self.transcript_sha256 = next_digest;
        self.step_count = self
            .step_count
            .checked_add(1)
            .ok_or(RepositoryError::OperationTooLarge)?;
        self.flush_requests += 1;
        if ack.state == FlushState::Complete {
            self.phase = TranscriptPhase::Finalized;
        }
        Ok(())
    }

    /// Validate the one required finalize callback and freeze its final KV choice.
    pub fn record_finalize(
        &mut self,
        request_body: &[u8],
        outcome_body: &[u8],
    ) -> Result<(), RepositoryError> {
        if self.phase != TranscriptPhase::Finalized
            || self.flush_requests == 0
            || self.finalize_count != 0
        {
            return Err(RepositoryError::Conflict);
        }
        let request = decode_resync_request(&self.delivery, request_body)?;
        let ResyncPage::Finalize(finalize) = request else {
            return Err(RepositoryError::Conflict);
        };
        if finalize.session_id != self.session.operation_id.to_string() {
            return Err(RepositoryError::Conflict);
        }
        let outcome = decode_resync_outcome(outcome_body)?;
        let ResyncPageOutcome::Finalized(finalized) = outcome else {
            return Err(RepositoryError::Conflict);
        };
        if finalized.session_id != finalize.session_id {
            return Err(RepositoryError::Conflict);
        }
        let next_digest = step_transcript_hash(
            &self.transcript_sha256,
            self.step_count,
            0x02,
            request_body,
            outcome_body,
        )?;
        self.transcript_sha256 = next_digest;
        self.step_count = self
            .step_count
            .checked_add(1)
            .ok_or(RepositoryError::OperationTooLarge)?;
        self.finalize_count = 1;
        self.final_choice = Some(finalized.choice);
        self.final_request_sha256 = Some(Sha256Digest::of(request_body));
        Ok(())
    }

    /// Consume the runtime-local accumulator into the only storage finalization packet.
    pub fn into_finalize_request(self) -> Result<FinalizePluginResyncRequest, RepositoryError> {
        let choice = self.final_choice.ok_or(RepositoryError::Conflict)?;
        if self.finalize_count != 1 || self.phase != TranscriptPhase::Finalized {
            return Err(RepositoryError::Conflict);
        }
        let candidate_sha256 = replacement_map_hash(self.staged_kv.iter())?;
        let candidate_keys = self.staged_kv.len();
        let candidate = self.staged_kv.into_iter().collect();
        let mut commit = PluginResyncTranscriptCommit {
            transcript_sha256: self.transcript_sha256,
            step_count: self.step_count,
            snapshot_pages: self.snapshot_pages,
            snapshot_pages_by_kind: self.snapshot_pages_by_kind,
            snapshot_items_by_kind: self.snapshot_items_by_kind,
            snapshot_bytes_by_kind: self.snapshot_bytes_by_kind,
            last_snapshot_ids: self.last_snapshot_ids,
            last_snapshot_page_sha256: self.last_snapshot_page_sha256,
            flush_requests: self.flush_requests,
            finalize_count: self.finalize_count,
            candidate_keys,
            candidate_bytes: self.staged_kv_bytes,
            candidate_sha256,
            final_request_sha256: self.final_request_sha256.ok_or(RepositoryError::Conflict)?,
            choice,
            candidate,
            integrity_sha256: Sha256Digest::of(&[]),
        };
        commit.integrity_sha256 = commit_integrity_hash(&self.delivery, &self.session, &commit)?;
        commit.validate(&self.delivery, &self.session)?;
        Ok(FinalizePluginResyncRequest {
            delivery: self.delivery,
            session: self.session,
            transcript: commit,
        })
    }

    fn validate_segment(&self, segment: Option<&KvSegment>) -> Result<(), RepositoryError> {
        let Some(segment) = segment else {
            return Ok(());
        };
        let mut previous = self.last_staged_key.as_deref();
        let mut projected_keys = self.staged_kv.len();
        let mut projected_bytes = self.staged_kv_bytes;
        for operation in &segment.operations {
            let KvOperation::Set(set) = operation else {
                return Err(RepositoryError::Conflict);
            };
            if previous.is_some_and(|old| old >= set.key.as_str())
                || !valid_kv_key(&set.key)
                || set.value.as_slice().len() > PLUGIN_KV_VALUE_BYTES_MAX
            {
                return Err(RepositoryError::Conflict);
            }
            projected_keys = projected_keys
                .checked_add(1)
                .ok_or(RepositoryError::OperationTooLarge)?;
            projected_bytes = projected_bytes
                .checked_add(set.value.as_slice().len())
                .ok_or(RepositoryError::OperationTooLarge)?;
            if projected_keys > PLUGIN_KV_KEYS_MAX || projected_bytes > PLUGIN_KV_BYTES_MAX {
                return Err(RepositoryError::OperationTooLarge);
            }
            previous = Some(&set.key);
        }
        Ok(())
    }

    fn append_segment(&mut self, segment: Option<KvSegment>) {
        let Some(segment) = segment else {
            return;
        };
        for operation in segment.operations {
            let KvOperation::Set(set) = operation else {
                unreachable!("segment was validated as SET-only");
            };
            let value = set.value.into_vec();
            self.staged_kv_bytes += value.len();
            self.last_staged_key = Some(set.key.clone());
            let prior = self.staged_kv.insert(set.key, value);
            debug_assert!(prior.is_none());
        }
    }
}

/// Compact, nonserializable final transcript proof presented to SQLite.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginResyncTranscriptCommit {
    transcript_sha256: Sha256Digest,
    step_count: u32,
    snapshot_pages: u32,
    snapshot_pages_by_kind: [u32; 3],
    snapshot_items_by_kind: [u64; 3],
    snapshot_bytes_by_kind: [u64; 3],
    last_snapshot_ids: [Option<String>; 3],
    last_snapshot_page_sha256: [Option<Sha256Digest>; 3],
    flush_requests: u8,
    finalize_count: u8,
    candidate_keys: usize,
    candidate_bytes: usize,
    candidate_sha256: Sha256Digest,
    final_request_sha256: Sha256Digest,
    choice: FinalKvChoice,
    candidate: Vec<(String, Vec<u8>)>,
    integrity_sha256: Sha256Digest,
}

impl PluginResyncTranscriptCommit {
    pub fn validate(
        &self,
        delivery: &PluginInvocationDelivery,
        session: &PluginResyncSession,
    ) -> Result<(), RepositoryError> {
        validate_delivery_session(delivery, session)?;
        let snapshot_sum = self
            .snapshot_pages_by_kind
            .into_iter()
            .try_fold(0_u32, |sum, count| sum.checked_add(count))
            .ok_or(RepositoryError::OperationTooLarge)?;
        let expected_steps = self
            .snapshot_pages
            .checked_add(u32::from(self.flush_requests))
            .and_then(|count| count.checked_add(u32::from(self.finalize_count)))
            .ok_or(RepositoryError::OperationTooLarge)?;
        let compact_snapshot_invalid = (0..3).any(|index| {
            let page_count = u64::from(self.snapshot_pages_by_kind[index]);
            let maximum_items = page_count.saturating_mul(PLUGIN_RESYNC_PAGE_ITEMS_MAX as u64);
            let maximum_bytes = page_count.saturating_mul(PLUGIN_RESYNC_PAGE_BYTES_MAX as u64);
            self.snapshot_items_by_kind[index] > maximum_items
                || self.snapshot_bytes_by_kind[index] > maximum_bytes
                || self.last_snapshot_ids[index].is_some()
                    != (self.snapshot_items_by_kind[index] != 0)
                || self.last_snapshot_page_sha256[index].is_none()
        });
        if self
            .snapshot_pages_by_kind
            .into_iter()
            .any(|count| count == 0)
            || compact_snapshot_invalid
            || snapshot_sum != self.snapshot_pages
            || self.flush_requests == 0
            || self.flush_requests > FLUSH_REQUESTS_MAX
            || self.finalize_count != 1
            || expected_steps != self.step_count
            || self.candidate_keys > PLUGIN_KV_KEYS_MAX
            || self.candidate_bytes > PLUGIN_KV_BYTES_MAX
            || commit_integrity_hash(delivery, session, self)? != self.integrity_sha256
        {
            return Err(RepositoryError::Conflict);
        }
        validate_replacement(&self.candidate)?;
        if self.candidate.len() != self.candidate_keys
            || self
                .candidate
                .iter()
                .map(|(_, value)| value.len())
                .sum::<usize>()
                != self.candidate_bytes
            || replacement_map_hash(self.candidate.iter().map(|(key, value)| (key, value)))?
                != self.candidate_sha256
        {
            return Err(RepositoryError::Conflict);
        }
        Ok(())
    }

    #[must_use]
    pub fn transcript_sha256(&self) -> &Sha256Digest {
        &self.transcript_sha256
    }

    #[must_use]
    pub const fn step_count(&self) -> u32 {
        self.step_count
    }

    #[must_use]
    pub const fn snapshot_pages(&self) -> u32 {
        self.snapshot_pages
    }

    #[must_use]
    pub const fn snapshot_pages_by_kind(&self) -> [u32; 3] {
        self.snapshot_pages_by_kind
    }

    #[must_use]
    pub const fn snapshot_items_by_kind(&self) -> [u64; 3] {
        self.snapshot_items_by_kind
    }

    #[must_use]
    pub const fn snapshot_bytes_by_kind(&self) -> [u64; 3] {
        self.snapshot_bytes_by_kind
    }

    #[must_use]
    pub fn last_snapshot_ids(&self) -> &[Option<String>; 3] {
        &self.last_snapshot_ids
    }

    #[must_use]
    pub fn last_snapshot_page_sha256(&self) -> &[Option<Sha256Digest>; 3] {
        &self.last_snapshot_page_sha256
    }

    #[must_use]
    pub const fn flush_requests(&self) -> u8 {
        self.flush_requests
    }

    #[must_use]
    pub const fn finalize_count(&self) -> u8 {
        self.finalize_count
    }

    #[must_use]
    pub const fn candidate_keys(&self) -> usize {
        self.candidate_keys
    }

    #[must_use]
    pub const fn candidate_bytes(&self) -> usize {
        self.candidate_bytes
    }

    #[must_use]
    pub fn candidate_sha256(&self) -> &Sha256Digest {
        &self.candidate_sha256
    }

    #[must_use]
    pub fn final_request_sha256(&self) -> &Sha256Digest {
        &self.final_request_sha256
    }

    #[must_use]
    pub const fn choice(&self) -> FinalKvChoice {
        self.choice
    }

    #[must_use]
    pub fn replacement(&self) -> Option<&[(String, Vec<u8>)]> {
        match self.choice {
            FinalKvChoice::LeaveKv => None,
            FinalKvChoice::ReplaceKvWithStagedSegments => Some(&self.candidate),
        }
    }
}

/// Exact authority-bearing packet for the one SQLite finalization transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FinalizePluginResyncRequest {
    pub delivery: PluginInvocationDelivery,
    pub session: PluginResyncSession,
    pub transcript: PluginResyncTranscriptCommit,
}

/// A valid commit or a consumed failed invocation that must start a fresh resync.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FinalizePluginResyncOutcome {
    Committed(crate::PluginEventCursor),
    RestartRequired,
}

fn validate_delivery_session(
    delivery: &PluginInvocationDelivery,
    session: &PluginResyncSession,
) -> Result<(), RepositoryError> {
    delivery.verify(PluginInvocationDeliveryCheck {
        operation_id: session.operation_id,
        plugin_id: &session.plugin_id,
        package_generation: session.package_generation,
        activation_epoch: session.activation_epoch,
        hook: crate::PluginHookKind::Resync,
        persisted_entry_id: &delivery.persisted_entry_id,
        stored_request_sha256: &delivery.request_sha256,
    })?;
    if delivery.persisted_entry_id.as_str() != RESYNC_PERSISTED_ENTRY_ID
        || delivery.authority.mode != PluginDeliveryMode::StartingResync
        || delivery.authority.invocation_id != session.operation_id
        || delivery.authority.plugin_id != session.plugin_id
        || delivery.authority.package_generation != session.package_generation
        || delivery.authority.activation_epoch != session.activation_epoch
        || delivery.authority.payload_sha256 != plugin_resync_payload_hash(session)
        || !session.expected_cursor.resync_required
        || session.expected_cursor.event_epoch != session.snapshot_event_epoch
        || session.snapshot_revision == 0
        || session.snapshot_revision > i64::MAX as u64
    {
        return Err(RepositoryError::Conflict);
    }
    Ok(())
}

fn decode_resync_request(
    delivery: &PluginInvocationDelivery,
    body: &[u8],
) -> Result<ResyncPage, RepositoryError> {
    let decoded = decode_invocation_request(InvocationKind::Resync, body)
        .map_err(|_| RepositoryError::Conflict)?;
    if serde_json::to_vec(&decoded).map_err(|_| RepositoryError::Conflict)? != body
        || decoded.entry_id() != Some(delivery.persisted_entry_id.as_str())
    {
        return Err(RepositoryError::Conflict);
    }
    let InvocationRequest::Resync(payload) = decoded else {
        return Err(RepositoryError::Conflict);
    };
    Ok(payload.into_parts().1)
}

fn decode_resync_outcome(body: &[u8]) -> Result<ResyncPageOutcome, RepositoryError> {
    let decoded = decode_invocation_outcome(InvocationKind::Resync, body)
        .map_err(|_| RepositoryError::Conflict)?;
    if serde_json::to_vec(&decoded).map_err(|_| RepositoryError::Conflict)? != body {
        return Err(RepositoryError::Conflict);
    }
    let InvocationOutcome::Resync(result) = decoded else {
        return Err(RepositoryError::Conflict);
    };
    match result {
        WitResult::Ok(outcome) => Ok(outcome),
        WitResult::Err(_) => Err(RepositoryError::Conflict),
    }
}

fn snapshot_records(
    page: &PluginResyncPage,
    snapshot_revision: u64,
) -> Result<SnapshotRecords, RepositoryError> {
    match page.kind {
        PluginSnapshotKind::Task => page
            .items
            .iter()
            .map(|item| match item {
                PluginSnapshotItem::Task(task) => {
                    crate::plugin_event::task_view(task, snapshot_revision)
                }
                _ => Err(crate::PluginEventError::Malformed),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(SnapshotRecords::Tasks),
        PluginSnapshotKind::Project => page
            .items
            .iter()
            .map(|item| match item {
                PluginSnapshotItem::Project(project) => {
                    crate::plugin_event::project_view(project, snapshot_revision)
                }
                _ => Err(crate::PluginEventError::Malformed),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(SnapshotRecords::Projects),
        PluginSnapshotKind::Tag => page
            .items
            .iter()
            .map(|item| match item {
                PluginSnapshotItem::Tag(tag) => {
                    crate::plugin_event::tag_view(tag, snapshot_revision)
                }
                _ => Err(crate::PluginEventError::Malformed),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(SnapshotRecords::Tags),
    }
    .map_err(|_| RepositoryError::Conflict)
}

fn validate_page_position(
    after_id: Option<&str>,
    page: &PluginResyncPage,
) -> Result<(), RepositoryError> {
    if !page.exhausted && page.items.is_empty() {
        return Err(RepositoryError::Conflict);
    }
    let ids: Vec<_> = page.items.iter().map(PluginSnapshotItem::id).collect();
    if ids.windows(2).any(|pair| pair[0] >= pair[1])
        || after_id.is_some_and(|after| ids.first().is_some_and(|first| after >= first.as_str()))
        || page.next_after_id != ids.last().cloned()
    {
        return Err(RepositoryError::Conflict);
    }
    Ok(())
}

const fn resource_kind(kind: PluginSnapshotKind) -> ResourceKind {
    match kind {
        PluginSnapshotKind::Task => ResourceKind::Task,
        PluginSnapshotKind::Project => ResourceKind::Project,
        PluginSnapshotKind::Tag => ResourceKind::Tag,
    }
}

const fn snapshot_kind_index(kind: PluginSnapshotKind) -> usize {
    match kind {
        PluginSnapshotKind::Task => 0,
        PluginSnapshotKind::Project => 1,
        PluginSnapshotKind::Tag => 2,
    }
}

fn initial_transcript_hash(
    delivery: &PluginInvocationDelivery,
    session: &PluginResyncSession,
) -> Result<Sha256Digest, RepositoryError> {
    let mut material = Vec::with_capacity(TRANSCRIPT_INITIAL_DOMAIN.len() + 64);
    material.extend_from_slice(TRANSCRIPT_INITIAL_DOMAIN);
    material.extend_from_slice(&digest_bytes(&delivery.authority.digest()?)?);
    material.extend_from_slice(&digest_bytes(&plugin_resync_payload_hash(session))?);
    Ok(Sha256Digest::of(&material))
}

fn step_transcript_hash(
    previous: &Sha256Digest,
    step_index: u32,
    request_tag: u8,
    request_body: &[u8],
    outcome_body: &[u8],
) -> Result<Sha256Digest, RepositoryError> {
    let request_len =
        u32::try_from(request_body.len()).map_err(|_| RepositoryError::OperationTooLarge)?;
    let outcome_len =
        u32::try_from(outcome_body.len()).map_err(|_| RepositoryError::OperationTooLarge)?;
    let mut material = Vec::with_capacity(
        TRANSCRIPT_STEP_DOMAIN.len() + 32 + 4 + 1 + 4 + request_body.len() + 4 + outcome_body.len(),
    );
    material.extend_from_slice(TRANSCRIPT_STEP_DOMAIN);
    material.extend_from_slice(&digest_bytes(previous)?);
    material.extend_from_slice(&step_index.to_be_bytes());
    material.push(request_tag);
    material.extend_from_slice(&request_len.to_be_bytes());
    material.extend_from_slice(request_body);
    material.extend_from_slice(&outcome_len.to_be_bytes());
    material.extend_from_slice(outcome_body);
    Ok(Sha256Digest::of(&material))
}

fn replacement_map_hash<'a>(
    entries: impl IntoIterator<Item = (&'a String, &'a Vec<u8>)>,
) -> Result<Sha256Digest, RepositoryError> {
    let entries: Vec<_> = entries.into_iter().collect();
    let count = u32::try_from(entries.len()).map_err(|_| RepositoryError::OperationTooLarge)?;
    let mut material = Vec::with_capacity(REPLACEMENT_MAP_DOMAIN.len() + 4 + PLUGIN_KV_BYTES_MAX);
    material.extend_from_slice(REPLACEMENT_MAP_DOMAIN);
    material.extend_from_slice(&count.to_be_bytes());
    for (key, value) in entries {
        let key_length =
            u32::try_from(key.len()).map_err(|_| RepositoryError::OperationTooLarge)?;
        let value_length =
            u32::try_from(value.len()).map_err(|_| RepositoryError::OperationTooLarge)?;
        material.extend_from_slice(&key_length.to_be_bytes());
        material.extend_from_slice(key.as_bytes());
        material.extend_from_slice(&value_length.to_be_bytes());
        material.extend_from_slice(value);
    }
    Ok(Sha256Digest::of(&material))
}

fn commit_integrity_hash(
    delivery: &PluginInvocationDelivery,
    session: &PluginResyncSession,
    commit: &PluginResyncTranscriptCommit,
) -> Result<Sha256Digest, RepositoryError> {
    let candidate_keys =
        u32::try_from(commit.candidate_keys).map_err(|_| RepositoryError::OperationTooLarge)?;
    let candidate_bytes =
        u64::try_from(commit.candidate_bytes).map_err(|_| RepositoryError::OperationTooLarge)?;
    let mut material = Vec::with_capacity(256);
    material.extend_from_slice(COMMIT_AUTHORITY_DOMAIN);
    material.extend_from_slice(&digest_bytes(&delivery.authority.digest()?)?);
    material.extend_from_slice(&digest_bytes(&plugin_resync_payload_hash(session))?);
    material.extend_from_slice(&digest_bytes(&commit.transcript_sha256)?);
    material.extend_from_slice(&commit.step_count.to_be_bytes());
    material.extend_from_slice(&commit.snapshot_pages.to_be_bytes());
    for count in commit.snapshot_pages_by_kind {
        material.extend_from_slice(&count.to_be_bytes());
    }
    for count in commit.snapshot_items_by_kind {
        material.extend_from_slice(&count.to_be_bytes());
    }
    for count in commit.snapshot_bytes_by_kind {
        material.extend_from_slice(&count.to_be_bytes());
    }
    for last_id in &commit.last_snapshot_ids {
        material.push(u8::from(last_id.is_some()));
        if let Some(last_id) = last_id {
            put_text(&mut material, last_id)?;
        }
    }
    for page_sha256 in &commit.last_snapshot_page_sha256 {
        material.push(u8::from(page_sha256.is_some()));
        if let Some(page_sha256) = page_sha256 {
            material.extend_from_slice(&digest_bytes(page_sha256)?);
        }
    }
    material.push(commit.flush_requests);
    material.push(commit.finalize_count);
    material.extend_from_slice(&candidate_keys.to_be_bytes());
    material.extend_from_slice(&candidate_bytes.to_be_bytes());
    material.extend_from_slice(&digest_bytes(&commit.candidate_sha256)?);
    material.extend_from_slice(&digest_bytes(&commit.final_request_sha256)?);
    material.push(match commit.choice {
        FinalKvChoice::LeaveKv => 0x00,
        FinalKvChoice::ReplaceKvWithStagedSegments => 0x01,
    });
    Ok(Sha256Digest::of(&material))
}

fn validate_replacement(entries: &[(String, Vec<u8>)]) -> Result<(), RepositoryError> {
    let mut previous: Option<&str> = None;
    let mut bytes = 0_usize;
    if entries.len() > PLUGIN_KV_KEYS_MAX {
        return Err(RepositoryError::OperationTooLarge);
    }
    for (key, value) in entries {
        bytes = bytes
            .checked_add(value.len())
            .ok_or(RepositoryError::OperationTooLarge)?;
        if previous.is_some_and(|old| old >= key.as_str())
            || !valid_kv_key(key)
            || value.len() > PLUGIN_KV_VALUE_BYTES_MAX
            || bytes > PLUGIN_KV_BYTES_MAX
        {
            return Err(RepositoryError::Conflict);
        }
        previous = Some(key);
    }
    Ok(())
}

fn valid_kv_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.chars().any(|character| {
            character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

fn put_text(material: &mut Vec<u8>, value: &str) -> Result<(), RepositoryError> {
    let length = u64::try_from(value.len()).map_err(|_| RepositoryError::OperationTooLarge)?;
    material.extend_from_slice(&length.to_be_bytes());
    material.extend_from_slice(value.as_bytes());
    Ok(())
}

fn digest_bytes(digest: &Sha256Digest) -> Result<[u8; 32], RepositoryError> {
    let mut bytes = [0_u8; 32];
    if digest.as_str().len() != 64 {
        return Err(RepositoryError::Conflict);
    }
    for (index, slot) in bytes.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&digest.as_str()[index * 2..index * 2 + 2], 16)
            .map_err(|_| RepositoryError::Conflict)?;
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use junban_domain::{OperationId, Task, TaskId, TaskTitle};
    use junban_plugin_sdk::{
        InvocationOutcome, InvocationRequest, PluginId, Sha256Digest,
        private_body_types::{
            ByteList, FinalKvChoice, FinalizeResync, FinalizedResync, FlushAck, FlushStagedKv,
            FlushState, KvOperation, KvSegment, KvSet, PluginError, ResyncPage, ResyncPageOutcome,
            SnapshotAck, SnapshotPage, SnapshotRecords, WitResult,
        },
    };

    use super::*;
    use crate::{
        PluginCursorPosition, PluginDeliveryAuthority, PluginHookKind, PluginInvocationDelivery,
        PluginResyncPage, PluginResyncPageRequest, PluginResyncSession, PluginSnapshotKind,
        plugin_resync_payload_hash,
    };

    const OPERATION_ID: &str = "70000000-0000-7000-8000-000000000001";
    const HOST_SESSION_ID: &str = "70000000-0000-7000-8000-000000000002";
    const EVENT_EPOCH: &str = "70000000-0000-7000-8000-000000000003";

    fn session() -> PluginResyncSession {
        PluginResyncSession {
            operation_id: OperationId::parse(OPERATION_ID).unwrap(),
            plugin_id: PluginId::parse("transcript-fixture").unwrap(),
            package_generation: 4,
            activation_epoch: 9,
            expected_cursor: PluginCursorPosition {
                event_epoch: EVENT_EPOCH.to_owned(),
                revision: 3,
                resync_required: true,
            },
            snapshot_event_epoch: EVENT_EPOCH.to_owned(),
            snapshot_revision: 7,
        }
    }

    fn delivery(session: &PluginResyncSession) -> PluginInvocationDelivery {
        PluginInvocationDelivery::new(
            PluginDeliveryAuthority {
                plugin_id: session.plugin_id.clone(),
                package_generation: session.package_generation,
                activation_epoch: session.activation_epoch,
                host_session_id: OperationId::parse(HOST_SESSION_ID).unwrap(),
                invocation_id: session.operation_id,
                payload_sha256: plugin_resync_payload_hash(session),
                mode: PluginDeliveryMode::StartingResync,
            },
            PluginHookKind::Resync,
            PluginId::parse("resync").unwrap(),
        )
        .unwrap()
    }

    fn transcript() -> PluginResyncTranscript {
        let session = session();
        PluginResyncTranscript::new(delivery(&session), session).unwrap()
    }

    fn encode_request(page: ResyncPage) -> Vec<u8> {
        serde_json::to_vec(&InvocationRequest::resync(Some("resync".to_owned()), page)).unwrap()
    }

    fn encode_outcome(outcome: ResyncPageOutcome) -> Vec<u8> {
        serde_json::to_vec(&InvocationOutcome::Resync(WitResult::<_, PluginError>::Ok(
            outcome,
        )))
        .unwrap()
    }

    fn empty_snapshot_step(
        transcript: &mut PluginResyncTranscript,
        kind: PluginSnapshotKind,
        index: u32,
        segment: Option<KvSegment>,
    ) -> (Vec<u8>, Vec<u8>) {
        let session = transcript.session().clone();
        let request = PluginResyncPageRequest {
            session: session.clone(),
            kind,
            after_id: None,
        };
        let page = PluginResyncPage {
            operation_id: session.operation_id,
            kind,
            items: Vec::new(),
            next_after_id: None,
            exhausted: true,
            material_bytes: 0,
        };
        let resource_kind = resource_kind(kind);
        let records = match kind {
            PluginSnapshotKind::Task => SnapshotRecords::Tasks(Vec::new()),
            PluginSnapshotKind::Project => SnapshotRecords::Projects(Vec::new()),
            PluginSnapshotKind::Tag => SnapshotRecords::Tags(Vec::new()),
        };
        let request_body = encode_request(ResyncPage::Snapshot(SnapshotPage {
            session_id: session.operation_id.to_string(),
            event_epoch: session.snapshot_event_epoch.clone(),
            head_revision: session.snapshot_revision,
            kind: resource_kind,
            page_index: index,
            records,
            final_snapshot_page: kind == PluginSnapshotKind::Tag,
        }));
        let outcome_body = encode_outcome(ResyncPageOutcome::SnapshotAck(SnapshotAck {
            session_id: session.operation_id.to_string(),
            page_index: index,
            kind: resource_kind,
            segment,
        }));
        transcript
            .record_snapshot(&request, &page, &request_body, &outcome_body)
            .unwrap();
        (request_body, outcome_body)
    }

    fn record_empty_snapshot_sequence(transcript: &mut PluginResyncTranscript) {
        empty_snapshot_step(transcript, PluginSnapshotKind::Task, 0, None);
        empty_snapshot_step(transcript, PluginSnapshotKind::Project, 1, None);
        empty_snapshot_step(transcript, PluginSnapshotKind::Tag, 2, None);
    }

    fn set_segment(key: &str, value: &[u8]) -> KvSegment {
        KvSegment {
            operations: vec![KvOperation::Set(KvSet {
                key: key.to_owned(),
                value: ByteList::new(value.to_vec()).unwrap(),
            })],
        }
    }

    fn record_flush(
        transcript: &mut PluginResyncTranscript,
        index: u8,
        segment: Option<KvSegment>,
        state: FlushState,
    ) -> (Vec<u8>, Vec<u8>) {
        let session_id = transcript.session().operation_id.to_string();
        let request = encode_request(ResyncPage::FlushStagedKv(FlushStagedKv {
            session_id: session_id.clone(),
            request_index: index,
        }));
        let outcome = encode_outcome(ResyncPageOutcome::FlushAck(FlushAck {
            session_id,
            request_index: index,
            segment,
            state,
        }));
        transcript.record_flush(&request, &outcome).unwrap();
        (request, outcome)
    }

    fn record_finalize(
        transcript: &mut PluginResyncTranscript,
        choice: FinalKvChoice,
    ) -> (Vec<u8>, Vec<u8>) {
        let session_id = transcript.session().operation_id.to_string();
        let request = encode_request(ResyncPage::Finalize(FinalizeResync {
            session_id: session_id.clone(),
        }));
        let outcome = encode_outcome(ResyncPageOutcome::Finalized(FinalizedResync {
            session_id,
            choice,
        }));
        transcript.record_finalize(&request, &outcome).unwrap();
        (request, outcome)
    }

    fn complete(choice: FinalKvChoice, segment: Option<KvSegment>) -> FinalizePluginResyncRequest {
        let mut transcript = transcript();
        record_empty_snapshot_sequence(&mut transcript);
        record_flush(&mut transcript, 0, segment, FlushState::Complete);
        record_finalize(&mut transcript, choice);
        transcript.into_finalize_request().unwrap()
    }

    #[test]
    fn exact_initial_and_each_step_hash_goldens_and_body_tampering() {
        let mut transcript = transcript();
        assert_eq!(
            transcript.transcript_sha256.as_str(),
            "f69eba50b56723eec1d0f6df49894e683ae5f22b19828cf3639a074c7497912b"
        );
        let (task_request, _) =
            empty_snapshot_step(&mut transcript, PluginSnapshotKind::Task, 0, None);
        assert_eq!(
            transcript.transcript_sha256.as_str(),
            "c10756a53fd46e7af7ae028180b1a68ef8cc958c36c242d4c0e798dd312ff5a8"
        );
        empty_snapshot_step(&mut transcript, PluginSnapshotKind::Project, 1, None);
        assert_eq!(
            transcript.transcript_sha256.as_str(),
            "e1bb9c3adc862de44366cecdde5fe7a476dc6ff41c57989716f82fe4d38fc0e6"
        );
        empty_snapshot_step(&mut transcript, PluginSnapshotKind::Tag, 2, None);
        assert_eq!(
            transcript.transcript_sha256.as_str(),
            "f75304adb8e0d8668b0ec07b22d11a335076b928fcf7d33cc6d75a730b3d2c56"
        );
        record_flush(&mut transcript, 0, None, FlushState::Complete);
        assert_eq!(
            transcript.transcript_sha256.as_str(),
            "82f99cf1ed2f06d0ee1e5c950a65b9238a9cc01dd92896ffb1c9a615fdf060a5"
        );
        record_finalize(&mut transcript, FinalKvChoice::LeaveKv);
        assert_eq!(
            transcript.transcript_sha256.as_str(),
            "26ecb5e10ece32338abd3a09303fd05528675587b5deb47a323132a64857657e"
        );

        let mut noncanonical = task_request.clone();
        noncanonical.push(b' ');
        let mut rejected = self::transcript();
        let session = rejected.session().clone();
        let page_request = PluginResyncPageRequest {
            session: session.clone(),
            kind: PluginSnapshotKind::Task,
            after_id: None,
        };
        let page = PluginResyncPage {
            operation_id: session.operation_id,
            kind: PluginSnapshotKind::Task,
            items: Vec::new(),
            next_after_id: None,
            exhausted: true,
            material_bytes: 0,
        };
        let outcome = encode_outcome(ResyncPageOutcome::SnapshotAck(SnapshotAck {
            session_id: session.operation_id.to_string(),
            page_index: 0,
            kind: ResourceKind::Task,
            segment: None,
        }));
        assert_eq!(
            rejected.record_snapshot(&page_request, &page, &noncanonical, &outcome),
            Err(RepositoryError::Conflict)
        );
        let mut noncanonical_outcome = outcome;
        noncanonical_outcome.push(b' ');
        let mut rejected = self::transcript();
        assert_eq!(
            rejected.record_snapshot(&page_request, &page, &task_request, &noncanonical_outcome,),
            Err(RepositoryError::Conflict)
        );
    }

    #[test]
    fn exact_authority_and_one_field_step_tampering_fail_closed() {
        let session = session();
        let mut wrong = delivery(&session);
        wrong.authority.host_session_id = OperationId::new();
        assert_eq!(
            PluginResyncTranscript::new(wrong, session.clone()).unwrap_err(),
            RepositoryError::Conflict
        );

        let mut transcript = transcript();
        let request = PluginResyncPageRequest {
            session: session.clone(),
            kind: PluginSnapshotKind::Task,
            after_id: None,
        };
        let page = PluginResyncPage {
            operation_id: session.operation_id,
            kind: PluginSnapshotKind::Task,
            items: Vec::new(),
            next_after_id: None,
            exhausted: true,
            material_bytes: 0,
        };
        let body = encode_request(ResyncPage::Snapshot(SnapshotPage {
            session_id: OperationId::new().to_string(),
            event_epoch: session.snapshot_event_epoch.clone(),
            head_revision: session.snapshot_revision,
            kind: ResourceKind::Task,
            page_index: 0,
            records: SnapshotRecords::Tasks(Vec::new()),
            final_snapshot_page: false,
        }));
        let outcome = encode_outcome(ResyncPageOutcome::SnapshotAck(SnapshotAck {
            session_id: session.operation_id.to_string(),
            page_index: 0,
            kind: ResourceKind::Task,
            segment: None,
        }));
        assert_eq!(
            transcript.record_snapshot(&request, &page, &body, &outcome),
            Err(RepositoryError::Conflict)
        );
        assert_eq!(transcript.next_step_index(), 0);

        let mut early_marker = self::transcript();
        let marker_body = encode_request(ResyncPage::Snapshot(SnapshotPage {
            session_id: session.operation_id.to_string(),
            event_epoch: session.snapshot_event_epoch.clone(),
            head_revision: session.snapshot_revision,
            kind: ResourceKind::Task,
            page_index: 0,
            records: SnapshotRecords::Tasks(Vec::new()),
            final_snapshot_page: true,
        }));
        assert_eq!(
            early_marker.record_snapshot(&request, &page, &marker_body, &outcome),
            Err(RepositoryError::Conflict)
        );

        let mut missing_marker = self::transcript();
        empty_snapshot_step(&mut missing_marker, PluginSnapshotKind::Task, 0, None);
        empty_snapshot_step(&mut missing_marker, PluginSnapshotKind::Project, 1, None);
        let tag_request = PluginResyncPageRequest {
            session: session.clone(),
            kind: PluginSnapshotKind::Tag,
            after_id: None,
        };
        let tag_page = PluginResyncPage {
            operation_id: session.operation_id,
            kind: PluginSnapshotKind::Tag,
            items: Vec::new(),
            next_after_id: None,
            exhausted: true,
            material_bytes: 0,
        };
        let tag_body = encode_request(ResyncPage::Snapshot(SnapshotPage {
            session_id: session.operation_id.to_string(),
            event_epoch: session.snapshot_event_epoch,
            head_revision: session.snapshot_revision,
            kind: ResourceKind::Tag,
            page_index: 2,
            records: SnapshotRecords::Tags(Vec::new()),
            final_snapshot_page: false,
        }));
        let tag_outcome = encode_outcome(ResyncPageOutcome::SnapshotAck(SnapshotAck {
            session_id: session.operation_id.to_string(),
            page_index: 2,
            kind: ResourceKind::Tag,
            segment: None,
        }));
        assert_eq!(
            missing_marker.record_snapshot(&tag_request, &tag_page, &tag_body, &tag_outcome),
            Err(RepositoryError::Conflict)
        );
    }

    #[test]
    fn empty_traversal_is_mandatory_and_global_indices_do_not_reset() {
        let mut transcript = transcript();
        let mut wrong = transcript.session().clone();
        let wrong_request = PluginResyncPageRequest {
            session: wrong.clone(),
            kind: PluginSnapshotKind::Project,
            after_id: None,
        };
        let wrong_page = PluginResyncPage {
            operation_id: wrong.operation_id,
            kind: PluginSnapshotKind::Project,
            items: Vec::new(),
            next_after_id: None,
            exhausted: true,
            material_bytes: 0,
        };
        let request_body = encode_request(ResyncPage::Snapshot(SnapshotPage {
            session_id: wrong.operation_id.to_string(),
            event_epoch: wrong.snapshot_event_epoch.clone(),
            head_revision: wrong.snapshot_revision,
            kind: ResourceKind::Project,
            page_index: 0,
            records: SnapshotRecords::Projects(Vec::new()),
            final_snapshot_page: false,
        }));
        let outcome_body = encode_outcome(ResyncPageOutcome::SnapshotAck(SnapshotAck {
            session_id: wrong.operation_id.to_string(),
            page_index: 0,
            kind: ResourceKind::Project,
            segment: None,
        }));
        assert_eq!(
            transcript.record_snapshot(&wrong_request, &wrong_page, &request_body, &outcome_body),
            Err(RepositoryError::Conflict)
        );
        record_empty_snapshot_sequence(&mut transcript);
        assert_eq!(transcript.next_step_index(), 3);
        wrong.snapshot_revision += 1;
        assert_ne!(wrong, *transcript.session());
    }

    #[test]
    fn multipage_task_traversal_binds_after_id_revision_and_global_indices() {
        let mut transcript = transcript();
        let now: Timestamp = "2026-08-05T12:34:56Z".parse().unwrap();
        let first = Task::new(
            TaskId::parse("70000000-0000-7000-8000-000000000010").unwrap(),
            TaskTitle::new("First").unwrap(),
            None,
            now,
            6,
        );
        let second = Task::new(
            TaskId::parse("70000000-0000-7000-8000-000000000011").unwrap(),
            TaskTitle::new("Second").unwrap(),
            None,
            now,
            7,
        );
        let record_page = |transcript: &mut PluginResyncTranscript,
                           task: Task,
                           after_id: Option<String>,
                           index: u32,
                           exhausted: bool|
         -> Result<(), RepositoryError> {
            let session = transcript.session().clone();
            let next_after_id = Some(task.id.to_string());
            let request = PluginResyncPageRequest {
                session: session.clone(),
                kind: PluginSnapshotKind::Task,
                after_id,
            };
            let page = PluginResyncPage {
                operation_id: session.operation_id,
                kind: PluginSnapshotKind::Task,
                items: vec![PluginSnapshotItem::Task(Box::new(task.clone()))],
                next_after_id,
                exhausted,
                material_bytes: 0,
            };
            let request_body = encode_request(ResyncPage::Snapshot(SnapshotPage {
                session_id: session.operation_id.to_string(),
                event_epoch: session.snapshot_event_epoch,
                head_revision: session.snapshot_revision,
                kind: ResourceKind::Task,
                page_index: index,
                records: SnapshotRecords::Tasks(vec![
                    crate::plugin_event::task_view(&task, session.snapshot_revision).unwrap(),
                ]),
                final_snapshot_page: false,
            }));
            let outcome_body = encode_outcome(ResyncPageOutcome::SnapshotAck(SnapshotAck {
                session_id: session.operation_id.to_string(),
                page_index: index,
                kind: ResourceKind::Task,
                segment: None,
            }));
            transcript.record_snapshot(&request, &page, &request_body, &outcome_body)
        };
        record_page(&mut transcript, first.clone(), None, 0, false).unwrap();
        let first_id = first.id.to_string();
        assert_eq!(transcript.after_id.as_deref(), Some(first_id.as_str()));
        assert_eq!(
            record_page(&mut transcript, second.clone(), None, 1, true),
            Err(RepositoryError::Conflict)
        );
        let second_id = second.id.to_string();
        record_page(&mut transcript, second, Some(first.id.to_string()), 1, true).unwrap();
        empty_snapshot_step(&mut transcript, PluginSnapshotKind::Project, 2, None);
        empty_snapshot_step(&mut transcript, PluginSnapshotKind::Tag, 3, None);
        assert_eq!(transcript.next_step_index(), 4);
        assert_eq!(transcript.snapshot_pages_by_kind, [2, 1, 1]);
        assert_eq!(transcript.snapshot_items_by_kind, [2, 0, 0]);
        assert_eq!(
            transcript.last_snapshot_ids[0].as_deref(),
            Some(second_id.as_str())
        );
        assert!(
            transcript
                .last_snapshot_page_sha256
                .iter()
                .all(Option::is_some)
        );
        record_flush(&mut transcript, 0, None, FlushState::Complete);
        record_finalize(&mut transcript, FinalKvChoice::LeaveKv);
        let committed = transcript.into_finalize_request().unwrap();
        assert_eq!(committed.transcript.snapshot_pages_by_kind(), [2, 1, 1]);
        assert_eq!(committed.transcript.snapshot_items_by_kind(), [2, 0, 0]);
        assert_eq!(committed.transcript.snapshot_bytes_by_kind(), [0, 0, 0]);
        assert_eq!(
            committed.transcript.last_snapshot_ids()[0].as_deref(),
            Some(second_id.as_str())
        );

        let stale = self::transcript();
        let mut too_new = first;
        too_new.revision = stale.session().snapshot_revision + 1;
        let stale_page = PluginResyncPage {
            operation_id: stale.session().operation_id,
            kind: PluginSnapshotKind::Task,
            items: vec![PluginSnapshotItem::Task(Box::new(too_new))],
            next_after_id: None,
            exhausted: true,
            material_bytes: 0,
        };
        assert_eq!(
            snapshot_records(&stale_page, stale.session().snapshot_revision),
            Err(RepositoryError::Conflict)
        );
    }

    #[test]
    fn flush_boundaries_and_every_sequence_gate_are_enforced() {
        let mut complete_zero = transcript();
        record_empty_snapshot_sequence(&mut complete_zero);
        record_flush(&mut complete_zero, 0, None, FlushState::Complete);
        let (finalize_request, finalize_outcome) =
            record_finalize(&mut complete_zero, FinalKvChoice::LeaveKv);

        let mut complete_nine = transcript();
        record_empty_snapshot_sequence(&mut complete_nine);
        for index in 0..9 {
            record_flush(
                &mut complete_nine,
                index,
                Some(set_segment(&format!("key-{index:02}"), &[index])),
                FlushState::More,
            );
        }
        record_flush(&mut complete_nine, 9, None, FlushState::Complete);
        record_finalize(
            &mut complete_nine,
            FinalKvChoice::ReplaceKvWithStagedSegments,
        );

        let mut skipped = transcript();
        record_empty_snapshot_sequence(&mut skipped);
        let session_id = skipped.session().operation_id.to_string();
        let request = encode_request(ResyncPage::FlushStagedKv(FlushStagedKv {
            session_id: session_id.clone(),
            request_index: 1,
        }));
        let outcome = encode_outcome(ResyncPageOutcome::FlushAck(FlushAck {
            session_id,
            request_index: 1,
            segment: None,
            state: FlushState::Complete,
        }));
        assert_eq!(
            skipped.record_flush(&request, &outcome),
            Err(RepositoryError::Conflict)
        );
        let mut post_complete = transcript();
        record_empty_snapshot_sequence(&mut post_complete);
        record_flush(&mut post_complete, 0, None, FlushState::Complete);
        assert_eq!(
            post_complete.record_flush(&request, &outcome),
            Err(RepositoryError::Conflict)
        );
        let mut duplicate = transcript();
        record_empty_snapshot_sequence(&mut duplicate);
        record_flush(
            &mut duplicate,
            0,
            Some(set_segment("a", &[1])),
            FlushState::More,
        );
        let session_id = duplicate.session().operation_id.to_string();
        let request = encode_request(ResyncPage::FlushStagedKv(FlushStagedKv {
            session_id: session_id.clone(),
            request_index: 0,
        }));
        let outcome = encode_outcome(ResyncPageOutcome::FlushAck(FlushAck {
            session_id,
            request_index: 0,
            segment: Some(set_segment("b", &[2])),
            state: FlushState::Complete,
        }));
        assert_eq!(
            duplicate.record_flush(&request, &outcome),
            Err(RepositoryError::Conflict)
        );

        let mut empty_more = transcript();
        record_empty_snapshot_sequence(&mut empty_more);
        let session_id = empty_more.session().operation_id.to_string();
        let request = encode_request(ResyncPage::FlushStagedKv(FlushStagedKv {
            session_id: session_id.clone(),
            request_index: 0,
        }));
        let outcome = encode_outcome(ResyncPageOutcome::FlushAck(FlushAck {
            session_id,
            request_index: 0,
            segment: Some(KvSegment {
                operations: Vec::new(),
            }),
            state: FlushState::More,
        }));
        assert_eq!(
            empty_more.record_flush(&request, &outcome),
            Err(RepositoryError::Conflict)
        );

        let mut no_complete = transcript();
        record_empty_snapshot_sequence(&mut no_complete);
        let session_id = no_complete.session().operation_id.to_string();
        let request = encode_request(ResyncPage::Finalize(FinalizeResync {
            session_id: session_id.clone(),
        }));
        let outcome = encode_outcome(ResyncPageOutcome::Finalized(FinalizedResync {
            session_id,
            choice: FinalKvChoice::LeaveKv,
        }));
        assert_eq!(
            no_complete.record_finalize(&request, &outcome),
            Err(RepositoryError::Conflict)
        );
        assert_eq!(
            no_complete.into_finalize_request().unwrap_err(),
            RepositoryError::Conflict
        );

        assert_eq!(
            complete_zero.record_finalize(&finalize_request, &finalize_outcome),
            Err(RepositoryError::Conflict)
        );
        assert_eq!(
            complete_zero.record_flush(&request, &outcome),
            Err(RepositoryError::Conflict)
        );

        let mut index_ten = transcript();
        record_empty_snapshot_sequence(&mut index_ten);
        index_ten.flush_requests = 10;
        let session_id = index_ten.session().operation_id.to_string();
        let request = encode_request(ResyncPage::FlushStagedKv(FlushStagedKv {
            session_id: session_id.clone(),
            request_index: 10,
        }));
        let outcome = encode_outcome(ResyncPageOutcome::FlushAck(FlushAck {
            session_id,
            request_index: 10,
            segment: None,
            state: FlushState::Complete,
        }));
        assert_eq!(
            index_ten.record_flush(&request, &outcome),
            Err(RepositoryError::Conflict)
        );
    }

    #[test]
    fn staged_kv_is_set_only_globally_sorted_unique_and_bounded() {
        let mut across_segments = transcript();
        empty_snapshot_step(
            &mut across_segments,
            PluginSnapshotKind::Task,
            0,
            Some(set_segment("b", &[1])),
        );
        for key in ["a", "b"] {
            assert_eq!(
                across_segments.validate_segment(Some(&set_segment(key, &[2]))),
                Err(RepositoryError::Conflict)
            );
        }

        let mut deletes = transcript();
        record_empty_snapshot_sequence(&mut deletes);
        let session_id = deletes.session().operation_id.to_string();
        let request = encode_request(ResyncPage::FlushStagedKv(FlushStagedKv {
            session_id: session_id.clone(),
            request_index: 0,
        }));
        let outcome = encode_outcome(ResyncPageOutcome::FlushAck(FlushAck {
            session_id,
            request_index: 0,
            segment: Some(KvSegment {
                operations: vec![KvOperation::Delete("old".to_owned())],
            }),
            state: FlushState::Complete,
        }));
        assert_eq!(
            deletes.record_flush(&request, &outcome),
            Err(RepositoryError::Conflict)
        );

        for keys in [["b", "a"], ["a", "a"]] {
            let mut invalid = transcript();
            record_empty_snapshot_sequence(&mut invalid);
            let session_id = invalid.session().operation_id.to_string();
            let request = encode_request(ResyncPage::FlushStagedKv(FlushStagedKv {
                session_id: session_id.clone(),
                request_index: 0,
            }));
            let outcome = encode_outcome(ResyncPageOutcome::FlushAck(FlushAck {
                session_id,
                request_index: 0,
                segment: Some(KvSegment {
                    operations: keys
                        .into_iter()
                        .map(|key| {
                            KvOperation::Set(KvSet {
                                key: key.to_owned(),
                                value: ByteList::new(vec![1]).unwrap(),
                            })
                        })
                        .collect(),
                }),
                state: FlushState::Complete,
            }));
            assert_eq!(
                invalid.record_flush(&request, &outcome),
                Err(RepositoryError::Conflict)
            );
        }

        let mut oversized = transcript();
        record_empty_snapshot_sequence(&mut oversized);
        let session_id = oversized.session().operation_id.to_string();
        let request = encode_request(ResyncPage::FlushStagedKv(FlushStagedKv {
            session_id: session_id.clone(),
            request_index: 0,
        }));
        let outcome = encode_outcome(ResyncPageOutcome::FlushAck(FlushAck {
            session_id,
            request_index: 0,
            segment: Some(set_segment(
                "large",
                &vec![0; PLUGIN_KV_VALUE_BYTES_MAX + 1],
            )),
            state: FlushState::Complete,
        }));
        assert_eq!(
            oversized.record_flush(&request, &outcome),
            Err(RepositoryError::Conflict)
        );
    }

    #[test]
    fn staged_kv_count_value_aggregate_and_key_boundaries_are_exact() {
        let attempt = |operations: Vec<KvOperation>| {
            let mut transcript = transcript();
            record_empty_snapshot_sequence(&mut transcript);
            let session_id = transcript.session().operation_id.to_string();
            let request = encode_request(ResyncPage::FlushStagedKv(FlushStagedKv {
                session_id: session_id.clone(),
                request_index: 0,
            }));
            let outcome = encode_outcome(ResyncPageOutcome::FlushAck(FlushAck {
                session_id,
                request_index: 0,
                segment: Some(KvSegment { operations }),
                state: FlushState::Complete,
            }));
            transcript
                .record_flush(&request, &outcome)
                .map(|()| transcript)
        };
        let set = |key: String, value: Vec<u8>| {
            KvOperation::Set(KvSet {
                key,
                value: ByteList::new(value).unwrap(),
            })
        };

        let maximum_keys: Vec<_> = (0..PLUGIN_KV_KEYS_MAX)
            .map(|index| set(format!("key-{index:03}"), Vec::new()))
            .collect();
        let maximum = attempt(maximum_keys).unwrap();
        assert_eq!(maximum.staged_kv.len(), PLUGIN_KV_KEYS_MAX);
        let too_many_keys: Vec<_> = (0..=PLUGIN_KV_KEYS_MAX)
            .map(|index| set(format!("key-{index:03}"), Vec::new()))
            .collect();
        assert_eq!(
            attempt(too_many_keys).unwrap_err(),
            RepositoryError::OperationTooLarge
        );

        let maximum_value = attempt(vec![set(
            "value".to_owned(),
            vec![0; PLUGIN_KV_VALUE_BYTES_MAX],
        )])
        .unwrap();
        assert_eq!(maximum_value.staged_kv_bytes, PLUGIN_KV_VALUE_BYTES_MAX);

        assert_eq!(PLUGIN_KV_BYTES_MAX % PLUGIN_KV_VALUE_BYTES_MAX, 0);
        let full_values = PLUGIN_KV_BYTES_MAX / PLUGIN_KV_VALUE_BYTES_MAX;
        assert_eq!(full_values, 32);
        let mut maximum_aggregate = transcript();
        for index in 0..full_values {
            let segment = KvSegment {
                operations: vec![set(
                    format!("aggregate-{index:03}"),
                    vec![0; PLUGIN_KV_VALUE_BYTES_MAX],
                )],
            };
            maximum_aggregate.validate_segment(Some(&segment)).unwrap();
            maximum_aggregate.append_segment(Some(segment));
        }
        assert_eq!(maximum_aggregate.staged_kv_bytes, PLUGIN_KV_BYTES_MAX);
        let over = KvSegment {
            operations: vec![set("aggregate-999".to_owned(), vec![0])],
        };
        assert_eq!(
            maximum_aggregate.validate_segment(Some(&over)),
            Err(RepositoryError::OperationTooLarge)
        );

        assert!(attempt(vec![set("x".repeat(128), Vec::new())]).is_ok());
        for key in [
            String::new(),
            "x".repeat(129),
            "control\nkey".to_owned(),
            "bidi\u{202e}key".to_owned(),
        ] {
            assert_eq!(
                attempt(vec![set(key, Vec::new())]).unwrap_err(),
                RepositoryError::Conflict
            );
        }
    }

    #[test]
    fn final_choice_controls_omission_replace_and_zero_replace() {
        let leave = complete(FinalKvChoice::LeaveKv, Some(set_segment("a", &[1])));
        assert_eq!(leave.transcript.choice(), FinalKvChoice::LeaveKv);
        assert!(leave.transcript.replacement().is_none());
        assert_eq!(leave.transcript.candidate_keys(), 1);
        assert_eq!(
            leave.transcript.candidate_sha256().as_str(),
            "4239073a744eaaf7a469fec353eb351d422d9362c250983f67a1a0b96b51b8d1"
        );

        let replace = complete(
            FinalKvChoice::ReplaceKvWithStagedSegments,
            Some(set_segment("a", &[1])),
        );
        assert_eq!(replace.transcript.replacement().unwrap().len(), 1);

        let zero = complete(FinalKvChoice::ReplaceKvWithStagedSegments, None);
        assert_eq!(zero.transcript.replacement(), Some(&[][..]));
        assert_eq!(zero.transcript.candidate_keys(), 0);
        assert_eq!(
            zero.transcript.candidate_sha256().as_str(),
            "08eb7544b483e4471c3f2d22545111fe27cfa4328927e0b7258cfcbd65d7569d"
        );
    }

    #[test]
    fn compact_counter_and_replacement_digest_tampering_is_detected() {
        let request = complete(
            FinalKvChoice::ReplaceKvWithStagedSegments,
            Some(set_segment("a", &[1])),
        );
        let mut counter = request.transcript.clone();
        counter.step_count += 1;
        assert_eq!(
            counter.validate(&request.delivery, &request.session),
            Err(RepositoryError::Conflict)
        );
        let mut item_count = request.transcript.clone();
        item_count.snapshot_items_by_kind[0] += 1;
        assert_eq!(
            item_count.validate(&request.delivery, &request.session),
            Err(RepositoryError::Conflict)
        );
        let mut page_digest = request.transcript.clone();
        page_digest.last_snapshot_page_sha256[1] = Some(Sha256Digest::of(b"tampered page"));
        assert_eq!(
            page_digest.validate(&request.delivery, &request.session),
            Err(RepositoryError::Conflict)
        );
        let mut digest = request.transcript.clone();
        digest.candidate_sha256 = Sha256Digest::of(b"tampered");
        assert_eq!(
            digest.validate(&request.delivery, &request.session),
            Err(RepositoryError::Conflict)
        );
        let mut replacement = request.transcript.clone();
        replacement.candidate[0].1.push(2);
        assert_eq!(
            replacement.validate(&request.delivery, &request.session),
            Err(RepositoryError::Conflict)
        );
    }
}
