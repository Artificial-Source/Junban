//! First-party time block and time slot persistence.

use jiff::{Timestamp, ToSpan, civil::Date, civil::Time};
use junban_app::{
    AffectedIds, CommittedMutation, EventType, ReplanPastBlocksAction, RepositoryError,
    ResourceRef, ResourceSnapshot, ResyncScope, TemporalContext, TimeBlockPatch, TimeSlotPatch,
    TimeblockingRangePage, TimeblockingRangeQuery,
};
use junban_domain::{
    CivilTimeRange, EntityName, HexColor, MAX_BULK_IDS, MAX_TIMEBLOCK_RANGE_ITEMS, OperationId,
    ProjectId, RecurrenceRule, TaskId, TimeBlock, TimeBlockDraft, TimeBlockId, TimeSlot,
    TimeSlotDraft, TimeSlotId, TimeZoneName, replan_window, validate_timeblock_date_range,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;

use crate::helpers::{constraint_conflict, validation};
use crate::rows::{ensure_project_exists, map_not_found, parse_sql, storage_error, task_exists};
use crate::tx::{MutationEffect, canonical_json, global_revision, mutate};

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Req<'a> {
    CreateTimeBlock {
        draft: &'a TimeBlockDraft,
    },
    PatchTimeBlock {
        block_id: String,
        patch: &'a TimeBlockPatch,
    },
    DeleteTimeBlock {
        block_id: String,
    },
    CreateTimeSlot {
        draft: &'a TimeSlotDraft,
    },
    PatchTimeSlot {
        slot_id: String,
        patch: &'a TimeSlotPatch,
    },
    DeleteTimeSlot {
        slot_id: String,
    },
    AppendSlotTask {
        slot_id: String,
        task_id: String,
    },
    RemoveSlotTask {
        slot_id: String,
        task_id: String,
    },
    ReorderSlotTasks {
        slot_id: String,
        ordered_ids: &'a [TaskId],
    },
    SetTimeBlockRange {
        block_id: String,
        range: &'a CivilTimeRange,
    },
    ReplanPastBlocks {
        action: ReplanPastBlocksAction,
        today: String,
    },
}

fn block_effect(event_type: &'static str, block: &TimeBlock) -> MutationEffect {
    MutationEffect {
        event_type: EventType::new(event_type),
        primary: Some(ResourceRef::time_block(block.id)),
        snapshot: Some(ResourceSnapshot::time_block(block.clone())),
        affected: AffectedIds {
            time_block_ids: vec![block.id],
            ..AffectedIds::default()
        },
        resync: ResyncScope::NONE,
        task_activity: Vec::new(),
        summary_subject: Some(("time_block".into(), block.id.to_string())),
        undo: None,
        mark_undone: None,
        uncomplete_outcome: None,
    }
}

fn slot_effect(event_type: &'static str, slot: &TimeSlot) -> MutationEffect {
    MutationEffect {
        event_type: EventType::new(event_type),
        primary: Some(ResourceRef::time_slot(slot.id)),
        snapshot: Some(ResourceSnapshot::time_slot(slot.clone())),
        affected: AffectedIds {
            time_slot_ids: vec![slot.id],
            ..AffectedIds::default()
        },
        resync: ResyncScope::NONE,
        task_activity: Vec::new(),
        summary_subject: Some(("time_slot".into(), slot.id.to_string())),
        undo: None,
        mark_undone: None,
        uncomplete_outcome: None,
    }
}

