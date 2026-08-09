//! Pure conversion and resync classification for retained plugin events.
//!
//! This leaf consumes only the committed envelope. It never reads live state or
//! synthesizes subjects from affected IDs.

use std::{collections::HashSet, hash::Hash};

use junban_domain::{
    ActualMinutes, AiApprovalId, AiMemoryId, AiSessionId, CommentId, DreadLevel, EntityName,
    EstimatedMinutes, HexColor, IconText, MAX_BULK_IDS, MarkdownText, MonthlyAnchorDay,
    OperationId, Priority as DomainPriority, Project, ProjectId, ProjectView, RecurrenceRule,
    SavedFilterId, Section, SectionId, Tag, TagId, TagName, Task, TaskId, TaskStatus, TaskTitle,
    TemplateId, TimeBlockId, TimeSlotId, recurrence_rule_uses_anchor, resolve_recurrence_anchor,
    validate_parent_chain, validate_project_parent_chain, validate_task_tags,
};
use junban_plugin_sdk::{
    EventKind as SubscriptionEventKind, InvocationKind, InvocationRequest, PluginId,
    decode_invocation_request,
    private_body_types::{
        EventEnvelope, EventKind as WitEventKind, EventSubject, LocalDueTime, Priority,
        ProjectView as WitProjectView, ProjectViewRecord, SectionView, TagView,
        TaskStatus as WitTaskStatus, TaskView,
    },
};
use thiserror::Error;

use crate::{
    CommittedEvent, EventType, PLUGIN_GRAPH_FENCE_ENTRIES_MAX, PLUGINS_INSTALLED_MAX,
    ResourceSnapshot, ResourceType, ResyncScope,
};

/// Canonical private `handle-event` body and the exact manifest entry it binds.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginHandleEventBody {
    pub entry_id: PluginId,
    pub body: Vec<u8>,
}

/// Ordinary active-mode treatment of one retained event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginActiveEvent {
    HandleEvent(PluginHandleEventBody),
    Irrelevant,
}

/// Conservative treatment used by resync-tail verification and starting catch-up.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginResyncEvent {
    Represented(PluginHandleEventBody),
    Irrelevant,
    Invalidating,
}

/// A retained envelope cannot safely participate in plugin delivery.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum PluginEventError {
    #[error("malformed retained plugin event")]
    Malformed,
    #[error("plugin event body is not canonical")]
    NoncanonicalBody,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DirectResource {
    Task,
    Project,
    Tag,
    Section,
}

#[derive(Clone, Copy)]
struct DirectDescriptor {
    subscription_kind: SubscriptionEventKind,
    wit_kind: WitEventKind,
    resource: DirectResource,
    delete: bool,
}

struct RepresentableDirect {
    descriptor: DirectDescriptor,
    primary_id: String,
    subject: EventSubject,
}

enum DirectEvent {
    Representable(Box<RepresentableDirect>),
    Nonrepresentable,
    Other,
}

/// Convert a subscribed directly representable event for ordinary active delivery.
///
/// Valid unsubscribed events, current bookkeeping events, and valid direct
/// cascades that cannot be represented by one WIT subject are cursor-only work.
pub fn convert_active_plugin_event(
    event_epoch: &str,
    event: &CommittedEvent,
    subscriptions: &[SubscriptionEventKind],
) -> Result<PluginActiveEvent, PluginEventError> {
    validate_envelope(event_epoch, event)?;
    match analyze_direct_event(event)? {
        DirectEvent::Representable(direct)
            if subscriptions.contains(&direct.descriptor.subscription_kind) =>
        {
            Ok(PluginActiveEvent::HandleEvent(encode_direct(
                event_epoch,
                event.revision,
                *direct,
            )?))
        }
        DirectEvent::Representable(_) | DirectEvent::Nonrepresentable | DirectEvent::Other => {
            Ok(PluginActiveEvent::Irrelevant)
        }
    }
}

/// Classify one retained event for resync-tail verification or starting catch-up.
///
/// Only an exact subscribed subject that covers every affected baseline object
/// is represented. A subscribed section-only subject is represented even though
/// sections are not themselves part of the resync baseline.
pub fn classify_plugin_resync_event(
    event_epoch: &str,
    event: &CommittedEvent,
    subscriptions: &[SubscriptionEventKind],
) -> Result<PluginResyncEvent, PluginEventError> {
    validate_envelope(event_epoch, event)?;
    let direct = analyze_direct_event(event)?;

    if always_invalidates_resync(event.event_type.as_str()) {
        return Ok(PluginResyncEvent::Invalidating);
    }

    match direct {
        DirectEvent::Representable(direct) => {
            if subscriptions.contains(&direct.descriptor.subscription_kind)
                && completely_represents_baseline(event, &direct)
            {
                return Ok(PluginResyncEvent::Represented(encode_direct(
                    event_epoch,
                    event.revision,
                    *direct,
                )?));
            }
            Ok(if has_baseline_affected_ids(event) {
                PluginResyncEvent::Invalidating
            } else {
                PluginResyncEvent::Irrelevant
            })
        }
        DirectEvent::Nonrepresentable => Ok(PluginResyncEvent::Invalidating),
        DirectEvent::Other => Ok(if has_baseline_affected_ids(event) {
            PluginResyncEvent::Invalidating
        } else {
            PluginResyncEvent::Irrelevant
        }),
    }
}

fn validate_envelope(event_epoch: &str, event: &CommittedEvent) -> Result<(), PluginEventError> {
    let canonical_epoch = TaskId::parse(event_epoch).map_err(|_| PluginEventError::Malformed)?;
    if canonical_epoch.to_string() != event_epoch
        || event.revision == 0
        || !valid_event_type(event.event_type.as_str())
        || !affected_ids_are_valid(event)
        || event
            .primary
            .as_ref()
            .is_some_and(|primary| !valid_primary_resource_ref(primary.resource_type, &primary.id))
    {
        return Err(PluginEventError::Malformed);
    }
    Ok(())
}

fn valid_event_type(value: &str) -> bool {
    value.len() <= 64
        && value.split('.').count() >= 2
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        })
}

fn affected_ids_are_valid(event: &CommittedEvent) -> bool {
    let plugin_ids_valid = if event.event_type.as_str() == EventType::PLUGIN_HEALTH_CHANGED {
        !event.affected.plugin_ids.is_empty()
            && event.affected.plugin_ids.len() <= PLUGIN_GRAPH_FENCE_ENTRIES_MAX
            && event
                .affected
                .plugin_ids
                .iter()
                .all(|id| PluginId::parse(id.as_str()).as_ref() == Ok(id))
            && event
                .affected
                .plugin_ids
                .windows(2)
                .all(|pair| pair[0] < pair[1])
    } else {
        unique_bounded(&event.affected.plugin_ids, PLUGINS_INSTALLED_MAX)
    };

    unique_bounded(&event.affected.task_ids, MAX_BULK_IDS)
        && unique_bounded(&event.affected.project_ids, MAX_BULK_IDS)
        && unique_bounded(&event.affected.section_ids, MAX_BULK_IDS)
        && unique_bounded(&event.affected.tag_ids, MAX_BULK_IDS)
        && unique_bounded(&event.affected.template_ids, MAX_BULK_IDS)
        && unique_bounded(&event.affected.saved_filter_ids, MAX_BULK_IDS)
        && unique_bounded(&event.affected.comment_ids, MAX_BULK_IDS)
        && unique_bounded(&event.affected.time_block_ids, MAX_BULK_IDS)
        && unique_bounded(&event.affected.time_slot_ids, MAX_BULK_IDS)
        && plugin_ids_valid
}

fn unique_bounded<T: Eq + Hash>(values: &[T], maximum: usize) -> bool {
    if values.len() > maximum {
        return false;
    }
    let mut seen = HashSet::with_capacity(values.len());
    values.iter().all(|value| seen.insert(value))
}

fn valid_primary_resource_ref(resource_type: ResourceType, id: &str) -> bool {
    match resource_type {
        ResourceType::Task => parses_canonical_id(id, TaskId::parse),
        ResourceType::Project => parses_canonical_id(id, ProjectId::parse),
        ResourceType::Section => parses_canonical_id(id, SectionId::parse),
        ResourceType::Tag => parses_canonical_id(id, TagId::parse),
        ResourceType::Template => parses_canonical_id(id, TemplateId::parse),
        ResourceType::SavedFilter => parses_canonical_id(id, SavedFilterId::parse),
        ResourceType::Comment => parses_canonical_id(id, CommentId::parse),
        ResourceType::Operation => parses_canonical_id(id, OperationId::parse),
        ResourceType::TimeBlock => parses_canonical_id(id, TimeBlockId::parse),
        ResourceType::TimeSlot => parses_canonical_id(id, TimeSlotId::parse),
        ResourceType::Settings => id == "settings",
        ResourceType::AiSession => parses_canonical_id(id, AiSessionId::parse),
        ResourceType::AiMemory => parses_canonical_id(id, AiMemoryId::parse),
        ResourceType::AiApproval => parses_canonical_id(id, AiApprovalId::parse),
        ResourceType::Plugin => parses_canonical_id(id, |value| PluginId::parse(value)),
        // Relation events canonically identify their source task. There is no
        // standalone relation identity or typed relation-ID parser.
        ResourceType::Relation => false,
    }
}

fn parses_canonical_id<T: ToString, E>(
    value: &str,
    parse: impl FnOnce(&str) -> Result<T, E>,
) -> bool {
    parse(value).is_ok_and(|parsed| parsed.to_string() == value)
}

