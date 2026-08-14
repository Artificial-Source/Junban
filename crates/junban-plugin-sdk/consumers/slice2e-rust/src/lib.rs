//! Non-shipped Phase 7 Slice 2E production-composition fixture.

wit_bindgen::generate!({
    path: "wit",
    world: "slice2e-consumer",
    generate_all,
    generate_unused_types: true,
});

use std::sync::atomic::{AtomicI64, Ordering};

use exports::junban::plugin::guest::Guest;
use junban::plugin::types::*;

struct Component;

static ACTIVATIONS: AtomicI64 = AtomicI64::new(0);
static RESYNC_STEPS: AtomicI64 = AtomicI64::new(0);
static EVENTS: AtomicI64 = AtomicI64::new(0);
static DIRTY: AtomicI64 = AtomicI64::new(0);

fn no_effect() -> PluginOutcome {
    PluginOutcome { effect: None }
}

fn plugin_error(message: &str) -> PluginError {
    PluginError {
        code: ErrorCode::InvalidInput,
        field: Some("command-id".into()),
        message: message.into(),
    }
}

fn task_query() -> TaskQuery {
    TaskQuery {
        task_id: None,
        project_id: None,
        section_id: None,
        parent_id: None,
        tag_ids: Vec::new(),
        statuses: Vec::new(),
        priorities: Vec::new(),
        due_from: None,
        due_before: None,
        search: None,
        cursor: None,
        limit: 20,
    }
}

fn string_argument<'a>(call: &'a CommandCall, name: &str) -> Result<&'a str, PluginError> {
    call.values
        .iter()
        .find_map(|value| {
            if value.name == name
                && let DataValue::Scalar(ScalarValue::StringValue(value)) = &value.value
            {
                Some(value.as_str())
            } else {
                None
            }
        })
        .ok_or_else(|| plugin_error("missing string argument"))
}

fn kv_effect(key: &str, value: Vec<u8>) -> PluginOutcome {
    PluginOutcome {
        effect: Some(PluginEffect::KvPatch(KvPatch {
            operations: vec![KvOperation::Set(KvSet {
                key: key.into(),
                value,
            })],
        })),
    }
}

fn task_draft(title: &str) -> TaskDraft {
    TaskDraft {
        title: title.into(),
        description: String::new(),
        priority: None,
        due_date: None,
        due_time: None,
        deadline: None,
        someday: false,
        estimated_minutes: None,
        actual_minutes: None,
        dread: None,
        project_id: None,
        section_id: None,
        parent_id: None,
        tag_ids: Vec::new(),
        sort_order: 0,
        recurrence_rule: None,
        remind_at: None,
        recurrence_anchor_day: None,
    }
}

fn state_bytes() -> Vec<u8> {
    format!(
        "activations={};resync={};events={};dirty={}",
        ACTIVATIONS.load(Ordering::Relaxed),
        RESYNC_STEPS.load(Ordering::Relaxed),
        EVENTS.load(Ordering::Relaxed),
        DIRTY.load(Ordering::Relaxed),
    )
    .into_bytes()
}

fn exhaust_memory() {
    let _ = core::arch::wasm32::memory_grow::<0>(2_048);
}

#[inline(never)]
fn spin_on_bulk_memory() -> ! {
    let mut bytes = vec![0x5a; 64 * 1024];
    loop {
        bytes.copy_within(0..32 * 1024, 32 * 1024);
        std::hint::black_box(&bytes);
    }
}