pub(crate) fn list_timeblocking_range(
    connection: &Connection,
    query: TimeblockingRangeQuery,
) -> Result<TimeblockingRangePage, RepositoryError> {
    validate_timeblock_date_range(query.from, query.to).map_err(validation)?;
    let revision = global_revision(connection)?;
    let tx = connection.unchecked_transaction().map_err(storage_error)?;

    let block_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM time_blocks
             WHERE civil_date >= ?1 AND civil_date <= ?2",
            params![query.from.to_string(), query.to.to_string()],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let slot_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM time_slots
             WHERE civil_date >= ?1 AND civil_date <= ?2",
            params![query.from.to_string(), query.to.to_string()],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    let total = usize::try_from(block_count.saturating_add(slot_count))
        .map_err(|error| RepositoryError::Storage(error.to_string()))?;
    if total > MAX_TIMEBLOCK_RANGE_ITEMS {
        return Err(RepositoryError::OperationTooLarge);
    }

    let mut blocks = Vec::with_capacity(usize::try_from(block_count).unwrap_or(0));
    {
        let mut statement = tx
            .prepare(
                "SELECT id FROM time_blocks
                 WHERE civil_date >= ?1 AND civil_date <= ?2
                 ORDER BY civil_date, start_time, id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map(
                params![query.from.to_string(), query.to.to_string()],
                |row| {
                    let raw: String = row.get(0)?;
                    parse_sql(raw, TimeBlockId::parse)
                },
            )
            .map_err(storage_error)?;
        for id in rows {
            blocks.push(load_time_block(&tx, id.map_err(storage_error)?)?);
        }
    }

    let mut slots = Vec::with_capacity(usize::try_from(slot_count).unwrap_or(0));
    {
        let mut statement = tx
            .prepare(
                "SELECT id FROM time_slots
                 WHERE civil_date >= ?1 AND civil_date <= ?2
                 ORDER BY civil_date, start_time, id",
            )
            .map_err(storage_error)?;
        let rows = statement
            .query_map(
                params![query.from.to_string(), query.to.to_string()],
                |row| {
                    let raw: String = row.get(0)?;
                    parse_sql(raw, TimeSlotId::parse)
                },
            )
            .map_err(storage_error)?;
        for id in rows {
            slots.push(load_time_slot(&tx, id.map_err(storage_error)?)?);
        }
    }

    Ok(TimeblockingRangePage {
        blocks,
        slots,
        revision,
    })
}

pub(crate) fn create_time_block(
    c: &mut Connection,
    op: OperationId,
    block_id: TimeBlockId,
    draft: TimeBlockDraft,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::CreateTimeBlock { draft: &draft })?;
    mutate(c, op, request, now, move |tx, revision| {
        ensure_civil_range(&draft.range)?;
        validate_block_refs(tx, draft.task_id, draft.slot_id)?;
        let block = TimeBlock::from_draft(block_id, draft, now, revision);
        insert_time_block(tx, &block)?;
        Ok(block_effect(EventType::TIME_BLOCK_CREATED, &block))
    })
}

pub(crate) fn patch_time_block(
    c: &mut Connection,
    op: OperationId,
    block_id: TimeBlockId,
    patch: TimeBlockPatch,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::PatchTimeBlock {
        block_id: block_id.to_string(),
        patch: &patch,
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let mut block = load_time_block(tx, block_id)?;
        apply_block_patch(&mut block, &patch)?;
        ensure_civil_range(&block.range)?;
        validate_block_refs(tx, block.task_id, block.slot_id)?;
        block.updated_at = now;
        block.revision = revision;
        update_time_block_row(tx, &block)?;
        Ok(block_effect(EventType::TIME_BLOCK_UPDATED, &block))
    })
}

pub(crate) fn delete_time_block(
    c: &mut Connection,
    op: OperationId,
    block_id: TimeBlockId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::DeleteTimeBlock {
        block_id: block_id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, _| {
        let _ = load_time_block(tx, block_id)?;
        tx.execute(
            "DELETE FROM time_blocks WHERE id = ?1",
            [block_id.to_string()],
        )
        .map_err(storage_error)?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TIME_BLOCK_DELETED),
            primary: Some(ResourceRef::time_block(block_id)),
            snapshot: None,
            affected: AffectedIds {
                time_block_ids: vec![block_id],
                ..AffectedIds::default()
            },
            resync: ResyncScope::NONE,
            task_activity: Vec::new(),
            summary_subject: Some(("time_block".into(), block_id.to_string())),
            undo: None,
            mark_undone: None,
            uncomplete_outcome: None,
        })
    })
}

