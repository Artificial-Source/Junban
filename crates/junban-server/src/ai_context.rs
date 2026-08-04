//! Deterministic, bounded provider context assembly for one basic chat round.
//!
//! Only confirmed settings, explicit memories, an optional focused task, and
//! durable user/assistant text enter this module. Receipts, events, diagnostics,
//! provider errors, tool bodies, and hidden reasoning are never inputs.

use junban_ai::ChatMessage;
use junban_app::{ListAiMessagesRequest, SelectAiMemoriesRequest};
use junban_domain::{
    AI_MESSAGE_PAGE_MAX, AiMemory, AiMessage, AiMessageRole, AiMessageStatus, AiSessionId, Task,
};
use serde::Serialize;
use utoipa::ToSchema;

use crate::sse::AppService;

/// Maximum durable conversation rows inspected for one run.
pub const AI_CONTEXT_HISTORY_ROWS_MAX: usize = 500;
/// Maximum explicit memories inspected for one run.
pub const AI_CONTEXT_MEMORY_ROWS_MAX: usize = 50;
/// Hard aggregate UTF-8 context ceiling.
pub const AI_CONTEXT_UTF8_BYTES_MAX: usize = 512 * 1024;
/// Hard approximate prompt-token ceiling.
pub const AI_CONTEXT_TOKENS_MAX: usize = 8_000;

const MESSAGE_OVERHEAD_BYTES: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct AiContextMetadata {
    pub history_rows_loaded: usize,
    pub history_messages_included: usize,
    pub memories_considered: usize,
    pub memories_included: usize,
    pub focused_task_included: bool,
    pub truncated: bool,
    pub utf8_bytes: usize,
    pub approximate_tokens: usize,
}