impl Guest for Component {
    fn activate(_context: InvocationContext) -> Result<(), PluginError> {
        ACTIVATIONS.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn deactivate(_context: InvocationContext) -> Result<(), PluginError> {
        Ok(())
    }

    fn invoke_command(
        _context: InvocationContext,
        call: CommandCall,
    ) -> Result<PluginOutcome, PluginError> {
        match call.command_id.as_str() {
            "block" => {
                DIRTY.store(1, Ordering::Relaxed);
                junban::plugin::host_tasks::query_tasks(&task_query())
                    .map_err(|_| plugin_error("blocked query failed"))?;
                Ok(kv_effect("blocked-effect", b"must-not-commit".to_vec()))
            }
            "callback-error" => match junban::plugin::host_tasks::query_tasks(&task_query()) {
                Ok(_) => Err(plugin_error("callback unexpectedly succeeded")),
                Err(_) => Err(plugin_error("callback failed closed")),
            },
            "domain-effect" => Ok(PluginOutcome {
                effect: Some(PluginEffect::DomainMutation(DomainMutation::CreateTask(
                    task_draft("slice2e-domain-effect"),
                ))),
            }),
            "http" => {
                let origin = string_argument(&call, "origin")?;
                let request = HttpRequest {
                    method: HttpMethod::Post,
                    origin: origin.into(),
                    path_and_query: "/slice2e?delivery=once".into(),
                    headers: Vec::new(),
                    body: b"slice2e".to_vec(),
                };
                let response = junban::plugin::host_http::request(&request)
                    .map_err(|_| plugin_error("loopback request failed"))?;
                if response.status != 200 || response.body != b"accepted" {
                    return Err(plugin_error("unexpected loopback response"));
                }
                if junban::plugin::host_http::request(&request).is_ok() {
                    return Err(plugin_error("HTTP consume-once authority was reusable"));
                }
                Ok(no_effect())
            }
            "kv-effect" => Ok(kv_effect("returned-kv", b"component-value".to_vec())),
            "memory-grow" => {
                exhaust_memory();
                Ok(no_effect())
            }
            "nested" => {
                let target = string_argument(&call, "target")?;
                let data = junban::plugin::host_services::call_service(&ServiceCall {
                    plugin_id: target.into(),
                    service_id: "state".into(),
                    values: Vec::new(),
                })
                .map_err(|_| plugin_error("nested service failed"))?;
                let activation = data
                    .values
                    .iter()
                    .find_map(|value| match (value.name.as_str(), &value.value) {
                        (
                            "activation-count",
                            DataValue::Scalar(ScalarValue::IntegerValue(value)),
                        ) => Some(*value),
                        _ => None,
                    })
                    .ok_or_else(|| plugin_error("nested service shape mismatch"))?;
                Ok(kv_effect(
                    "nested-service",
                    activation.to_string().into_bytes(),
                ))
            }
            "ordinary" => {
                let tasks = junban::plugin::host_tasks::query_tasks(&task_query())
                    .map_err(|_| plugin_error("ordinary task query failed"))?;
                if tasks.items.is_empty() {
                    return Err(plugin_error("ordinary task query was empty"));
                }
                let settings = junban::plugin::host_settings::get_settings()
                    .map_err(|_| plugin_error("ordinary settings query failed"))?;
                if !settings.iter().any(|setting| {
                    setting.id == "mode"
                        && matches!(&setting.value, SettingValue::Text(value) if value == "conformance")
                }) {
                    return Err(plugin_error("typed setting did not cross the callback"));
                }
                let entries = junban::plugin::host_storage::get_kv(&["returned-kv".into()])
                    .map_err(|_| plugin_error("ordinary KV get failed"))?;
                if !entries
                    .iter()
                    .any(|entry| entry.key == "returned-kv" && entry.value == b"component-value")
                {
                    return Err(plugin_error("durable KV did not cross the callback"));
                }
                let listed = junban::plugin::host_storage::list_kv(None, 10)
                    .map_err(|_| plugin_error("ordinary KV list failed"))?;
                if listed.entries.is_empty() {
                    return Err(plugin_error("ordinary KV list was empty"));
                }
                Ok(no_effect())
            }
            "oversized-output" => Ok(kv_effect("oversized", vec![7; 300 * 1024])),
            "ping" => Ok(no_effect()),
            "state" => Ok(kv_effect("component-state", state_bytes())),
            "trap" => {
                DIRTY.store(2, Ordering::Relaxed);
                panic!("slice2e trap marker")
            }
            _ => Err(plugin_error("unknown command")),
        }
    }

    fn handle_event(
        context: InvocationContext,
        event: EventEnvelope,
    ) -> Result<PluginOutcome, PluginError> {
        if matches!(
            &event.subject,
            EventSubject::Task(task) if task.title == "slice2e-event-trap"
        ) {
            panic!("slice2e retained event trap marker");
        }
        if context.plugin_id == "fault-00"
            && matches!(
                &event.subject,
                EventSubject::Task(task) if task.title == "slice2e-event-timeout"
            )
        {
            DIRTY.store(3, Ordering::Relaxed);
            spin_on_bulk_memory();
        }
        let count = EVENTS.fetch_add(1, Ordering::Relaxed) + 1;
        Ok(kv_effect("event-count", count.to_string().into_bytes()))
    }

    fn render_surface(
        _context: InvocationContext,
        request: SurfaceRequest,
    ) -> Result<Surface, PluginError> {
        Ok(Surface {
            surface_id: request.surface_id,
            root_index: 0,
            nodes: vec![UiNode {
                id: "root".into(),
                parent_index: None,
                content: UiContent::EmptyState(TextProps {
                    text: "Slice 2E".into(),
                    tone: UiTone::Neutral,
                    size: UiSize::Medium,
                }),
            }],
        })
    }

    fn handle_surface_action(
        _context: InvocationContext,
        _action: SurfaceAction,
    ) -> Result<PluginOutcome, PluginError> {
        Ok(no_effect())
    }

    fn validate_settings(
        _context: InvocationContext,
        _values: SettingValues,
    ) -> Result<Vec<ValidationIssue>, PluginError> {
        Ok(Vec::new())
    }

    fn resync(
        _context: InvocationContext,
        page: ResyncPage,
    ) -> Result<ResyncPageOutcome, PluginError> {
        RESYNC_STEPS.fetch_add(1, Ordering::Relaxed);
        Ok(match page {
            ResyncPage::Snapshot(page) => ResyncPageOutcome::SnapshotAck(SnapshotAck {
                session_id: page.session_id,
                page_index: page.page_index,
                kind: page.kind,
                segment: None,
            }),
            ResyncPage::FlushStagedKv(page) => ResyncPageOutcome::FlushAck(FlushAck {
                session_id: page.session_id,
                request_index: page.request_index,
                segment: None,
                state: FlushState::Complete,
            }),
            ResyncPage::Finalize(page) => ResyncPageOutcome::Finalized(FinalizedResync {
                session_id: page.session_id,
                choice: FinalKvChoice::LeaveKv,
            }),
        })
    }

    fn call_service(
        _context: InvocationContext,
        _call: ServiceCall,
    ) -> Result<ServiceData, PluginError> {
        Ok(ServiceData {
            values: vec![NamedValue {
                name: "activation-count".into(),
                value: DataValue::Scalar(ScalarValue::IntegerValue(
                    ACTIVATIONS.load(Ordering::Relaxed),
                )),
            }],
        })
    }
}

export!(Component);