pub(crate) fn create_time_slot(
    c: &mut Connection,
    op: OperationId,
    slot_id: TimeSlotId,
    draft: TimeSlotDraft,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::CreateTimeSlot { draft: &draft })?;
    mutate(c, op, request, now, move |tx, revision| {
        ensure_civil_range(&draft.range)?;
        if let Some(project_id) = draft.project_id {
            ensure_project_exists(tx, project_id)?;
        }
        let slot = TimeSlot::from_draft(slot_id, draft, now, revision);
        insert_time_slot(tx, &slot)?;
        Ok(slot_effect(EventType::TIME_SLOT_CREATED, &slot))
    })
}

pub(crate) fn patch_time_slot(
    c: &mut Connection,
    op: OperationId,
    slot_id: TimeSlotId,
    patch: TimeSlotPatch,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::PatchTimeSlot {
        slot_id: slot_id.to_string(),
        patch: &patch,
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let mut slot = load_time_slot(tx, slot_id)?;
        apply_slot_patch(&mut slot, &patch)?;
        ensure_civil_range(&slot.range)?;
        if let Some(project_id) = slot.project_id {
            ensure_project_exists(tx, project_id)?;
        }
        slot.updated_at = now;
        slot.revision = revision;
        update_time_slot_row(tx, &slot)?;
        Ok(slot_effect(EventType::TIME_SLOT_UPDATED, &slot))
    })
}

pub(crate) fn delete_time_slot(
    c: &mut Connection,
    op: OperationId,
    slot_id: TimeSlotId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::DeleteTimeSlot {
        slot_id: slot_id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let _ = load_time_slot(tx, slot_id)?;
        // Explicitly clear linked blocks so slot_id, updated_at, and revision
        // all land on this mutation (do not rely on FK ON DELETE SET NULL alone).
        let time_block_ids = load_block_ids_for_slot(tx, slot_id)?;
        let revision_i64 =
            i64::try_from(revision).map_err(|e| RepositoryError::Storage(e.to_string()))?;
        for block_id in &time_block_ids {
            tx.execute(
                "UPDATE time_blocks
                 SET slot_id = NULL, updated_at = ?1, revision = ?2
                 WHERE id = ?3",
                params![now.to_string(), revision_i64, block_id.to_string()],
            )
            .map_err(storage_error)?;
        }
        // Membership rows still cascade with the slot row.
        tx.execute(
            "DELETE FROM time_slots WHERE id = ?1",
            [slot_id.to_string()],
        )
        .map_err(storage_error)?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TIME_SLOT_DELETED),
            primary: Some(ResourceRef::time_slot(slot_id)),
            snapshot: None,
            affected: AffectedIds {
                time_slot_ids: vec![slot_id],
                time_block_ids,
                ..AffectedIds::default()
            },
            resync: ResyncScope::NONE,
            task_activity: Vec::new(),
            summary_subject: Some(("time_slot".into(), slot_id.to_string())),
            undo: None,
            mark_undone: None,
            uncomplete_outcome: None,
        })
    })
}

pub(crate) fn append_slot_task(
    c: &mut Connection,
    op: OperationId,
    slot_id: TimeSlotId,
    task_id: TaskId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::AppendSlotTask {
        slot_id: slot_id.to_string(),
        task_id: task_id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let mut slot = load_time_slot(tx, slot_id)?;
        if !task_exists(tx, task_id)? {
            return Err(RepositoryError::NotFound);
        }
        // Duplicate append is a deterministic no-op membership change.
        slot.task_ids.append(task_id).map_err(validation)?;
        slot.updated_at = now;
        slot.revision = revision;
        rewrite_slot_membership(tx, slot_id, slot.task_ids.as_slice())?;
        update_time_slot_meta(tx, &slot)?;
        Ok(slot_effect(EventType::TIME_SLOT_MEMBERSHIP_UPDATED, &slot))
    })
}