fn analyze_direct_event(event: &CommittedEvent) -> Result<DirectEvent, PluginEventError> {
    let Some(descriptor) = direct_descriptor(event.event_type.as_str()) else {
        return Ok(DirectEvent::Other);
    };
    let primary = event.primary.as_ref().ok_or(PluginEventError::Malformed)?;
    let expected_resource = match descriptor.resource {
        DirectResource::Task => ResourceType::Task,
        DirectResource::Project => ResourceType::Project,
        DirectResource::Tag => ResourceType::Tag,
        DirectResource::Section => ResourceType::Section,
    };
    if primary.resource_type != expected_resource {
        return Err(PluginEventError::Malformed);
    }

    let (contains_primary, represents_all_same_type) = match descriptor.resource {
        DirectResource::Task => affected_identity(&event.affected.task_ids, &primary.id),
        DirectResource::Project => affected_identity(&event.affected.project_ids, &primary.id),
        DirectResource::Tag => affected_identity(&event.affected.tag_ids, &primary.id),
        DirectResource::Section => affected_identity(&event.affected.section_ids, &primary.id),
    };
    if !contains_primary {
        return Err(PluginEventError::Malformed);
    }

    if descriptor.delete {
        if event.snapshot.is_some() {
            return Err(PluginEventError::Malformed);
        }
        if !represents_all_same_type {
            return Ok(DirectEvent::Nonrepresentable);
        }
        return Ok(DirectEvent::Representable(Box::new(RepresentableDirect {
            descriptor,
            primary_id: primary.id.clone(),
            subject: deleted_subject(descriptor.resource, primary.id.clone()),
        })));
    }

    let Some(snapshot) = event.snapshot.as_ref() else {
        // Exact multi-task completion/uncompletion cascades intentionally omit
        // a misleading single snapshot. No other non-delete direct shape may.
        return if canonical_snapshotless_task_cascade(event, descriptor, represents_all_same_type) {
            Ok(DirectEvent::Nonrepresentable)
        } else {
            Err(PluginEventError::Malformed)
        };
    };
    let subject = snapshot_subject(snapshot, descriptor.resource, &primary.id, event.revision)?;
    if !represents_all_same_type {
        return Ok(DirectEvent::Nonrepresentable);
    }
    Ok(DirectEvent::Representable(Box::new(RepresentableDirect {
        descriptor,
        primary_id: primary.id.clone(),
        subject,
    })))
}

fn canonical_snapshotless_task_cascade(
    event: &CommittedEvent,
    descriptor: DirectDescriptor,
    represents_all_same_type: bool,
) -> bool {
    descriptor.resource == DirectResource::Task
        && matches!(
            event.event_type.as_str(),
            EventType::TASK_COMPLETED | EventType::TASK_UNCOMPLETED
        )
        && !represents_all_same_type
        && event.affected.task_ids.len() > 1
        && event.affected.project_ids.is_empty()
        && event.affected.section_ids.is_empty()
        && event.affected.tag_ids.is_empty()
        && event.affected.template_ids.is_empty()
        && event.affected.saved_filter_ids.is_empty()
        && event.affected.comment_ids.is_empty()
        && event.affected.time_block_ids.is_empty()
        && event.affected.time_slot_ids.is_empty()
        && event.affected.plugin_ids.is_empty()
        && event.resync == ResyncScope::TASKS
}

fn affected_identity<T: ToString>(ids: &[T], primary_id: &str) -> (bool, bool) {
    let contains = ids.iter().any(|id| id.to_string() == primary_id);
    (contains, contains && ids.len() == 1)
}

fn deleted_subject(resource: DirectResource, id: String) -> EventSubject {
    match resource {
        DirectResource::Task => EventSubject::DeletedTask(id),
        DirectResource::Project => EventSubject::DeletedProject(id),
        DirectResource::Tag => EventSubject::DeletedTag(id),
        DirectResource::Section => EventSubject::DeletedSection(id),
    }
}

fn snapshot_subject(
    snapshot: &ResourceSnapshot,
    resource: DirectResource,
    primary_id: &str,
    event_revision: u64,
) -> Result<EventSubject, PluginEventError> {
    match (resource, snapshot) {
        (DirectResource::Task, ResourceSnapshot::Task { task })
            if task.id.to_string() == primary_id =>
        {
            Ok(EventSubject::Task(task_view(task, event_revision)?))
        }
        (DirectResource::Project, ResourceSnapshot::Project { project })
            if project.id.to_string() == primary_id =>
        {
            Ok(EventSubject::Project(project_view(
                project,
                event_revision,
            )?))
        }
        (DirectResource::Tag, ResourceSnapshot::Tag { tag })
            if tag.id.to_string() == primary_id =>
        {
            Ok(EventSubject::Tag(tag_view(tag, event_revision)?))
        }
        (DirectResource::Section, ResourceSnapshot::Section { section })
            if section.id.to_string() == primary_id =>
        {
            Ok(EventSubject::Section(section_view(
                section,
                event_revision,
            )?))
        }
        _ => Err(PluginEventError::Malformed),
    }
}

pub(crate) fn task_view(task: &Task, event_revision: u64) -> Result<TaskView, PluginEventError> {
    validate_task_snapshot(task, event_revision)?;
    let priority = task.priority.map(priority).transpose()?;
    Ok(TaskView {
        id: task.id.to_string(),
        title: task.title.as_str().to_owned(),
        description: task.description.as_str().to_owned(),
        status: task_status(task.status),
        priority,
        due_date: task.due_date.map(|value| value.to_string()),
        due_time: task.due_time.as_ref().map(|value| LocalDueTime {
            time: value.time.to_string(),
            time_zone: value.time_zone.as_str().to_owned(),
        }),
        deadline: task.deadline.map(|value| value.to_string()),
        someday: task.someday,
        estimated_minutes: task.estimated_minutes.map(|value| value.get()),
        actual_minutes: task.actual_minutes.map(|value| value.get()),
        dread: task.dread.map(|value| value.get()),
        project_id: task.project_id.map(|value| value.to_string()),
        section_id: task.section_id.map(|value| value.to_string()),
        parent_id: task.parent_id.map(|value| value.to_string()),
        tag_ids: task.tag_ids.iter().map(ToString::to_string).collect(),
        sort_order: task.sort_order.get(),
        recurrence_rule: task
            .recurrence_rule
            .as_ref()
            .map(|value| value.as_str().to_owned()),
        remind_at: task.remind_at.map(|value| value.to_string()),
        recurrence_anchor_day: task.recurrence_anchor_day.map(|value| value.get()),
        created_at: task.created_at.to_string(),
        updated_at: task.updated_at.to_string(),
        revision: task.revision,
    })
}

fn validate_task_snapshot(task: &Task, event_revision: u64) -> Result<(), PluginEventError> {
    let title_valid = TaskTitle::new(task.title.as_str()).is_ok_and(|value| value == task.title);
    let description_valid =
        MarkdownText::new(task.description.as_str()).is_ok_and(|value| value == task.description);
    let priority_valid = task
        .priority
        .is_none_or(|value| DomainPriority::new(value.get()).is_ok_and(|parsed| parsed == value));
    let dread_valid = task
        .dread
        .is_none_or(|value| DreadLevel::new(value.get()).is_ok_and(|parsed| parsed == value));
    let estimated_valid = task
        .estimated_minutes
        .is_none_or(|value| EstimatedMinutes::new(value.get()).is_ok_and(|parsed| parsed == value));
    let actual_valid = task
        .actual_minutes
        .is_none_or(|value| ActualMinutes::new(value.get()).is_ok_and(|parsed| parsed == value));
    let rule_valid = task.recurrence_rule.as_ref().is_none_or(|rule| {
        RecurrenceRule::new(rule.as_str()).is_ok_and(|parsed| parsed.as_str() == rule.as_str())
    });
    let anchor_valid = task.recurrence_anchor_day.is_none_or(|anchor| {
        MonthlyAnchorDay::new(anchor.get()).is_ok_and(|parsed| parsed == anchor)
    });
    let due_date_valid = task.due_date.is_none_or(|date| {
        date.to_string()
            .parse::<jiff::civil::Date>()
            .is_ok_and(|parsed| parsed == date)
    });
    let due_time_valid = task.due_time.as_ref().is_none_or(|due_time| {
        junban_domain::LocalDueTime::parse(&due_time.time.to_string(), due_time.time_zone.as_str())
            .is_ok_and(|parsed| parsed == *due_time)
    });
    let timestamps_valid = [
        Some(task.created_at),
        Some(task.updated_at),
        task.deadline,
        task.remind_at,
        task.completed_at,
        task.cancelled_at,
    ]
    .into_iter()
    .flatten()
    .all(timestamp_round_trips);
    let status_valid = match task.status {
        TaskStatus::Pending => task.completed_at.is_none() && task.cancelled_at.is_none(),
        TaskStatus::Completed => task.completed_at.is_some() && task.cancelled_at.is_none(),
        TaskStatus::Cancelled => task.completed_at.is_none() && task.cancelled_at.is_some(),
    };
    let status_time_valid = task
        .completed_at
        .or(task.cancelled_at)
        .is_none_or(|terminal| terminal >= task.created_at && terminal <= task.updated_at);
    let completion_identity_valid =
        task.completion_operation_id.is_none() || task.status == TaskStatus::Completed;
    let recurrence_consistent = task.recurrence_anchor_day
        == resolve_recurrence_anchor(
            task.recurrence_rule.as_ref(),
            task.due_date,
            task.recurrence_anchor_day,
        )
        && task.recurrence_anchor_day.is_none_or(|_| {
            task.recurrence_rule
                .as_ref()
                .is_some_and(recurrence_rule_uses_anchor)
        });
    let relationships_valid = task.section_id.is_none() || task.project_id.is_some();

    if !title_valid
        || !description_valid
        || validate_task_tags(&task.tag_ids).is_err()
        || !priority_valid
        || !dread_valid
        || !estimated_valid
        || !actual_valid
        || !rule_valid
        || !anchor_valid
        || !due_date_valid
        || !due_time_valid
        || !timestamps_valid
        || !status_valid
        || !status_time_valid
        || !completion_identity_valid
        || !recurrence_consistent
        || !relationships_valid
        || task.due_time.is_some() && task.due_date.is_none()
        || validate_parent_chain(task.id, task.parent_id, &[]).is_err()
        || task.recurrence_source_id == Some(task.id)
        || task.created_at > task.updated_at
        || task.revision == 0
        || task.revision > event_revision
    {
        return Err(PluginEventError::Malformed);
    }
    Ok(())
}