#[derive(Debug)]
pub struct AssembledAiContext {
    pub messages: Vec<ChatMessage>,
    pub metadata: AiContextMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AiContextError {
    #[error("AI message must not be empty")]
    EmptyMessage,
    #[error("AI message exceeds the input limit")]
    MessageTooLarge,
    #[error("required AI context exceeds the context limit")]
    RequiredContextTooLarge,
}

pub async fn load_recent_messages(
    service: &AppService,
    session_id: AiSessionId,
) -> Result<Vec<AiMessage>, junban_app::AppError> {
    let mut messages = Vec::with_capacity(AI_CONTEXT_HISTORY_ROWS_MAX);
    let mut after_sequence = None;
    while messages.len() < AI_CONTEXT_HISTORY_ROWS_MAX {
        let remaining = AI_CONTEXT_HISTORY_ROWS_MAX - messages.len();
        let limit = remaining.min(AI_MESSAGE_PAGE_MAX as usize) as u32;
        let page = service
            .list_ai_messages(ListAiMessagesRequest {
                session_id,
                after_sequence,
                limit: Some(limit),
            })
            .await?;
        if page.is_empty() {
            break;
        }
        after_sequence = page.last().map(|message| message.sequence);
        let page_len = page.len();
        messages.extend(page);
        if page_len < limit as usize {
            break;
        }
    }
    Ok(messages)
}

pub async fn load_context_memories(
    service: &AppService,
    session_id: AiSessionId,
) -> Result<Vec<AiMemory>, junban_app::AppError> {
    service
        .select_ai_memories_for_context(SelectAiMemoriesRequest {
            session_id: Some(session_id),
            limit: Some(AI_CONTEXT_MEMORY_ROWS_MAX as u32),
        })
        .await
}

pub fn assemble_context(
    custom_instructions: &str,
    memories: &[AiMemory],
    focused_task: Option<&Task>,
    history: &[AiMessage],
    current_user: &str,
) -> Result<AssembledAiContext, AiContextError> {
    assemble_context_inner(
        custom_instructions,
        memories,
        focused_task,
        history,
        Some(current_user),
    )
}

/// Build a daily context with one ephemeral server-owned user instruction.
pub fn assemble_daily_briefing_context(
    custom_instructions: &str,
    memories: &[AiMemory],
    history: &[AiMessage],
    briefing_date: &str,
    default_energy: Option<u8>,
) -> Result<AssembledAiContext, AiContextError> {
    let energy = default_energy
        .map(|value| format!(" Confirmed default energy: {value}/5."))
        .unwrap_or_default();
    let prompt = format!(
        "Prepare the Junban daily briefing for {briefing_date}. Call the read-only \
         plan_my_day tool first for that date, then summarize the priorities and propose a \
         practical plan. Do not apply or claim to apply schedule changes.{energy}"
    );
    assemble_context_inner(
        custom_instructions,
        memories,
        None,
        history,
        Some(prompt.as_str()),
    )
}

fn assemble_context_inner(
    custom_instructions: &str,
    memories: &[AiMemory],
    focused_task: Option<&Task>,
    history: &[AiMessage],
    current_user: Option<&str>,
) -> Result<AssembledAiContext, AiContextError> {
    if current_user.is_some_and(|message| message.trim().is_empty()) {
        return Err(AiContextError::EmptyMessage);
    }
    if current_user.is_some_and(|message| message.len() > junban_domain::AI_USER_INPUT_BYTES_MAX) {
        return Err(AiContextError::MessageTooLarge);
    }

    let mut required = Vec::new();
    if !custom_instructions.is_empty() {
        required.push(ChatMessage::system(format!(
            "Custom instructions:\n{custom_instructions}"
        )));
    }
    let current = current_user.map(ChatMessage::user);
    let required_bytes = required
        .iter()
        .map(message_bytes)
        .sum::<usize>()
        .saturating_add(current.as_ref().map(message_bytes).unwrap_or(0));
    if !fits(required_bytes) {
        return Err(AiContextError::RequiredContextTooLarge);
    }

    let mut bytes = required_bytes;
    let mut focused = None;
    let mut truncated = false;
    if let Some(task) = focused_task {
        let message = ChatMessage::system(format_focused_task(task));
        if try_add(&mut bytes, &message) {
            focused = Some(message);
        } else {
            truncated = true;
        }
    }

    let considered_memories = memories.len().min(AI_CONTEXT_MEMORY_ROWS_MAX);
    let mut selected_memories = Vec::new();
    for memory in memories.iter().take(AI_CONTEXT_MEMORY_ROWS_MAX) {
        let message = ChatMessage::system(format!("Explicit memory:\n{}", memory.content));
        if try_add(&mut bytes, &message) {
            selected_memories.push(message);
        } else {
            truncated = true;
            break;
        }
    }
    if memories.len() > AI_CONTEXT_MEMORY_ROWS_MAX {
        truncated = true;
    }

    let mut selected_history = Vec::new();
    for message in history
        .iter()
        .take(AI_CONTEXT_HISTORY_ROWS_MAX)
        .rev()
        .filter_map(provider_history_message)
    {
        if try_add(&mut bytes, &message) {
            selected_history.push(message);
        } else {
            truncated = true;
            break;
        }
    }
    selected_history.reverse();
    if history.len() > AI_CONTEXT_HISTORY_ROWS_MAX {
        truncated = true;
    }

    let focused_task_included = focused.is_some();
    let mut messages = required;
    if let Some(focused) = focused {
        messages.push(focused);
    }
    messages.extend(selected_memories.iter().cloned());
    messages.extend(selected_history.iter().cloned());
    if let Some(current) = current {
        messages.push(current);
    }

    Ok(AssembledAiContext {
        messages,
        metadata: AiContextMetadata {
            history_rows_loaded: history.len().min(AI_CONTEXT_HISTORY_ROWS_MAX),
            history_messages_included: selected_history.len(),
            memories_considered: considered_memories,
            memories_included: selected_memories.len(),
            focused_task_included,
            truncated,
            utf8_bytes: bytes,
            approximate_tokens: approximate_tokens(bytes),
        },
    })
}

fn provider_history_message(message: &AiMessage) -> Option<ChatMessage> {
    if !matches!(
        message.status,
        AiMessageStatus::Completed | AiMessageStatus::Cancelled | AiMessageStatus::Failed
    ) || message.content.text.is_empty()
    {
        return None;
    }
    match message.role {
        AiMessageRole::User => Some(ChatMessage::user(&message.content.text)),
        AiMessageRole::Assistant => Some(ChatMessage::assistant(&message.content.text)),
        AiMessageRole::System | AiMessageRole::Tool => None,
    }
}

fn format_focused_task(task: &Task) -> String {
    let value = serde_json::json!({
        "id": task.id.to_string(),
        "title": task.title.as_str(),
        "description": task.description.as_str(),
        "status": task.status,
        "priority": task.priority,
        "due_date": task.due_date.map(|date| date.to_string()),
        "due_time": task.due_time.as_ref(),
        "deadline": task.deadline.map(|deadline| deadline.to_string()),
        "estimated_minutes": task.estimated_minutes.map(|minutes| minutes.get()),
        "project_id": task.project_id.map(|id| id.to_string()),
        "section_id": task.section_id.map(|id| id.to_string()),
        "tag_ids": task.tag_ids.iter().map(ToString::to_string).collect::<Vec<_>>(),
    });
    format!(
        "Focused task:\n{}",
        serde_json::to_string(&value).expect("focused task context is serializable")
    )
}

fn try_add(bytes: &mut usize, message: &ChatMessage) -> bool {
    let next = bytes.saturating_add(message_bytes(message));
    if fits(next) {
        *bytes = next;
        true
    } else {
        false
    }
}

fn message_bytes(message: &ChatMessage) -> usize {
    message.content.len().saturating_add(MESSAGE_OVERHEAD_BYTES)
}

fn approximate_tokens(bytes: usize) -> usize {
    bytes.div_ceil(4)
}

fn fits(bytes: usize) -> bool {
    bytes <= AI_CONTEXT_UTF8_BYTES_MAX && approximate_tokens(bytes) <= AI_CONTEXT_TOKENS_MAX
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use junban_domain::{
        AI_MESSAGES_PER_SESSION_MAX, AiMemoryId, AiMessageContent, AiMessageId, AiSessionId,
        AiTurnId,
    };

    use super::*;

    fn message(sequence: u32, role: AiMessageRole, text: &str) -> AiMessage {
        AiMessage {
            id: AiMessageId::new(),
            session_id: AiSessionId::new(),
            turn_id: AiTurnId::new(),
            sequence,
            role,
            status: AiMessageStatus::Completed,
            content: AiMessageContent::text(text).unwrap(),
            content_bytes: text.len() as u64,
            created_at: Timestamp::now(),
            updated_at: Timestamp::now(),
        }
    }

    #[test]
    fn frozen_context_bounds_match_storage_contract() {
        assert_eq!(AI_CONTEXT_HISTORY_ROWS_MAX, 500);
        assert_eq!(AI_CONTEXT_MEMORY_ROWS_MAX, 50);
        assert_eq!(AI_CONTEXT_UTF8_BYTES_MAX, 512 * 1024);
        assert_eq!(AI_CONTEXT_TOKENS_MAX, 8_000);
        assert_eq!(
            AI_CONTEXT_HISTORY_ROWS_MAX,
            AI_MESSAGES_PER_SESSION_MAX as usize
        );
        assert_eq!(
            AI_CONTEXT_MEMORY_ROWS_MAX,
            junban_domain::AI_CONTEXT_MEMORIES_MAX as usize
        );
    }

    #[test]
    fn deterministic_history_truncation_keeps_current_and_newest_messages() {
        let history: Vec<_> = (1..=500)
            .map(|sequence| {
                message(
                    sequence,
                    AiMessageRole::User,
                    &format!("{sequence}:{}", "x".repeat(200)),
                )
            })
            .collect();
        let first = assemble_context("keep this", &[], None, &history, "current").unwrap();
        let second = assemble_context("keep this", &[], None, &history, "current").unwrap();
        assert_eq!(first.messages, second.messages);
        assert!(first.metadata.truncated);
        assert_eq!(first.messages.last().unwrap().content, "current");
        assert!(
            first
                .messages
                .iter()
                .any(|message| message.content.starts_with("500:"))
        );
        assert!(
            !first
                .messages
                .iter()
                .any(|message| message.content.starts_with("1:"))
        );
        assert!(first.metadata.utf8_bytes <= AI_CONTEXT_UTF8_BYTES_MAX);
        assert!(first.metadata.approximate_tokens <= AI_CONTEXT_TOKENS_MAX);
    }

    #[test]
    fn daily_briefing_uses_one_ephemeral_server_user_instruction() {
        let context = assemble_daily_briefing_context(
            "Keep custom guidance.",
            &[],
            &[message(1, AiMessageRole::Assistant, "prior")],
            "2026-08-04",
            Some(4),
        )
        .unwrap();
        let user_messages: Vec<_> = context
            .messages
            .iter()
            .filter(|message| message.role == junban_ai::ChatRole::User)
            .collect();
        assert_eq!(user_messages.len(), 1);
        let instruction = &user_messages[0].content;
        assert!(instruction.contains("2026-08-04"));
        assert!(instruction.contains("read-only plan_my_day tool first"));
        assert!(instruction.contains("Do not apply or claim to apply"));
        assert!(instruction.contains("4/5"));
        assert!(
            context
                .messages
                .iter()
                .any(|message| message.role == junban_ai::ChatRole::System
                    && message.content.contains("Keep custom guidance."))
        );
        assert!(
            context
                .messages
                .iter()
                .any(|message| message.content == "prior")
        );
    }

    #[test]
    fn memory_cap_order_and_non_conversation_rows_are_deterministic() {
        let now = Timestamp::now();
        let memories: Vec<_> = (0..55)
            .map(|index| AiMemory::new(AiMemoryId::new(), format!("memory-{index}"), now).unwrap())
            .collect();
        let history = vec![
            message(1, AiMessageRole::System, "hidden"),
            message(2, AiMessageRole::Tool, "tool body"),
            message(3, AiMessageRole::Assistant, "public"),
        ];
        let context = assemble_context("", &memories, None, &history, "now").unwrap();
        assert_eq!(context.metadata.memories_considered, 50);
        assert_eq!(context.metadata.memories_included, 50);
        assert!(context.metadata.truncated);
        assert!(
            !context
                .messages
                .iter()
                .any(|message| message.content == "hidden")
        );
        assert!(
            !context
                .messages
                .iter()
                .any(|message| message.content == "tool body")
        );
        assert!(
            context
                .messages
                .iter()
                .any(|message| message.content == "public")
        );
    }

    #[test]
    fn empty_and_required_oversize_input_rejects() {
        assert_eq!(
            assemble_context("", &[], None, &[], "  \n").unwrap_err(),
            AiContextError::EmptyMessage
        );
        assert_eq!(
            assemble_context(
                "x".repeat(16 * 1024).as_str(),
                &[],
                None,
                &[],
                &"y".repeat(32 * 1024)
            )
            .unwrap_err(),
            AiContextError::RequiredContextTooLarge
        );
    }
}