pub(crate) fn remove_slot_task(
    c: &mut Connection,
    op: OperationId,
    slot_id: TimeSlotId,
    task_id: TaskId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::RemoveSlotTask {
        slot_id: slot_id.to_string(),
        task_id: task_id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let mut slot = load_time_slot(tx, slot_id)?;
        let _ = slot.task_ids.remove(task_id);
        slot.updated_at = now;
        slot.revision = revision;
        rewrite_slot_membership(tx, slot_id, slot.task_ids.as_slice())?;
        update_time_slot_meta(tx, &slot)?;
        Ok(slot_effect(EventType::TIME_SLOT_MEMBERSHIP_UPDATED, &slot))
    })
}

pub(crate) fn reorder_slot_tasks(
    c: &mut Connection,
    op: OperationId,
    slot_id: TimeSlotId,
    ordered_ids: Vec<TaskId>,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::ReorderSlotTasks {
        slot_id: slot_id.to_string(),
        ordered_ids: &ordered_ids,
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let mut slot = load_time_slot(tx, slot_id)?;
        slot.task_ids.reorder(ordered_ids).map_err(validation)?;
        slot.updated_at = now;
        slot.revision = revision;
        rewrite_slot_membership(tx, slot_id, slot.task_ids.as_slice())?;
        update_time_slot_meta(tx, &slot)?;
        Ok(slot_effect(EventType::TIME_SLOT_MEMBERSHIP_UPDATED, &slot))
    })
}

pub(crate) fn set_time_block_range(
    c: &mut Connection,
    op: OperationId,
    block_id: TimeBlockId,
    range: CivilTimeRange,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::SetTimeBlockRange {
        block_id: block_id.to_string(),
        range: &range,
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        ensure_civil_range(&range)?;
        let mut block = load_time_block(tx, block_id)?;
        block.range = range;
        block.updated_at = now;
        block.revision = revision;
        update_time_block_row(tx, &block)?;
        Ok(block_effect(EventType::TIME_BLOCK_UPDATED, &block))
    })
}

pub(crate) fn replan_past_blocks(
    c: &mut Connection,
    op: OperationId,
    action: ReplanPastBlocksAction,
    now: Timestamp,
    temporal: TemporalContext,
) -> Result<CommittedMutation, RepositoryError> {
    let today = temporal.sampled_completion_date;
    let request = canonical_json(&Req::ReplanPastBlocks {
        action,
        today: today.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let (window_start, window_end) = replan_window(today).map_err(validation)?;
        let eligible_ids = load_replan_eligible_ids(tx, window_start, window_end)?;
        if eligible_ids.len() > MAX_BULK_IDS {
            return Err(RepositoryError::OperationTooLarge);
        }

        let mut affected = Vec::with_capacity(eligible_ids.len());
        match action {
            ReplanPastBlocksAction::Delete => {
                for block_id in &eligible_ids {
                    tx.execute(
                        "DELETE FROM time_blocks WHERE id = ?1",
                        [block_id.to_string()],
                    )
                    .map_err(storage_error)?;
                    affected.push(*block_id);
                }
            }
            ReplanPastBlocksAction::MoveToToday | ReplanPastBlocksAction::MoveToTomorrow => {
                let target = match action {
                    ReplanPastBlocksAction::MoveToToday => today,
                    ReplanPastBlocksAction::MoveToTomorrow => today
                        .checked_add(1.day())
                        .map_err(|error| RepositoryError::Storage(error.to_string()))?,
                    ReplanPastBlocksAction::Delete => unreachable!(),
                };
                for block_id in &eligible_ids {
                    let mut block = load_time_block(tx, *block_id)?;
                    block.range.date = target;
                    block.updated_at = now;
                    block.revision = revision;
                    update_time_block_row(tx, &block)?;
                    affected.push(*block_id);
                }
            }
        }

        Ok(MutationEffect {
            event_type: EventType::new(EventType::TIME_BLOCK_REPLANNED),
            primary: affected.first().copied().map(ResourceRef::time_block),
            snapshot: None,
            affected: AffectedIds {
                time_block_ids: affected,
                ..AffectedIds::default()
            },
            resync: ResyncScope::NONE,
            task_activity: Vec::new(),
            summary_subject: Some(("time_block".into(), "replan".into())),
            undo: None,
            mark_undone: None,
            uncomplete_outcome: None,
        })
    })
}