fn validate_project_snapshot(
    project: &Project,
    event_revision: u64,
) -> Result<(), PluginEventError> {
    let name_valid =
        EntityName::new(project.name.as_str()).is_ok_and(|value| value == project.name);
    let color_valid =
        HexColor::new(project.color.as_str()).is_ok_and(|value| value == project.color);
    let icon_valid = project
        .icon
        .as_ref()
        .is_none_or(|icon| IconText::new(icon.as_str()).is_ok_and(|value| value == *icon));
    if event_revision == 0
        || !name_valid
        || !color_valid
        || !icon_valid
        || validate_project_parent_chain(project.id, project.parent_id, &[]).is_err()
        || !timestamps_are_valid(project.created_at, project.updated_at)
    {
        return Err(PluginEventError::Malformed);
    }
    Ok(())
}

fn validate_section_snapshot(
    section: &Section,
    event_revision: u64,
) -> Result<(), PluginEventError> {
    let name_valid =
        EntityName::new(section.name.as_str()).is_ok_and(|value| value == section.name);
    if event_revision == 0
        || !name_valid
        || !parses_canonical_id(&section.project_id.to_string(), ProjectId::parse)
        || !timestamps_are_valid(section.created_at, section.updated_at)
    {
        return Err(PluginEventError::Malformed);
    }
    Ok(())
}

fn validate_tag_snapshot(tag: &Tag, event_revision: u64) -> Result<(), PluginEventError> {
    let name_valid =
        TagName::new(tag.name.as_str()).is_ok_and(|value| value.as_str() == tag.name.as_str());
    let color_valid = HexColor::new(tag.color.as_str()).is_ok_and(|value| value == tag.color);
    if event_revision == 0
        || !name_valid
        || !color_valid
        || !timestamps_are_valid(tag.created_at, tag.updated_at)
    {
        return Err(PluginEventError::Malformed);
    }
    Ok(())
}

fn timestamps_are_valid(created_at: jiff::Timestamp, updated_at: jiff::Timestamp) -> bool {
    created_at <= updated_at
        && timestamp_round_trips(created_at)
        && timestamp_round_trips(updated_at)
}

fn timestamp_round_trips(value: jiff::Timestamp) -> bool {
    value
        .to_string()
        .parse::<jiff::Timestamp>()
        .is_ok_and(|parsed| parsed == value)
}

fn priority(value: junban_domain::Priority) -> Result<Priority, PluginEventError> {
    match value.get() {
        1 => Ok(Priority::P1),
        2 => Ok(Priority::P2),
        3 => Ok(Priority::P3),
        4 => Ok(Priority::P4),
        _ => Err(PluginEventError::Malformed),
    }
}

const fn task_status(value: TaskStatus) -> WitTaskStatus {
    match value {
        TaskStatus::Pending => WitTaskStatus::Pending,
        TaskStatus::Completed => WitTaskStatus::Completed,
        TaskStatus::Cancelled => WitTaskStatus::Cancelled,
    }
}

pub(crate) fn project_view(
    project: &Project,
    event_revision: u64,
) -> Result<ProjectViewRecord, PluginEventError> {
    validate_project_snapshot(project, event_revision)?;
    Ok(ProjectViewRecord {
        id: project.id.to_string(),
        name: project.name.as_str().to_owned(),
        color: project.color.as_str().to_owned(),
        icon: project.icon.as_ref().map(|value| value.as_str().to_owned()),
        parent_id: project.parent_id.map(|value| value.to_string()),
        favorite: project.favorite,
        archived: project.archived,
        view: match project.view {
            ProjectView::List => WitProjectView::List,
            ProjectView::Board => WitProjectView::Board,
            ProjectView::Calendar => WitProjectView::Calendar,
        },
        sort_order: project.sort_order.get(),
        created_at: project.created_at.to_string(),
        updated_at: project.updated_at.to_string(),
        revision: event_revision,
    })
}

pub(crate) fn tag_view(tag: &Tag, event_revision: u64) -> Result<TagView, PluginEventError> {
    validate_tag_snapshot(tag, event_revision)?;
    Ok(TagView {
        id: tag.id.to_string(),
        name: tag.name.as_str().to_owned(),
        color: tag.color.as_str().to_owned(),
        created_at: tag.created_at.to_string(),
        updated_at: tag.updated_at.to_string(),
        revision: event_revision,
    })
}

fn section_view(section: &Section, event_revision: u64) -> Result<SectionView, PluginEventError> {
    validate_section_snapshot(section, event_revision)?;
    Ok(SectionView {
        id: section.id.to_string(),
        project_id: section.project_id.to_string(),
        name: section.name.as_str().to_owned(),
        collapsed: section.collapsed,
        sort_order: section.sort_order.get(),
        created_at: section.created_at.to_string(),
        updated_at: section.updated_at.to_string(),
        revision: event_revision,
    })
}

fn encode_direct(
    event_epoch: &str,
    revision: u64,
    direct: RepresentableDirect,
) -> Result<PluginHandleEventBody, PluginEventError> {
    let entry_id = PluginId::parse(direct.descriptor.subscription_kind.as_str())
        .map_err(|_| PluginEventError::NoncanonicalBody)?;
    let request = InvocationRequest::handle_event(
        Some(entry_id.as_str().to_owned()),
        EventEnvelope {
            event_epoch: event_epoch.to_owned(),
            revision,
            kind: direct.descriptor.wit_kind,
            subject: direct.subject,
        },
    );
    let body = serde_json::to_vec(&request).map_err(|_| PluginEventError::NoncanonicalBody)?;
    let decoded = decode_invocation_request(InvocationKind::HandleEvent, &body)
        .map_err(|_| PluginEventError::NoncanonicalBody)?;
    if decoded != request || decoded.entry_id() != Some(entry_id.as_str()) {
        return Err(PluginEventError::NoncanonicalBody);
    }
    Ok(PluginHandleEventBody { entry_id, body })
}

fn has_baseline_affected_ids(event: &CommittedEvent) -> bool {
    !event.affected.task_ids.is_empty()
        || !event.affected.project_ids.is_empty()
        || !event.affected.tag_ids.is_empty()
}

fn completely_represents_baseline(event: &CommittedEvent, direct: &RepresentableDirect) -> bool {
    match direct.descriptor.resource {
        DirectResource::Task => {
            event.affected.task_ids.len() == 1
                && event.affected.task_ids[0].to_string() == direct.primary_id
                && event.affected.project_ids.is_empty()
                && event.affected.tag_ids.is_empty()
        }
        DirectResource::Project => {
            event.affected.project_ids.len() == 1
                && event.affected.project_ids[0].to_string() == direct.primary_id
                && event.affected.task_ids.is_empty()
                && event.affected.tag_ids.is_empty()
        }
        DirectResource::Tag => {
            event.affected.tag_ids.len() == 1
                && event.affected.tag_ids[0].to_string() == direct.primary_id
                && event.affected.task_ids.is_empty()
                && event.affected.project_ids.is_empty()
        }
        DirectResource::Section => !has_baseline_affected_ids(event),
    }
}

fn always_invalidates_resync(event_type: &str) -> bool {
    matches!(
        event_type,
        EventType::TASK_MOVED
            | EventType::TASK_REORDERED
            | EventType::TASK_BULK
            | EventType::TASK_RESTORED
            | EventType::OPERATION_UNDONE
            | EventType::IMPORT_APPLIED
    )
}

