//! Build-only Rust 1.93 `wasm32-wasip2` consumer for the public SDK WIT.

// Regenerated with exact `wit-bindgen-cli 0.51.0`; the ordinary build compiles
// this checked-in output rather than trusting an opaque component fixture.
include!("../generated/rust_consumer.rs");

use std::io::Write;
use std::sync::atomic::{AtomicI64, Ordering};

use exports::junban::plugin::guest::Guest;
use junban::plugin::types::*;

struct Component;

static ACTIVATION_COUNT: AtomicI64 = AtomicI64::new(0);
const CALIBRATION_WORKING_SET_BYTES: usize = 48 * 1024 * 1024;

fn no_effect() -> PluginOutcome {
    PluginOutcome { effect: None }
}

#[allow(unconditional_recursion)]
#[inline(never)]
fn exhaust_stack(depth: u64) -> u64 {
    let frame = [depth; 128];
    std::hint::black_box(&frame);
    depth.wrapping_add(exhaust_stack(depth.wrapping_add(1)))
}

#[inline(never)]
fn exhaust_fuel() -> ! {
    let mut value = 1_u64;
    loop {
        for _ in 0..1_024 {
            value = value.wrapping_mul(6364136223846793005).wrapping_add(1);
        }
        std::hint::black_box(value);
    }
}

#[inline(never)]
fn spin_on_bulk_memory() -> ! {
    let mut bytes = vec![0x5a; 64 * 1024];
    loop {
        bytes.copy_within(0..32 * 1024, 32 * 1024);
        std::hint::black_box(&bytes);
    }
}

fn bounded_bulk_memory() {
    let mut bytes = vec![0x5a; 64 * 1024];
    bytes.copy_within(0..32 * 1024, 32 * 1024);
    std::hint::black_box(bytes);
}

fn exhaust_memory_growth() {
    let _ = core::arch::wasm32::memory_grow::<0>(2_048);
}

fn calibration_working_set_barrier() {
    let mut bytes = vec![0_u8; CALIBRATION_WORKING_SET_BYTES];
    for (index, page) in bytes.chunks_mut(4 * 1024).enumerate() {
        page[0] = index as u8;
    }
    let _ = junban::plugin::host_settings::get_settings();
    std::hint::black_box(bytes);
}

#[cfg(target_arch = "wasm32")]
fn raw_stderr_handle() -> i32 {
    #[link(wasm_import_module = "wasi:cli/stderr@0.2.6")]
    unsafe extern "C" {
        #[link_name = "get-stderr"]
        fn get_stderr() -> i32;
    }
    // This test-only fixture intentionally retains raw owned resource handles
    // to exhaust the host table. The exact canonical ABI comes from the
    // hash-frozen Rust WASI 0.2.6 baseline imported by this component.
    unsafe { get_stderr() }
}

fn exhaust_host_resources() {
    let mut handles = Vec::new();
    for _ in 0..=64 {
        handles.push(raw_stderr_handle());
    }
    std::hint::black_box(handles);
}

fn exhaust_stderr() {
    let mut stderr = std::io::stderr().lock();
    let block = vec![b'x'; 4 * 1024];
    for _ in 0..=8 {
        stderr.write_all(&block).unwrap();
        stderr.flush().unwrap();
    }
}

fn oversized_output() -> PluginOutcome {
    PluginOutcome {
        effect: Some(PluginEffect::KvPatch(KvPatch {
            operations: vec![KvOperation::Set(KvSet {
                key: "oversized".into(),
                value: vec![7; 300 * 1024],
            })],
        })),
    }
}

fn oversized_log_message() {
    junban::plugin::host_log::log(LogLevel::Info, &"x".repeat(4 * 1024 + 1), &[]);
}

fn too_many_log_fields() {
    let fields = (0..17)
        .map(|index| LogField {
            name: format!("field-{index}"),
            value: ScalarValue::IntegerValue(index),
        })
        .collect::<Vec<_>>();
    junban::plugin::host_log::log(LogLevel::Info, "fields", &fields);
}

fn exhaust_log_total() {
    let message = "x".repeat(4 * 1024);
    for _ in 0..16 {
        junban::plugin::host_log::log(LogLevel::Info, &message, &[]);
    }
}