fn load_replan_eligible_ids(
    tx: &Transaction<'_>,
    window_start: Date,
    window_end: Date,
) -> Result<Vec<TimeBlockId>, RepositoryError> {
    let mut statement = tx
        .prepare(
            "SELECT id FROM time_blocks
             WHERE locked = 0
               AND civil_date >= ?1
               AND civil_date <= ?2
             ORDER BY civil_date, start_time, id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map(
            params![window_start.to_string(), window_end.to_string()],
            |row| {
                let raw: String = row.get(0)?;
                parse_sql(raw, TimeBlockId::parse)
            },
        )
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

fn ensure_civil_range(range: &CivilTimeRange) -> Result<(), RepositoryError> {
    range.validate().map_err(validation)
}

fn load_block_ids_for_slot(
    tx: &Transaction<'_>,
    slot_id: TimeSlotId,
) -> Result<Vec<TimeBlockId>, RepositoryError> {
    let mut statement = tx
        .prepare("SELECT id FROM time_blocks WHERE slot_id = ?1 ORDER BY id")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([slot_id.to_string()], |row| {
            let raw: String = row.get(0)?;
            parse_sql(raw, TimeBlockId::parse)
        })
        .map_err(storage_error)?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(storage_error)?);
        if ids.len() > MAX_BULK_IDS {
            return Err(RepositoryError::OperationTooLarge);
        }
    }
    Ok(ids)
}

fn validate_block_refs(
    tx: &Transaction<'_>,
    task_id: Option<TaskId>,
    slot_id: Option<TimeSlotId>,
) -> Result<(), RepositoryError> {
    if let Some(task_id) = task_id
        && !task_exists(tx, task_id)?
    {
        return Err(RepositoryError::NotFound);
    }
    if let Some(slot_id) = slot_id {
        ensure_slot_exists(tx, slot_id)?;
    }
    Ok(())
}