fn direct_descriptor(event_type: &str) -> Option<DirectDescriptor> {
    let descriptor = match event_type {
        EventType::TASK_CREATED => (
            SubscriptionEventKind::TaskCreated,
            WitEventKind::TaskCreated,
            DirectResource::Task,
            false,
        ),
        EventType::TASK_UPDATED => (
            SubscriptionEventKind::TaskUpdated,
            WitEventKind::TaskUpdated,
            DirectResource::Task,
            false,
        ),
        EventType::TASK_COMPLETED => (
            SubscriptionEventKind::TaskCompleted,
            WitEventKind::TaskCompleted,
            DirectResource::Task,
            false,
        ),
        EventType::TASK_UNCOMPLETED => (
            SubscriptionEventKind::TaskUncompleted,
            WitEventKind::TaskUncompleted,
            DirectResource::Task,
            false,
        ),
        EventType::TASK_CANCELLED => (
            SubscriptionEventKind::TaskCancelled,
            WitEventKind::TaskCancelled,
            DirectResource::Task,
            false,
        ),
        EventType::TASK_REOPENED => (
            SubscriptionEventKind::TaskReopened,
            WitEventKind::TaskReopened,
            DirectResource::Task,
            false,
        ),
        EventType::TASK_DELETED => (
            SubscriptionEventKind::TaskDeleted,
            WitEventKind::TaskDeleted,
            DirectResource::Task,
            true,
        ),
        EventType::PROJECT_CREATED => (
            SubscriptionEventKind::ProjectCreated,
            WitEventKind::ProjectCreated,
            DirectResource::Project,
            false,
        ),
        EventType::PROJECT_UPDATED => (
            SubscriptionEventKind::ProjectUpdated,
            WitEventKind::ProjectUpdated,
            DirectResource::Project,
            false,
        ),
        EventType::PROJECT_DELETED => (
            SubscriptionEventKind::ProjectDeleted,
            WitEventKind::ProjectDeleted,
            DirectResource::Project,
            true,
        ),
        EventType::TAG_CREATED => (
            SubscriptionEventKind::TagCreated,
            WitEventKind::TagCreated,
            DirectResource::Tag,
            false,
        ),
        EventType::TAG_UPDATED => (
            SubscriptionEventKind::TagUpdated,
            WitEventKind::TagUpdated,
            DirectResource::Tag,
            false,
        ),
        EventType::TAG_DELETED => (
            SubscriptionEventKind::TagDeleted,
            WitEventKind::TagDeleted,
            DirectResource::Tag,
            true,
        ),
        EventType::SECTION_CREATED => (
            SubscriptionEventKind::SectionCreated,
            WitEventKind::SectionCreated,
            DirectResource::Section,
            false,
        ),
        EventType::SECTION_UPDATED => (
            SubscriptionEventKind::SectionUpdated,
            WitEventKind::SectionUpdated,
            DirectResource::Section,
            false,
        ),
        EventType::SECTION_DELETED => (
            SubscriptionEventKind::SectionDeleted,
            WitEventKind::SectionDeleted,
            DirectResource::Section,
            true,
        ),
        _ => return None,
    };
    Some(DirectDescriptor {
        subscription_kind: descriptor.0,
        wit_kind: descriptor.1,
        resource: descriptor.2,
        delete: descriptor.3,
    })
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use junban_domain::{
        ActualMinutes, DreadLevel, EntityName, EstimatedMinutes, HexColor,
        LocalDueTime as DomainLocalDueTime, MarkdownText, MonthlyAnchorDay, OperationId,
        Priority as DomainPriority, ProjectId, RecurrenceRule, SectionId, SortOrder, TagId,
        TagName, TaskTitle,
    };
    use junban_plugin_sdk::private_body_types::EventSubject;

    use super::*;
    use crate::{AffectedIds, ResourceRef, ResyncScope};

    const EVENT_EPOCH: &str = "70000000-0000-7000-8000-000000000001";
    const TASK_ID: &str = "70000000-0000-7000-8000-000000000010";
    const TASK_ID_2: &str = "70000000-0000-7000-8000-000000000011";
    const PROJECT_ID: &str = "70000000-0000-7000-8000-000000000020";
    const PROJECT_ID_2: &str = "70000000-0000-7000-8000-000000000021";
    const TAG_ID: &str = "70000000-0000-7000-8000-000000000030";
    const TAG_ID_2: &str = "70000000-0000-7000-8000-000000000031";
    const SECTION_ID: &str = "70000000-0000-7000-8000-000000000040";
    const SECTION_ID_2: &str = "70000000-0000-7000-8000-000000000041";

    fn timestamp() -> Timestamp {
        "2026-08-05T12:34:56Z".parse().unwrap()
    }

    fn operation_id() -> OperationId {
        OperationId::parse("70000000-0000-7000-8000-000000000099").unwrap()
    }

    fn task(revision: u64) -> Task {
        Task::new(
            TaskId::parse(TASK_ID).unwrap(),
            TaskTitle::new("Retained task").unwrap(),
            None,
            timestamp(),
            revision,
        )
    }

    fn project() -> Project {
        Project::new(
            ProjectId::parse(PROJECT_ID).unwrap(),
            EntityName::new("Retained project").unwrap(),
            HexColor::new("#123456").unwrap(),
            timestamp(),
        )
    }

    fn tag() -> Tag {
        Tag::new(
            TagId::parse(TAG_ID).unwrap(),
            TagName::new("retained").unwrap(),
            HexColor::new("#654321").unwrap(),
            timestamp(),
        )
    }

    fn section() -> Section {
        Section::new(
            SectionId::parse(SECTION_ID).unwrap(),
            ProjectId::parse(PROJECT_ID).unwrap(),
            EntityName::new("Retained section").unwrap(),
            timestamp(),
        )
    }

    fn event(event_type: &str) -> CommittedEvent {
        let mut affected = AffectedIds::default();
        if event_type == EventType::PLUGIN_HEALTH_CHANGED {
            affected.plugin_ids = vec![PluginId::parse("retained-plugin").unwrap()];
        }
        CommittedEvent {
            revision: 7,
            operation_id: operation_id(),
            event_type: EventType::new(event_type),
            occurred_at: timestamp(),
            primary: None,
            snapshot: None,
            affected,
            resync: ResyncScope::NONE,
        }
    }

    fn direct_event(event_type: &str) -> CommittedEvent {
        let mut event = event(event_type);
        let descriptor = direct_descriptor(event_type).unwrap();
        match descriptor.resource {
            DirectResource::Task => {
                let id = TaskId::parse(TASK_ID).unwrap();
                event.primary = Some(ResourceRef::task(id));
                event.affected.task_ids = vec![id];
                if !descriptor.delete {
                    event.snapshot = Some(ResourceSnapshot::task(task(event.revision)));
                }
            }
            DirectResource::Project => {
                let id = ProjectId::parse(PROJECT_ID).unwrap();
                event.primary = Some(ResourceRef::project(id));
                event.affected.project_ids = vec![id];
                if !descriptor.delete {
                    event.snapshot = Some(ResourceSnapshot::Project { project: project() });
                }
            }
            DirectResource::Tag => {
                let id = TagId::parse(TAG_ID).unwrap();
                event.primary = Some(ResourceRef::tag(id));
                event.affected.tag_ids = vec![id];
                if !descriptor.delete {
                    event.snapshot = Some(ResourceSnapshot::Tag { tag: tag() });
                }
            }
            DirectResource::Section => {
                let id = SectionId::parse(SECTION_ID).unwrap();
                event.primary = Some(ResourceRef::section(id));
                event.affected.section_ids = vec![id];
                if !descriptor.delete {
                    event.snapshot = Some(ResourceSnapshot::Section { section: section() });
                }
            }
        }
        event
    }

    fn snapshot_with_id(resource: DirectResource, id: &str, revision: u64) -> ResourceSnapshot {
        match resource {
            DirectResource::Task => ResourceSnapshot::task(Task::new(
                TaskId::parse(id).unwrap(),
                TaskTitle::new("mismatched task").unwrap(),
                None,
                timestamp(),
                revision,
            )),
            DirectResource::Project => ResourceSnapshot::Project {
                project: Project::new(
                    ProjectId::parse(id).unwrap(),
                    EntityName::new("mismatched project").unwrap(),
                    HexColor::new("#abcdef").unwrap(),
                    timestamp(),
                ),
            },
            DirectResource::Tag => ResourceSnapshot::Tag {
                tag: Tag::new(
                    TagId::parse(id).unwrap(),
                    TagName::new("mismatched").unwrap(),
                    HexColor::new("#fedcba").unwrap(),
                    timestamp(),
                ),
            },
            DirectResource::Section => ResourceSnapshot::Section {
                section: Section::new(
                    SectionId::parse(id).unwrap(),
                    ProjectId::parse(PROJECT_ID).unwrap(),
                    EntityName::new("mismatched section").unwrap(),
                    timestamp(),
                ),
            },
        }
    }

    fn clear_direct_affected(event: &mut CommittedEvent, resource: DirectResource) {
        match resource {
            DirectResource::Task => event.affected.task_ids.clear(),
            DirectResource::Project => event.affected.project_ids.clear(),
            DirectResource::Tag => event.affected.tag_ids.clear(),
            DirectResource::Section => event.affected.section_ids.clear(),
        }
    }

    fn add_other_direct_affected(event: &mut CommittedEvent, resource: DirectResource) {
        match resource {
            DirectResource::Task => event
                .affected
                .task_ids
                .push(TaskId::parse(TASK_ID_2).unwrap()),
            DirectResource::Project => event
                .affected
                .project_ids
                .push(ProjectId::parse(PROJECT_ID_2).unwrap()),
            DirectResource::Tag => event.affected.tag_ids.push(TagId::parse(TAG_ID_2).unwrap()),
            DirectResource::Section => event
                .affected
                .section_ids
                .push(SectionId::parse(SECTION_ID_2).unwrap()),
        }
    }

    fn with_json_fields<T>(value: &T, fields: &[(&str, serde_json::Value)]) -> T
    where
        T: serde::Serialize + serde::de::DeserializeOwned,
    {
        let mut encoded = serde_json::to_value(value).unwrap();
        let object = encoded.as_object_mut().unwrap();
        for (field, replacement) in fields {
            object.insert((*field).to_owned(), replacement.clone());
        }
        serde_json::from_value(encoded).unwrap()
    }

    const fn other_id(resource: DirectResource) -> &'static str {
        match resource {
            DirectResource::Task => TASK_ID_2,
            DirectResource::Project => PROJECT_ID_2,
            DirectResource::Tag => TAG_ID_2,
            DirectResource::Section => SECTION_ID_2,
        }
    }

    fn assert_malformed(event: &CommittedEvent, subscription: SubscriptionEventKind) {
        assert_eq!(
            convert_active_plugin_event(EVENT_EPOCH, event, &[subscription]),
            Err(PluginEventError::Malformed),
            "active {}",
            event.event_type.as_str()
        );
        assert_eq!(
            classify_plugin_resync_event(EVENT_EPOCH, event, &[subscription]),
            Err(PluginEventError::Malformed),
            "resync {}",
            event.event_type.as_str()
        );
    }

    fn direct_cases() -> Vec<(&'static str, SubscriptionEventKind, WitEventKind)> {
        vec![
            (
                EventType::TASK_CREATED,
                SubscriptionEventKind::TaskCreated,
                WitEventKind::TaskCreated,
            ),
            (
                EventType::TASK_UPDATED,
                SubscriptionEventKind::TaskUpdated,
                WitEventKind::TaskUpdated,
            ),
            (
                EventType::TASK_COMPLETED,
                SubscriptionEventKind::TaskCompleted,
                WitEventKind::TaskCompleted,
            ),
            (
                EventType::TASK_UNCOMPLETED,
                SubscriptionEventKind::TaskUncompleted,
                WitEventKind::TaskUncompleted,
            ),
            (
                EventType::TASK_CANCELLED,
                SubscriptionEventKind::TaskCancelled,
                WitEventKind::TaskCancelled,
            ),
            (
                EventType::TASK_REOPENED,
                SubscriptionEventKind::TaskReopened,
                WitEventKind::TaskReopened,
            ),
            (
                EventType::TASK_DELETED,
                SubscriptionEventKind::TaskDeleted,
                WitEventKind::TaskDeleted,
            ),
            (
                EventType::PROJECT_CREATED,
                SubscriptionEventKind::ProjectCreated,
                WitEventKind::ProjectCreated,
            ),
            (
                EventType::PROJECT_UPDATED,
                SubscriptionEventKind::ProjectUpdated,
                WitEventKind::ProjectUpdated,
            ),
            (
                EventType::PROJECT_DELETED,
                SubscriptionEventKind::ProjectDeleted,
                WitEventKind::ProjectDeleted,
            ),
            (
                EventType::TAG_CREATED,
                SubscriptionEventKind::TagCreated,
                WitEventKind::TagCreated,
            ),
            (
                EventType::TAG_UPDATED,
                SubscriptionEventKind::TagUpdated,
                WitEventKind::TagUpdated,
            ),
            (
                EventType::TAG_DELETED,
                SubscriptionEventKind::TagDeleted,
                WitEventKind::TagDeleted,
            ),
            (
                EventType::SECTION_CREATED,
                SubscriptionEventKind::SectionCreated,
                WitEventKind::SectionCreated,
            ),
            (
                EventType::SECTION_UPDATED,
                SubscriptionEventKind::SectionUpdated,
                WitEventKind::SectionUpdated,
            ),
            (
                EventType::SECTION_DELETED,
                SubscriptionEventKind::SectionDeleted,
                WitEventKind::SectionDeleted,
            ),
        ]
    }

    fn current_event_types() -> Vec<&'static str> {
        vec![
            EventType::TASK_CREATED,
            EventType::TASK_UPDATED,
            EventType::TASK_COMPLETED,
            EventType::TASK_UNCOMPLETED,
            EventType::TASK_CANCELLED,
            EventType::TASK_REOPENED,
            EventType::TASK_DELETED,
            EventType::TASK_MOVED,
            EventType::TASK_REORDERED,
            EventType::TASK_BULK,
            EventType::TASK_RESTORED,
            EventType::PROJECT_CREATED,
            EventType::PROJECT_UPDATED,
            EventType::PROJECT_DELETED,
            EventType::SECTION_CREATED,
            EventType::SECTION_UPDATED,
            EventType::SECTION_DELETED,
            EventType::TAG_CREATED,
            EventType::TAG_UPDATED,
            EventType::TAG_DELETED,
            EventType::TEMPLATE_CREATED,
            EventType::TEMPLATE_UPDATED,
            EventType::TEMPLATE_DELETED,
            EventType::TEMPLATE_APPLIED,
            EventType::SAVED_FILTER_CREATED,
            EventType::SAVED_FILTER_UPDATED,
            EventType::SAVED_FILTER_DELETED,
            EventType::COMMENT_CREATED,
            EventType::COMMENT_UPDATED,
            EventType::COMMENT_DELETED,
            EventType::RELATION_ADDED,
            EventType::RELATION_REMOVED,
            EventType::OPERATION_UNDONE,
            EventType::TIME_BLOCK_CREATED,
            EventType::TIME_BLOCK_UPDATED,
            EventType::TIME_BLOCK_DELETED,
            EventType::TIME_BLOCK_REPLANNED,
            EventType::TIME_SLOT_CREATED,
            EventType::TIME_SLOT_UPDATED,
            EventType::TIME_SLOT_DELETED,
            EventType::TIME_SLOT_MEMBERSHIP_UPDATED,
            EventType::SETTINGS_UPDATED,
            EventType::IMPORT_APPLIED,
            EventType::AI_SESSION_CHANGED,
            EventType::AI_SESSION_DELETED,
            EventType::AI_MEMORY_CHANGED,
            EventType::AI_MEMORY_DELETED,
            EventType::AI_APPROVAL_CHANGED,
            EventType::PLUGIN_INSTALLED,
            EventType::PLUGIN_REPLACED,
            EventType::PLUGIN_UNINSTALLED,
            EventType::PLUGIN_ENABLED,
            EventType::PLUGIN_DISABLED,
            EventType::PLUGIN_RETRY_REQUESTED,
            EventType::PLUGIN_PUBLISHER_TRUSTED,
            EventType::PLUGIN_PUBLISHER_REVOKED,
            EventType::PLUGIN_COMMUNITY_POLICY_UPDATED,
            EventType::PLUGIN_GRANTS_REPLACED,
            EventType::PLUGIN_GRANTS_REVOKED,
            EventType::PLUGIN_SETTING_UPDATED,
            EventType::PLUGIN_SETTING_DELETED,
            EventType::PLUGIN_HEALTH_CHANGED,
        ]
    }

    fn decoded_event(body: &PluginHandleEventBody) -> EventEnvelope {
        let decoded = decode_invocation_request(InvocationKind::HandleEvent, &body.body).unwrap();
        assert_eq!(serde_json::to_vec(&decoded).unwrap(), body.body);
        assert_eq!(decoded.entry_id(), Some(body.entry_id.as_str()));
        match decoded {
            InvocationRequest::HandleEvent(payload) => {
                let (entry_id, event) = payload.into_parts();
                assert_eq!(entry_id.as_deref(), Some(body.entry_id.as_str()));
                event
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn all_sixteen_direct_mappings_are_canonical_and_bind_the_exact_entry() {
        for (event_type, subscription, expected_kind) in direct_cases() {
            let event = direct_event(event_type);
            let PluginActiveEvent::HandleEvent(body) =
                convert_active_plugin_event(EVENT_EPOCH, &event, &[subscription]).unwrap()
            else {
                panic!("{event_type} was not delivered");
            };
            assert_eq!(body.entry_id.as_str(), subscription.as_str());
            let decoded = decoded_event(&body);
            assert_eq!(decoded.event_epoch, EVENT_EPOCH);
            assert_eq!(decoded.revision, event.revision);
            assert_eq!(decoded.kind, expected_kind);
            match (
                direct_descriptor(event_type).unwrap().resource,
                decoded.subject,
            ) {
                (DirectResource::Task, EventSubject::Task(value)) => assert_eq!(value.id, TASK_ID),
                (DirectResource::Task, EventSubject::DeletedTask(value)) => {
                    assert_eq!(value, TASK_ID)
                }
                (DirectResource::Project, EventSubject::Project(value)) => {
                    assert_eq!(value.id, PROJECT_ID)
                }
                (DirectResource::Project, EventSubject::DeletedProject(value)) => {
                    assert_eq!(value, PROJECT_ID)
                }
                (DirectResource::Tag, EventSubject::Tag(value)) => assert_eq!(value.id, TAG_ID),
                (DirectResource::Tag, EventSubject::DeletedTag(value)) => assert_eq!(value, TAG_ID),
                (DirectResource::Section, EventSubject::Section(value)) => {
                    assert_eq!(value.id, SECTION_ID)
                }
                (DirectResource::Section, EventSubject::DeletedSection(value)) => {
                    assert_eq!(value, SECTION_ID)
                }
                _ => panic!("{event_type} produced the wrong subject"),
            }

            assert_eq!(
                convert_active_plugin_event(EVENT_EPOCH, &event, &[]).unwrap(),
                PluginActiveEvent::Irrelevant,
                "{event_type}"
            );
        }
    }

    #[test]
    fn task_subject_preserves_every_wit_field_and_input_order_deterministically() {
        let mut snapshot = task(39);
        snapshot.description = MarkdownText::new("retained description").unwrap();
        snapshot.priority = Some(DomainPriority::new(2).unwrap());
        snapshot.due_date = Some("2026-08-06".parse().unwrap());
        snapshot.due_time =
            Some(DomainLocalDueTime::parse("09:30:15", "America/New_York").unwrap());
        snapshot.deadline = Some("2026-08-07T13:00:00Z".parse().unwrap());
        snapshot.someday = true;
        snapshot.estimated_minutes = Some(EstimatedMinutes::new(45).unwrap());
        snapshot.actual_minutes = Some(ActualMinutes::new(0).unwrap());
        snapshot.dread = Some(DreadLevel::new(4).unwrap());
        snapshot.project_id = Some(ProjectId::parse(PROJECT_ID).unwrap());
        snapshot.section_id = Some(SectionId::parse(SECTION_ID).unwrap());
        snapshot.parent_id = Some(TaskId::parse(TASK_ID_2).unwrap());
        snapshot.tag_ids = vec![
            TagId::parse(TAG_ID).unwrap(),
            TagId::parse(TAG_ID_2).unwrap(),
        ];
        snapshot.sort_order = SortOrder::new(-17);
        snapshot.recurrence_rule = Some(RecurrenceRule::new("monthly").unwrap());
        snapshot.remind_at = Some("2026-08-06T12:00:00Z".parse().unwrap());
        snapshot.recurrence_anchor_day = Some(MonthlyAnchorDay::new(5).unwrap());
        snapshot.complete(timestamp());

        let mut event = direct_event(EventType::TASK_UPDATED);
        event.revision = 41;
        event.snapshot = Some(ResourceSnapshot::task(snapshot));
        let convert = || {
            let PluginActiveEvent::HandleEvent(body) = convert_active_plugin_event(
                EVENT_EPOCH,
                &event,
                &[SubscriptionEventKind::TaskUpdated],
            )
            .unwrap() else {
                panic!("task was not delivered");
            };
            body
        };
        let body = convert();
        assert_eq!(body, convert());
        let EventSubject::Task(actual) = decoded_event(&body).subject else {
            panic!("wrong task subject");
        };
        assert_eq!(
            actual,
            TaskView {
                id: TASK_ID.to_owned(),
                title: "Retained task".to_owned(),
                description: "retained description".to_owned(),
                status: WitTaskStatus::Completed,
                priority: Some(Priority::P2),
                due_date: Some("2026-08-06".to_owned()),
                due_time: Some(LocalDueTime {
                    time: "09:30:15".to_owned(),
                    time_zone: "America/New_York".to_owned(),
                }),
                deadline: Some("2026-08-07T13:00:00Z".to_owned()),
                someday: true,
                estimated_minutes: Some(45),
                actual_minutes: Some(0),
                dread: Some(4),
                project_id: Some(PROJECT_ID.to_owned()),
                section_id: Some(SECTION_ID.to_owned()),
                parent_id: Some(TASK_ID_2.to_owned()),
                tag_ids: vec![TAG_ID.to_owned(), TAG_ID_2.to_owned()],
                sort_order: -17,
                recurrence_rule: Some("monthly".to_owned()),
                remind_at: Some("2026-08-06T12:00:00Z".to_owned()),
                recurrence_anchor_day: Some(5),
                created_at: "2026-08-05T12:34:56Z".to_owned(),
                updated_at: "2026-08-05T12:34:56Z".to_owned(),
                revision: 39,
            }
        );
    }

    #[test]
    fn tombstone_body_has_frozen_canonical_bytes() {
        let event = direct_event(EventType::TASK_DELETED);
        let PluginActiveEvent::HandleEvent(body) =
            convert_active_plugin_event(EVENT_EPOCH, &event, &[SubscriptionEventKind::TaskDeleted])
                .unwrap()
        else {
            panic!("delete was not delivered");
        };
        assert_eq!(
            std::str::from_utf8(&body.body).unwrap(),
            concat!(
                "{\"tag\":\"handle-event\",\"val\":{\"entry-id\":\"task-deleted\",",
                "\"argument\":{\"event-epoch\":\"70000000-0000-7000-8000-000000000001\",",
                "\"revision\":7,\"kind\":\"task-deleted\",\"subject\":{\"tag\":",
                "\"deleted-task\",\"val\":\"70000000-0000-7000-8000-000000000010\"}}}}"
            )
        );
    }

    #[test]
    fn every_current_event_type_has_subscribed_and_unsubscribed_active_and_resync_treatment() {
        let direct_kinds: std::collections::HashMap<_, _> = direct_cases()
            .into_iter()
            .map(|(event_type, subscription, _)| (event_type, subscription))
            .collect();
        let current = current_event_types();
        let unique: HashSet<_> = current.iter().copied().collect();
        assert_eq!(unique.len(), current.len());

        for event_type in current {
            if let Some(subscription) = direct_kinds.get(event_type).copied() {
                let event = direct_event(event_type);
                assert!(matches!(
                    convert_active_plugin_event(EVENT_EPOCH, &event, &[subscription]).unwrap(),
                    PluginActiveEvent::HandleEvent(_)
                ));
                assert_eq!(
                    convert_active_plugin_event(EVENT_EPOCH, &event, &[]).unwrap(),
                    PluginActiveEvent::Irrelevant
                );
                let subscribed =
                    classify_plugin_resync_event(EVENT_EPOCH, &event, &[subscription]).unwrap();
                let unsubscribed = classify_plugin_resync_event(EVENT_EPOCH, &event, &[]).unwrap();
                assert!(
                    matches!(subscribed, PluginResyncEvent::Represented(_)),
                    "{event_type}"
                );
                let expected_unsubscribed =
                    if direct_descriptor(event_type).unwrap().resource == DirectResource::Section {
                        PluginResyncEvent::Irrelevant
                    } else {
                        PluginResyncEvent::Invalidating
                    };
                assert_eq!(unsubscribed, expected_unsubscribed, "{event_type}");
            } else {
                let event = event(event_type);
                assert_eq!(
                    convert_active_plugin_event(EVENT_EPOCH, &event, &[]).unwrap(),
                    PluginActiveEvent::Irrelevant,
                    "{event_type}"
                );
                let expected = if always_invalidates_resync(event_type) {
                    PluginResyncEvent::Invalidating
                } else {
                    PluginResyncEvent::Irrelevant
                };
                assert_eq!(
                    classify_plugin_resync_event(EVENT_EPOCH, &event, &[]).unwrap(),
                    expected,
                    "{event_type}"
                );
            }
        }
    }

    #[test]
    fn every_direct_kind_rejects_primary_affected_snapshot_delete_and_revision_mismatches() {
        for (event_type, subscription, _) in direct_cases() {
            let descriptor = direct_descriptor(event_type).unwrap();
            let base = direct_event(event_type);

            let mut malformed = base.clone();
            malformed.revision = 0;
            assert_malformed(&malformed, subscription);

            let mut malformed = base.clone();
            malformed.primary.as_mut().unwrap().id = other_id(descriptor.resource).to_owned();
            assert_malformed(&malformed, subscription);

            let mut malformed = base.clone();
            clear_direct_affected(&mut malformed, descriptor.resource);
            assert_malformed(&malformed, subscription);

            let mut malformed = base;
            if descriptor.delete {
                malformed.snapshot = Some(snapshot_with_id(
                    descriptor.resource,
                    other_id(descriptor.resource),
                    malformed.revision,
                ));
                assert_malformed(&malformed, subscription);
            } else {
                malformed.snapshot = None;
                assert_malformed(&malformed, subscription);

                malformed = direct_event(event_type);
                malformed.snapshot = Some(snapshot_with_id(
                    descriptor.resource,
                    other_id(descriptor.resource),
                    malformed.revision,
                ));
                assert_malformed(&malformed, subscription);
            }
        }
    }

    #[test]
    fn only_exact_multi_task_completion_cascades_may_omit_nondelete_snapshots() {
        for (event_type, subscription, _) in direct_cases() {
            let descriptor = direct_descriptor(event_type).unwrap();
            if descriptor.delete {
                continue;
            }
            let mut event = direct_event(event_type);
            add_other_direct_affected(&mut event, descriptor.resource);
            event.snapshot = None;

            if matches!(
                event_type,
                EventType::TASK_COMPLETED | EventType::TASK_UNCOMPLETED
            ) {
                event.resync = ResyncScope::TASKS;
                assert_eq!(
                    convert_active_plugin_event(EVENT_EPOCH, &event, &[subscription]).unwrap(),
                    PluginActiveEvent::Irrelevant,
                    "{event_type}"
                );
            } else {
                assert_malformed(&event, subscription);
            }
        }

        let mut wrong_resync = direct_event(EventType::TASK_COMPLETED);
        add_other_direct_affected(&mut wrong_resync, DirectResource::Task);
        wrong_resync.snapshot = None;
        assert_malformed(&wrong_resync, SubscriptionEventKind::TaskCompleted);

        let mut mixed = wrong_resync;
        mixed.resync = ResyncScope::TASKS;
        mixed
            .affected
            .section_ids
            .push(SectionId::parse(SECTION_ID).unwrap());
        assert_malformed(&mixed, SubscriptionEventKind::TaskCompleted);
    }

    #[test]
    fn every_nonrepresentable_direct_multi_id_event_invalidates_resync() {
        for (event_type, subscription, _) in direct_cases() {
            let descriptor = direct_descriptor(event_type).unwrap();
            let mut event = direct_event(event_type);
            add_other_direct_affected(&mut event, descriptor.resource);
            assert_eq!(
                convert_active_plugin_event(EVENT_EPOCH, &event, &[subscription]).unwrap(),
                PluginActiveEvent::Irrelevant,
                "active {event_type}"
            );
            assert_eq!(
                classify_plugin_resync_event(EVENT_EPOCH, &event, &[subscription]).unwrap(),
                PluginResyncEvent::Invalidating,
                "subscribed {event_type}"
            );
            assert_eq!(
                classify_plugin_resync_event(EVENT_EPOCH, &event, &[]).unwrap(),
                PluginResyncEvent::Invalidating,
                "unsubscribed {event_type}"
            );
        }
    }

    #[test]
    fn malformed_direct_type_primary_snapshot_id_affected_and_revision_fail_closed() {
        let base = direct_event(EventType::TASK_CREATED);
        let other_task = TaskId::parse(TASK_ID_2).unwrap();
        let project_id = ProjectId::parse(PROJECT_ID).unwrap();
        let mut cases = Vec::new();

        let mut value = base.clone();
        value.primary = None;
        cases.push(value);
        let mut value = base.clone();
        value.primary = Some(ResourceRef::project(project_id));
        cases.push(value);
        let mut value = base.clone();
        value.snapshot = None;
        cases.push(value);
        let mut value = base.clone();
        value.snapshot = Some(ResourceSnapshot::Project { project: project() });
        cases.push(value);
        let mut value = base.clone();
        value.snapshot = Some(ResourceSnapshot::task(Task::new(
            other_task,
            TaskTitle::new("other").unwrap(),
            None,
            timestamp(),
            value.revision,
        )));
        cases.push(value);
        let mut value = base.clone();
        value.affected.task_ids.clear();
        cases.push(value);
        let mut value = base.clone();
        value.affected.task_ids = vec![other_task];
        cases.push(value);
        let mut value = base.clone();
        value.revision = 0;
        cases.push(value);
        let mut value = direct_event(EventType::TASK_DELETED);
        value.snapshot = Some(ResourceSnapshot::task(task(value.revision)));
        cases.push(value);

        for malformed in cases {
            assert_eq!(
                convert_active_plugin_event(
                    EVENT_EPOCH,
                    &malformed,
                    &[SubscriptionEventKind::TaskCreated]
                ),
                Err(PluginEventError::Malformed)
            );
            assert_eq!(
                classify_plugin_resync_event(
                    EVENT_EPOCH,
                    &malformed,
                    &[SubscriptionEventKind::TaskCreated]
                ),
                Err(PluginEventError::Malformed)
            );
        }

        assert_eq!(
            convert_active_plugin_event("not-an-epoch", &base, &[]),
            Err(PluginEventError::Malformed)
        );
        let malformed_type = event("Bad Event");
        assert_eq!(
            classify_plugin_resync_event(EVENT_EPOCH, &malformed_type, &[]),
            Err(PluginEventError::Malformed)
        );
    }

    #[test]
    fn every_present_other_primary_uses_its_exact_canonical_id_authority() {
        for (resource_type, id) in [
            (ResourceType::Task, TASK_ID),
            (ResourceType::Project, PROJECT_ID),
            (ResourceType::Section, SECTION_ID),
            (ResourceType::Tag, TAG_ID),
            (ResourceType::Template, TASK_ID),
            (ResourceType::SavedFilter, TASK_ID),
            (ResourceType::Comment, TASK_ID),
            (ResourceType::Operation, TASK_ID),
            (ResourceType::TimeBlock, TASK_ID),
            (ResourceType::TimeSlot, TASK_ID),
            (ResourceType::Settings, "settings"),
            (ResourceType::AiSession, TASK_ID),
            (ResourceType::AiMemory, TASK_ID),
            (ResourceType::AiApproval, TASK_ID),
            (ResourceType::Plugin, "retained-plugin"),
        ] {
            let mut other = event(EventType::COMMENT_UPDATED);
            other.primary = Some(ResourceRef {
                resource_type,
                id: id.to_owned(),
            });
            assert_eq!(
                convert_active_plugin_event(EVENT_EPOCH, &other, &[]).unwrap(),
                PluginActiveEvent::Irrelevant,
                "{resource_type:?}"
            );
            assert_eq!(
                classify_plugin_resync_event(EVENT_EPOCH, &other, &[]).unwrap(),
                PluginResyncEvent::Irrelevant,
                "{resource_type:?}"
            );
        }

        for resource_type in [
            ResourceType::Task,
            ResourceType::Project,
            ResourceType::Section,
            ResourceType::Tag,
            ResourceType::Template,
            ResourceType::SavedFilter,
            ResourceType::Comment,
            ResourceType::Relation,
            ResourceType::Operation,
            ResourceType::TimeBlock,
            ResourceType::TimeSlot,
            ResourceType::Settings,
            ResourceType::AiSession,
            ResourceType::AiMemory,
            ResourceType::AiApproval,
            ResourceType::Plugin,
        ] {
            let mut other = event(EventType::COMMENT_UPDATED);
            other.primary = Some(ResourceRef {
                resource_type,
                id: "Not Canonical".to_owned(),
            });
            assert_malformed(&other, SubscriptionEventKind::TaskUpdated);
        }

        let mut uppercase_uuid = event(EventType::COMMENT_UPDATED);
        uppercase_uuid.primary = Some(ResourceRef {
            resource_type: ResourceType::Task,
            id: "70000000-0000-7000-8000-0000000000AA".to_owned(),
        });
        assert_malformed(&uppercase_uuid, SubscriptionEventKind::TaskUpdated);
    }

    #[test]
    fn plugin_health_changed_requires_one_to_sixteen_strictly_sorted_plugin_ids() {
        let mut valid = event(EventType::PLUGIN_HEALTH_CHANGED);
        valid.affected.plugin_ids = vec![
            PluginId::parse("alpha-plugin").unwrap(),
            PluginId::parse("beta-plugin").unwrap(),
        ];
        assert_eq!(
            convert_active_plugin_event(EVENT_EPOCH, &valid, &[]).unwrap(),
            PluginActiveEvent::Irrelevant
        );
        assert_eq!(
            classify_plugin_resync_event(EVENT_EPOCH, &valid, &[]).unwrap(),
            PluginResyncEvent::Irrelevant
        );

        let mut zero = valid.clone();
        zero.affected.plugin_ids.clear();
        assert_malformed(&zero, SubscriptionEventKind::TaskUpdated);

        let mut reversed = valid.clone();
        reversed.affected.plugin_ids.reverse();
        assert_malformed(&reversed, SubscriptionEventKind::TaskUpdated);

        let mut duplicate = valid.clone();
        duplicate.affected.plugin_ids[1] = duplicate.affected.plugin_ids[0].clone();
        assert_malformed(&duplicate, SubscriptionEventKind::TaskUpdated);

        let mut seventeen = valid;
        seventeen.affected.plugin_ids = (0..17)
            .map(|index| PluginId::parse(format!("plugin-{index:02}")).unwrap())
            .collect();
        assert_malformed(&seventeen, SubscriptionEventKind::TaskUpdated);
    }

    #[test]
    fn task_snapshot_one_field_invariant_matrix_fails_closed() {
        let baseline = task(7);
        let malformed = vec![
            with_json_fields(&baseline, &[("title", serde_json::json!(""))]),
            with_json_fields(
                &baseline,
                &[("description", serde_json::json!("x".repeat(10_001)))],
            ),
            with_json_fields(&baseline, &[("priority", serde_json::json!(0))]),
            with_json_fields(&baseline, &[("dread", serde_json::json!(0))]),
            with_json_fields(&baseline, &[("estimated_minutes", serde_json::json!(0))]),
            with_json_fields(
                &baseline,
                &[("tag_ids", serde_json::json!([TAG_ID, TAG_ID]))],
            ),
            with_json_fields(
                &baseline,
                &[("recurrence_rule", serde_json::json!(" DAILY "))],
            ),
            with_json_fields(
                &baseline,
                &[
                    ("due_date", serde_json::json!("2026-08-06")),
                    ("recurrence_rule", serde_json::json!("monthly")),
                ],
            ),
            with_json_fields(
                &baseline,
                &[
                    ("due_date", serde_json::json!("2026-08-06")),
                    ("recurrence_rule", serde_json::json!("weekly")),
                    ("recurrence_anchor_day", serde_json::json!(5)),
                ],
            ),
            with_json_fields(
                &baseline,
                &[
                    ("due_date", serde_json::json!("2026-08-06")),
                    ("recurrence_rule", serde_json::json!("monthly")),
                    ("recurrence_anchor_day", serde_json::json!(0)),
                ],
            ),
            with_json_fields(
                &baseline,
                &[("recurrence_source_id", serde_json::json!(TASK_ID))],
            ),
            with_json_fields(
                &baseline,
                &[(
                    "due_time",
                    serde_json::json!({"time": "09:30:00", "time_zone": "invalid"}),
                )],
            ),
            with_json_fields(
                &baseline,
                &[(
                    "due_time",
                    serde_json::json!({"time": "09:30:00", "time_zone": "UTC"}),
                )],
            ),
            with_json_fields(&baseline, &[("status", serde_json::json!("completed"))]),
            with_json_fields(
                &baseline,
                &[("completed_at", serde_json::json!("2026-08-05T12:34:56Z"))],
            ),
            with_json_fields(
                &baseline,
                &[(
                    "completion_operation_id",
                    serde_json::json!(operation_id().to_string()),
                )],
            ),
            with_json_fields(&baseline, &[("parent_id", serde_json::json!(TASK_ID))]),
            with_json_fields(&baseline, &[("section_id", serde_json::json!(SECTION_ID))]),
            with_json_fields(
                &baseline,
                &[("updated_at", serde_json::json!("2026-08-04T12:34:56Z"))],
            ),
            with_json_fields(&baseline, &[("revision", serde_json::json!(0))]),
            with_json_fields(&baseline, &[("revision", serde_json::json!(8))]),
        ];

        for (index, task) in malformed.into_iter().enumerate() {
            let mut event = direct_event(EventType::TASK_UPDATED);
            event.snapshot = Some(ResourceSnapshot::task(task));
            assert_eq!(
                convert_active_plugin_event(
                    EVENT_EPOCH,
                    &event,
                    &[SubscriptionEventKind::TaskUpdated]
                ),
                Err(PluginEventError::Malformed),
                "active case {index}"
            );
            assert_eq!(
                classify_plugin_resync_event(
                    EVENT_EPOCH,
                    &event,
                    &[SubscriptionEventKind::TaskUpdated]
                ),
                Err(PluginEventError::Malformed),
                "resync case {index}"
            );
        }
    }

    #[test]
    fn catalog_snapshot_one_field_invariant_matrices_fail_closed() {
        let project = project();
        for (index, malformed) in [
            with_json_fields(&project, &[("name", serde_json::json!(""))]),
            with_json_fields(&project, &[("color", serde_json::json!("blue"))]),
            with_json_fields(&project, &[("icon", serde_json::json!(""))]),
            with_json_fields(&project, &[("parent_id", serde_json::json!(PROJECT_ID))]),
            with_json_fields(
                &project,
                &[("updated_at", serde_json::json!("2026-08-04T12:34:56Z"))],
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let mut event = direct_event(EventType::PROJECT_UPDATED);
            event.snapshot = Some(ResourceSnapshot::Project { project: malformed });
            assert_malformed(&event, SubscriptionEventKind::ProjectUpdated);
            assert!(index < 5);
        }

        let section = section();
        for malformed in [
            with_json_fields(&section, &[("name", serde_json::json!(""))]),
            with_json_fields(
                &section,
                &[("updated_at", serde_json::json!("2026-08-04T12:34:56Z"))],
            ),
        ] {
            let mut event = direct_event(EventType::SECTION_UPDATED);
            event.snapshot = Some(ResourceSnapshot::Section { section: malformed });
            assert_malformed(&event, SubscriptionEventKind::SectionUpdated);
        }

        let tag = tag();
        for malformed in [
            with_json_fields(&tag, &[("name", serde_json::json!(" retained "))]),
            with_json_fields(&tag, &[("color", serde_json::json!("green"))]),
            with_json_fields(
                &tag,
                &[("updated_at", serde_json::json!("2026-08-04T12:34:56Z"))],
            ),
        ] {
            let mut event = direct_event(EventType::TAG_UPDATED);
            event.snapshot = Some(ResourceSnapshot::Tag { tag: malformed });
            assert_malformed(&event, SubscriptionEventKind::TagUpdated);
        }
    }

    #[test]
    fn valid_multi_subject_cascades_are_nonrepresentable_not_malformed() {
        for (event_type, subscription) in [
            (
                EventType::TASK_COMPLETED,
                SubscriptionEventKind::TaskCompleted,
            ),
            (
                EventType::TASK_UNCOMPLETED,
                SubscriptionEventKind::TaskUncompleted,
            ),
            (EventType::TASK_DELETED, SubscriptionEventKind::TaskDeleted),
        ] {
            let mut cascade = direct_event(event_type);
            cascade
                .affected
                .task_ids
                .push(TaskId::parse(TASK_ID_2).unwrap());
            cascade.snapshot = None;
            if matches!(
                event_type,
                EventType::TASK_COMPLETED | EventType::TASK_UNCOMPLETED
            ) {
                cascade.resync = ResyncScope::TASKS;
            }
            assert_eq!(
                convert_active_plugin_event(EVENT_EPOCH, &cascade, &[subscription]).unwrap(),
                PluginActiveEvent::Irrelevant
            );
            assert_eq!(
                classify_plugin_resync_event(EVENT_EPOCH, &cascade, &[subscription]).unwrap(),
                PluginResyncEvent::Invalidating
            );
        }

        let mut complete_with_primary_snapshot = direct_event(EventType::TASK_COMPLETED);
        complete_with_primary_snapshot
            .affected
            .task_ids
            .push(TaskId::parse(TASK_ID_2).unwrap());
        assert_eq!(
            convert_active_plugin_event(
                EVENT_EPOCH,
                &complete_with_primary_snapshot,
                &[SubscriptionEventKind::TaskCompleted]
            )
            .unwrap(),
            PluginActiveEvent::Irrelevant
        );
    }

    #[test]
    fn mixed_baseline_ids_deliver_when_active_but_invalidate_resync() {
        let mut task_event = direct_event(EventType::TASK_UPDATED);
        task_event
            .affected
            .project_ids
            .push(ProjectId::parse(PROJECT_ID).unwrap());
        assert!(matches!(
            convert_active_plugin_event(
                EVENT_EPOCH,
                &task_event,
                &[SubscriptionEventKind::TaskUpdated]
            )
            .unwrap(),
            PluginActiveEvent::HandleEvent(_)
        ));
        assert_eq!(
            classify_plugin_resync_event(
                EVENT_EPOCH,
                &task_event,
                &[SubscriptionEventKind::TaskUpdated]
            )
            .unwrap(),
            PluginResyncEvent::Invalidating
        );

        let mut project_delete = direct_event(EventType::PROJECT_DELETED);
        project_delete
            .affected
            .task_ids
            .push(TaskId::parse(TASK_ID).unwrap());
        assert!(matches!(
            convert_active_plugin_event(
                EVENT_EPOCH,
                &project_delete,
                &[SubscriptionEventKind::ProjectDeleted]
            )
            .unwrap(),
            PluginActiveEvent::HandleEvent(_)
        ));
        assert_eq!(
            classify_plugin_resync_event(
                EVENT_EPOCH,
                &project_delete,
                &[SubscriptionEventKind::ProjectDeleted]
            )
            .unwrap(),
            PluginResyncEvent::Invalidating
        );

        let mut section_event = direct_event(EventType::SECTION_CREATED);
        section_event
            .affected
            .project_ids
            .push(ProjectId::parse(PROJECT_ID).unwrap());
        assert!(matches!(
            convert_active_plugin_event(
                EVENT_EPOCH,
                &section_event,
                &[SubscriptionEventKind::SectionCreated]
            )
            .unwrap(),
            PluginActiveEvent::HandleEvent(_)
        ));
        assert_eq!(
            classify_plugin_resync_event(
                EVENT_EPOCH,
                &section_event,
                &[SubscriptionEventKind::SectionCreated]
            )
            .unwrap(),
            PluginResyncEvent::Invalidating
        );
    }

    #[test]
    fn resync_classification_is_conservative_for_mutations_future_ids_and_section_only_work() {
        for event_type in [
            EventType::TASK_MOVED,
            EventType::TASK_REORDERED,
            EventType::TASK_BULK,
            EventType::TASK_RESTORED,
            EventType::OPERATION_UNDONE,
            EventType::IMPORT_APPLIED,
        ] {
            assert_eq!(
                classify_plugin_resync_event(EVENT_EPOCH, &event(event_type), &[]).unwrap(),
                PluginResyncEvent::Invalidating,
                "{event_type}"
            );
        }

        let mut future = event("future.resource_changed");
        future
            .affected
            .task_ids
            .push(TaskId::parse(TASK_ID).unwrap());
        assert_eq!(
            classify_plugin_resync_event(EVENT_EPOCH, &future, &[]).unwrap(),
            PluginResyncEvent::Invalidating
        );
        future.affected.task_ids.clear();
        assert_eq!(
            classify_plugin_resync_event(EVENT_EPOCH, &future, &[]).unwrap(),
            PluginResyncEvent::Irrelevant
        );

        for event_type in [
            EventType::SECTION_CREATED,
            EventType::SECTION_UPDATED,
            EventType::SECTION_DELETED,
        ] {
            let section_only = direct_event(event_type);
            let subscription = direct_descriptor(event_type).unwrap().subscription_kind;
            assert!(matches!(
                classify_plugin_resync_event(EVENT_EPOCH, &section_only, &[subscription]).unwrap(),
                PluginResyncEvent::Represented(_)
            ));
            assert_eq!(
                classify_plugin_resync_event(EVENT_EPOCH, &section_only, &[]).unwrap(),
                PluginResyncEvent::Irrelevant
            );
            assert!(matches!(
                convert_active_plugin_event(EVENT_EPOCH, &section_only, &[subscription]).unwrap(),
                PluginActiveEvent::HandleEvent(_)
            ));
        }

        assert_eq!(
            classify_plugin_resync_event(
                EVENT_EPOCH,
                &event(EventType::PLUGIN_HEALTH_CHANGED),
                &[]
            )
            .unwrap(),
            PluginResyncEvent::Irrelevant
        );
    }

    #[test]
    fn task_snapshot_revision_and_enclosing_catalog_revisions_are_preserved() {
        let mut task_event = direct_event(EventType::TASK_UPDATED);
        task_event.revision = 41;
        task_event.snapshot = Some(ResourceSnapshot::task(task(39)));
        let PluginActiveEvent::HandleEvent(body) = convert_active_plugin_event(
            EVENT_EPOCH,
            &task_event,
            &[SubscriptionEventKind::TaskUpdated],
        )
        .unwrap() else {
            panic!("task not delivered");
        };
        let EventSubject::Task(task) = decoded_event(&body).subject else {
            panic!("wrong task subject");
        };
        assert_eq!(task.revision, 39);

        for (event_type, subscription) in [
            (
                EventType::PROJECT_UPDATED,
                SubscriptionEventKind::ProjectUpdated,
            ),
            (EventType::TAG_UPDATED, SubscriptionEventKind::TagUpdated),
            (
                EventType::SECTION_UPDATED,
                SubscriptionEventKind::SectionUpdated,
            ),
        ] {
            let mut event = direct_event(event_type);
            event.revision = 41;
            let PluginActiveEvent::HandleEvent(body) =
                convert_active_plugin_event(EVENT_EPOCH, &event, &[subscription]).unwrap()
            else {
                panic!("{event_type} not delivered");
            };
            let revision = match decoded_event(&body).subject {
                EventSubject::Project(value) => value.revision,
                EventSubject::Tag(value) => value.revision,
                EventSubject::Section(value) => value.revision,
                _ => panic!("wrong catalog subject"),
            };
            assert_eq!(revision, 41, "{event_type}");
        }
    }

    #[test]
    fn duplicate_affected_ids_fail_closed_without_reordering() {
        let mut event = direct_event(EventType::TASK_UPDATED);
        event
            .affected
            .task_ids
            .push(TaskId::parse(TASK_ID).unwrap());
        assert_eq!(
            convert_active_plugin_event(EVENT_EPOCH, &event, &[]),
            Err(PluginEventError::Malformed)
        );

        let mut event = direct_event(EventType::TASK_UPDATED);
        event.affected.task_ids = vec![
            TaskId::parse(TASK_ID_2).unwrap(),
            TaskId::parse(TASK_ID).unwrap(),
        ];
        assert_eq!(
            convert_active_plugin_event(EVENT_EPOCH, &event, &[SubscriptionEventKind::TaskUpdated])
                .unwrap(),
            PluginActiveEvent::Irrelevant
        );
        assert_eq!(
            classify_plugin_resync_event(
                EVENT_EPOCH,
                &event,
                &[SubscriptionEventKind::TaskUpdated]
            )
            .unwrap(),
            PluginResyncEvent::Invalidating
        );
    }

    #[test]
    fn all_four_delete_tombstones_reject_snapshots_and_decode_to_exact_ids() {
        for (event_type, subscription, expected_id) in [
            (
                EventType::TASK_DELETED,
                SubscriptionEventKind::TaskDeleted,
                TASK_ID,
            ),
            (
                EventType::PROJECT_DELETED,
                SubscriptionEventKind::ProjectDeleted,
                PROJECT_ID,
            ),
            (
                EventType::TAG_DELETED,
                SubscriptionEventKind::TagDeleted,
                TAG_ID,
            ),
            (
                EventType::SECTION_DELETED,
                SubscriptionEventKind::SectionDeleted,
                SECTION_ID,
            ),
        ] {
            let mut event = direct_event(event_type);
            let PluginActiveEvent::HandleEvent(body) =
                convert_active_plugin_event(EVENT_EPOCH, &event, &[subscription]).unwrap()
            else {
                panic!("{event_type} not delivered");
            };
            let actual_id = match decoded_event(&body).subject {
                EventSubject::DeletedTask(value)
                | EventSubject::DeletedProject(value)
                | EventSubject::DeletedTag(value)
                | EventSubject::DeletedSection(value) => value,
                _ => panic!("wrong tombstone"),
            };
            assert_eq!(actual_id, expected_id);

            event.snapshot = Some(ResourceSnapshot::task(task(event.revision)));
            assert_eq!(
                convert_active_plugin_event(EVENT_EPOCH, &event, &[subscription]),
                Err(PluginEventError::Malformed)
            );
        }
    }

    #[test]
    fn baseline_disjoint_nonrepresentable_work_is_cursor_only() {
        let event = event(EventType::COMMENT_UPDATED);
        assert_eq!(
            convert_active_plugin_event(EVENT_EPOCH, &event, &[SubscriptionEventKind::TaskUpdated])
                .unwrap(),
            PluginActiveEvent::Irrelevant
        );
        assert_eq!(
            classify_plugin_resync_event(
                EVENT_EPOCH,
                &event,
                &[SubscriptionEventKind::TaskUpdated]
            )
            .unwrap(),
            PluginResyncEvent::Irrelevant
        );

        let mut relevant = event;
        relevant
            .affected
            .project_ids
            .push(ProjectId::parse(PROJECT_ID_2).unwrap());
        assert_eq!(
            classify_plugin_resync_event(EVENT_EPOCH, &relevant, &[]).unwrap(),
            PluginResyncEvent::Invalidating
        );
    }
}