/// Exact `TaskDraft::new` defaults before parent/domain validation.
fn new_task_draft(title: String) -> TaskDraft {
    TaskDraft {
        title,
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

/// Keep all named unchanged/clear/set and bulk clear/set representations live.
fn exercise_change_variants() {
    let due = LocalDueTime {
        time: "09:30:00".into(),
        time_zone: "Europe/London".into(),
    };
    let _ = [StringChange::Unchanged, StringChange::Set(String::new())];
    let _ = [BoolChange::Unchanged, BoolChange::Set(false)];
    let _ = [S64Change::Unchanged, S64Change::Set(0)];
    let _ = [
        ProjectViewChange::Unchanged,
        ProjectViewChange::Set(ProjectView::Calendar),
    ];
    let _ = [
        OptionalStringChange::Unchanged,
        OptionalStringChange::Clear,
        OptionalStringChange::Set(String::new()),
    ];
    let _ = [
        OptionalIdChange::Unchanged,
        OptionalIdChange::Clear,
        OptionalIdChange::Set("id".into()),
    ];
    let _ = [
        OptionalDateChange::Unchanged,
        OptionalDateChange::Clear,
        OptionalDateChange::Set("2026-08-04".into()),
    ];
    let _ = [
        OptionalTimestampChange::Unchanged,
        OptionalTimestampChange::Clear,
        OptionalTimestampChange::Set("2026-08-04T00:00:00Z".into()),
    ];
    let _ = [
        OptionalLocalDueTimeChange::Unchanged,
        OptionalLocalDueTimeChange::Clear,
        OptionalLocalDueTimeChange::Set(due),
    ];
    let _ = [
        OptionalU32Change::Unchanged,
        OptionalU32Change::Clear,
        OptionalU32Change::Set(1),
    ];
    let _ = [
        OptionalU8Change::Unchanged,
        OptionalU8Change::Clear,
        OptionalU8Change::Set(1),
    ];
    let _ = [
        OptionalPriorityChange::Unchanged,
        OptionalPriorityChange::Clear,
        OptionalPriorityChange::Set(Priority::P1),
    ];
    let _ = [IdListChange::Unchanged, IdListChange::Replace(Vec::new())];
    let _ = [BulkPriority::Clear, BulkPriority::Set(Priority::P4)];
    let _ = [ProjectView::List, ProjectView::Board, ProjectView::Calendar];
    let _ = [Priority::P1, Priority::P2, Priority::P3, Priority::P4];
    let _ = new_task_draft("task".into());
}

impl Guest for Component {
    fn activate(_context: InvocationContext) -> Result<(), PluginError> {
        exercise_change_variants();
        ACTIVATION_COUNT.fetch_add(1, Ordering::Relaxed);
        let _ = junban::plugin::host_settings::get_settings();
        let _ = junban::plugin::host_storage::get_kv(&[]);
        let _ = junban::plugin::host_storage::list_kv(None, 1);
        junban::plugin::host_log::log(LogLevel::Debug, "consumer", &[]);
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
            "trap" => panic!("retained hostile trap marker"),
            "spin" => spin_on_bulk_memory(),
            "fuel" => exhaust_fuel(),
            "bulk-memory" => bounded_bulk_memory(),
            "memory-grow" => exhaust_memory_growth(),
            "memory-calibration-barrier" => {
                calibration_working_set_barrier();
                return Ok(no_effect());
            }
            "host-resources" => exhaust_host_resources(),
            "stack" => {
                std::hint::black_box(exhaust_stack(0));
            }
            "oversized-output" => return Ok(oversized_output()),
            "log-message" => oversized_log_message(),
            "log-fields" => too_many_log_fields(),
            "log-total" => exhaust_log_total(),
            "stderr" => exhaust_stderr(),
            _ => {}
        }
        let _ = junban::plugin::host_tasks::query_tasks(&TaskQuery {
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
            limit: 1,
        });
        Ok(no_effect())
    }
    fn handle_event(
        _context: InvocationContext,
        event: EventEnvelope,
    ) -> Result<PluginOutcome, PluginError> {
        if event.event_epoch == "spin" {
            spin_on_bulk_memory();
        }
        Ok(no_effect())
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
                content: UiContent::Stack(LayoutProps {
                    gap: 0,
                    align: UiAlign::Start,
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
                    ACTIVATION_COUNT.load(Ordering::Relaxed),
                )),
            }],
        })
    }
}

export!(Component);