fn ensure_slot_exists(tx: &Transaction<'_>, slot_id: TimeSlotId) -> Result<(), RepositoryError> {
    let found: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM time_slots WHERE id = ?1",
            [slot_id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    if found.is_none() {
        return Err(RepositoryError::NotFound);
    }
    Ok(())
}

fn apply_block_patch(block: &mut TimeBlock, patch: &TimeBlockPatch) -> Result<(), RepositoryError> {
    if let Some(title) = &patch.title {
        block.title = title.clone();
    }
    if let Some(range) = &patch.range {
        block.range = range.clone();
    }
    if let Some(color) = &patch.color {
        block.color = color.clone();
    }
    if let Some(locked) = patch.locked {
        block.locked = locked;
    }
    if let Some(task_id) = &patch.task_id {
        block.task_id = *task_id;
    }
    if let Some(slot_id) = &patch.slot_id {
        block.slot_id = *slot_id;
    }
    if let Some(rule) = &patch.recurrence_rule {
        block.recurrence_rule = rule.clone();
    }
    Ok(())
}

fn apply_slot_patch(slot: &mut TimeSlot, patch: &TimeSlotPatch) -> Result<(), RepositoryError> {
    if let Some(title) = &patch.title {
        slot.title = title.clone();
    }
    if let Some(range) = &patch.range {
        slot.range = range.clone();
    }
    if let Some(color) = &patch.color {
        slot.color = color.clone();
    }
    if let Some(project_id) = &patch.project_id {
        slot.project_id = *project_id;
    }
    if let Some(rule) = &patch.recurrence_rule {
        slot.recurrence_rule = rule.clone();
    }
    Ok(())
}

fn insert_time_block(tx: &Transaction<'_>, block: &TimeBlock) -> Result<(), RepositoryError> {
    tx.execute(
        "INSERT INTO time_blocks(
            id, task_id, slot_id, title, civil_date, start_time, end_time, timezone,
            color, locked, recurrence_rule, recurrence_parent_id, created_at, updated_at, revision
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
        params![
            block.id.to_string(),
            block.task_id.map(|id| id.to_string()),
            block.slot_id.map(|id| id.to_string()),
            block.title.as_str(),
            block.range.date.to_string(),
            block.range.start.to_string(),
            block.range.end.to_string(),
            block.range.time_zone.as_str(),
            block.color.as_ref().map(HexColor::as_str),
            i64::from(block.locked),
            block.recurrence_rule.as_ref().map(RecurrenceRule::as_str),
            block.recurrence_parent_id.map(|id| id.to_string()),
            block.created_at.to_string(),
            block.updated_at.to_string(),
            i64::try_from(block.revision).map_err(|e| RepositoryError::Storage(e.to_string()))?,
        ],
    )
    .map_err(constraint_conflict)?;
    Ok(())
}

fn update_time_block_row(tx: &Transaction<'_>, block: &TimeBlock) -> Result<(), RepositoryError> {
    let changed = tx
        .execute(
            "UPDATE time_blocks SET
                task_id=?1, slot_id=?2, title=?3, civil_date=?4, start_time=?5, end_time=?6,
                timezone=?7, color=?8, locked=?9, recurrence_rule=?10, recurrence_parent_id=?11,
                updated_at=?12, revision=?13
             WHERE id=?14",
            params![
                block.task_id.map(|id| id.to_string()),
                block.slot_id.map(|id| id.to_string()),
                block.title.as_str(),
                block.range.date.to_string(),
                block.range.start.to_string(),
                block.range.end.to_string(),
                block.range.time_zone.as_str(),
                block.color.as_ref().map(HexColor::as_str),
                i64::from(block.locked),
                block.recurrence_rule.as_ref().map(RecurrenceRule::as_str),
                block.recurrence_parent_id.map(|id| id.to_string()),
                block.updated_at.to_string(),
                i64::try_from(block.revision)
                    .map_err(|e| RepositoryError::Storage(e.to_string()))?,
                block.id.to_string(),
            ],
        )
        .map_err(constraint_conflict)?;
    if changed == 0 {
        return Err(RepositoryError::NotFound);
    }
    Ok(())
}

fn insert_time_slot(tx: &Transaction<'_>, slot: &TimeSlot) -> Result<(), RepositoryError> {
    tx.execute(
        "INSERT INTO time_slots(
            id, title, project_id, civil_date, start_time, end_time, timezone, color,
            recurrence_rule, recurrence_parent_id, created_at, updated_at, revision
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            slot.id.to_string(),
            slot.title.as_str(),
            slot.project_id.map(|id| id.to_string()),
            slot.range.date.to_string(),
            slot.range.start.to_string(),
            slot.range.end.to_string(),
            slot.range.time_zone.as_str(),
            slot.color.as_ref().map(HexColor::as_str),
            slot.recurrence_rule.as_ref().map(RecurrenceRule::as_str),
            slot.recurrence_parent_id.map(|id| id.to_string()),
            slot.created_at.to_string(),
            slot.updated_at.to_string(),
            i64::try_from(slot.revision).map_err(|e| RepositoryError::Storage(e.to_string()))?,
        ],
    )
    .map_err(constraint_conflict)?;
    Ok(())
}

fn update_time_slot_row(tx: &Transaction<'_>, slot: &TimeSlot) -> Result<(), RepositoryError> {
    update_time_slot_meta(tx, slot)?;
    rewrite_slot_membership(tx, slot.id, slot.task_ids.as_slice())?;
    Ok(())
}

fn update_time_slot_meta(tx: &Transaction<'_>, slot: &TimeSlot) -> Result<(), RepositoryError> {
    let changed = tx
        .execute(
            "UPDATE time_slots SET
                title=?1, project_id=?2, civil_date=?3, start_time=?4, end_time=?5, timezone=?6,
                color=?7, recurrence_rule=?8, recurrence_parent_id=?9, updated_at=?10, revision=?11
             WHERE id=?12",
            params![
                slot.title.as_str(),
                slot.project_id.map(|id| id.to_string()),
                slot.range.date.to_string(),
                slot.range.start.to_string(),
                slot.range.end.to_string(),
                slot.range.time_zone.as_str(),
                slot.color.as_ref().map(HexColor::as_str),
                slot.recurrence_rule.as_ref().map(RecurrenceRule::as_str),
                slot.recurrence_parent_id.map(|id| id.to_string()),
                slot.updated_at.to_string(),
                i64::try_from(slot.revision)
                    .map_err(|e| RepositoryError::Storage(e.to_string()))?,
                slot.id.to_string(),
            ],
        )
        .map_err(constraint_conflict)?;
    if changed == 0 {
        return Err(RepositoryError::NotFound);
    }
    Ok(())
}

fn rewrite_slot_membership(
    tx: &Transaction<'_>,
    slot_id: TimeSlotId,
    task_ids: &[TaskId],
) -> Result<(), RepositoryError> {
    tx.execute(
        "DELETE FROM time_slot_tasks WHERE slot_id = ?1",
        [slot_id.to_string()],
    )
    .map_err(storage_error)?;
    for (position, task_id) in task_ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO time_slot_tasks(slot_id, task_id, position) VALUES (?1, ?2, ?3)",
            params![
                slot_id.to_string(),
                task_id.to_string(),
                i64::try_from(position).map_err(|e| RepositoryError::Storage(e.to_string()))?,
            ],
        )
        .map_err(constraint_conflict)?;
    }
    Ok(())
}

pub(crate) fn load_time_block(
    tx: &Transaction<'_>,
    id: TimeBlockId,
) -> Result<TimeBlock, RepositoryError> {
    tx.query_row(
        "SELECT id, task_id, slot_id, title, civil_date, start_time, end_time, timezone,
                color, locked, recurrence_rule, recurrence_parent_id, created_at, updated_at, revision
         FROM time_blocks WHERE id = ?1",
        [id.to_string()],
        time_block_from_row,
    )
    .map_err(map_not_found)
}

pub(crate) fn load_time_slot(
    tx: &Transaction<'_>,
    id: TimeSlotId,
) -> Result<TimeSlot, RepositoryError> {
    let mut slot = tx
        .query_row(
            "SELECT id, title, project_id, civil_date, start_time, end_time, timezone, color,
                    recurrence_rule, recurrence_parent_id, created_at, updated_at, revision
             FROM time_slots WHERE id = ?1",
            [id.to_string()],
            time_slot_from_row,
        )
        .map_err(map_not_found)?;
    slot.task_ids = load_slot_membership(tx, id)?;
    Ok(slot)
}

fn load_slot_membership(
    tx: &Transaction<'_>,
    slot_id: TimeSlotId,
) -> Result<junban_domain::OrderedSlotMembership, RepositoryError> {
    let mut statement = tx
        .prepare(
            "SELECT task_id FROM time_slot_tasks
             WHERE slot_id = ?1
             ORDER BY position, task_id",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([slot_id.to_string()], |row| {
            let raw: String = row.get(0)?;
            parse_sql(raw, TaskId::parse)
        })
        .map_err(storage_error)?;
    let ids = rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)?;
    junban_domain::OrderedSlotMembership::new(ids).map_err(validation)
}

fn time_block_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TimeBlock> {
    let id: String = row.get(0)?;
    let task_id: Option<String> = row.get(1)?;
    let slot_id: Option<String> = row.get(2)?;
    let title: String = row.get(3)?;
    let civil_date: String = row.get(4)?;
    let start_time: String = row.get(5)?;
    let end_time: String = row.get(6)?;
    let timezone: String = row.get(7)?;
    let color: Option<String> = row.get(8)?;
    let locked: i64 = row.get(9)?;
    let recurrence_rule: Option<String> = row.get(10)?;
    let recurrence_parent_id: Option<String> = row.get(11)?;
    let created_at: String = row.get(12)?;
    let updated_at: String = row.get(13)?;
    let revision: i64 = row.get(14)?;

    let range = CivilTimeRange::new(
        parse_sql(civil_date, |raw| raw.parse::<Date>())?,
        parse_sql(start_time, |raw| raw.parse::<Time>())?,
        parse_sql(end_time, |raw| raw.parse::<Time>())?,
        parse_sql(timezone, |raw| TimeZoneName::new(raw.to_owned()))?,
    )
    .map_err(crate::rows::invalid_sql)?;

    Ok(TimeBlock {
        id: parse_sql(id, TimeBlockId::parse)?,
        title: parse_sql(title, |raw| EntityName::new(raw.to_owned()))?,
        range,
        color: color
            .map(|value| parse_sql(value, |raw| HexColor::new(raw.to_owned())))
            .transpose()?,
        locked: locked != 0,
        task_id: task_id
            .map(|value| parse_sql(value, TaskId::parse))
            .transpose()?,
        slot_id: slot_id
            .map(|value| parse_sql(value, TimeSlotId::parse))
            .transpose()?,
        recurrence_rule: recurrence_rule
            .map(|value| parse_sql(value, |raw| RecurrenceRule::new(raw.to_owned())))
            .transpose()?,
        recurrence_parent_id: recurrence_parent_id
            .map(|value| parse_sql(value, TimeBlockId::parse))
            .transpose()?,
        created_at: parse_sql(created_at, |raw| raw.parse::<Timestamp>())?,
        updated_at: parse_sql(updated_at, |raw| raw.parse::<Timestamp>())?,
        revision: u64::try_from(revision).map_err(crate::rows::invalid_sql)?,
    })
}

fn time_slot_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TimeSlot> {
    let id: String = row.get(0)?;
    let title: String = row.get(1)?;
    let project_id: Option<String> = row.get(2)?;
    let civil_date: String = row.get(3)?;
    let start_time: String = row.get(4)?;
    let end_time: String = row.get(5)?;
    let timezone: String = row.get(6)?;
    let color: Option<String> = row.get(7)?;
    let recurrence_rule: Option<String> = row.get(8)?;
    let recurrence_parent_id: Option<String> = row.get(9)?;
    let created_at: String = row.get(10)?;
    let updated_at: String = row.get(11)?;
    let revision: i64 = row.get(12)?;

    let range = CivilTimeRange::new(
        parse_sql(civil_date, |raw| raw.parse::<Date>())?,
        parse_sql(start_time, |raw| raw.parse::<Time>())?,
        parse_sql(end_time, |raw| raw.parse::<Time>())?,
        parse_sql(timezone, |raw| TimeZoneName::new(raw.to_owned()))?,
    )
    .map_err(crate::rows::invalid_sql)?;

    Ok(TimeSlot {
        id: parse_sql(id, TimeSlotId::parse)?,
        title: parse_sql(title, |raw| EntityName::new(raw.to_owned()))?,
        range,
        color: color
            .map(|value| parse_sql(value, |raw| HexColor::new(raw.to_owned())))
            .transpose()?,
        project_id: project_id
            .map(|value| parse_sql(value, ProjectId::parse))
            .transpose()?,
        recurrence_rule: recurrence_rule
            .map(|value| parse_sql(value, |raw| RecurrenceRule::new(raw.to_owned())))
            .transpose()?,
        recurrence_parent_id: recurrence_parent_id
            .map(|value| parse_sql(value, TimeSlotId::parse))
            .transpose()?,
        task_ids: junban_domain::OrderedSlotMembership::empty(),
        created_at: parse_sql(created_at, |raw| raw.parse::<Timestamp>())?,
        updated_at: parse_sql(updated_at, |raw| raw.parse::<Timestamp>())?,
        revision: u64::try_from(revision).map_err(crate::rows::invalid_sql)?,
    })
}
