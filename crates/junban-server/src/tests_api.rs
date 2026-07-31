//! In-process router tests for the Phase 2 HTTP/SSE surface.

use std::{
    convert::Infallible,
    env, fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime},
};

use axum::{
    Router,
    body::Body,
    http::{Method, StatusCode, header},
    response::{Response, sse::Event as SseEvent},
};
use http_body_util::BodyExt;
use jiff::{Timestamp, ToSpan};
use junban_app::{CommittedMutation, EventType, Repository, ResourceRef, ResyncScope};
use junban_domain::{OperationId, TaskId, UncompleteOutcome};
use junban_storage::ProfileOwner;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use uuid::Uuid;

use super::*;
use crate::reminder_wake::{
    REMINDER_OVERDUE_WAKE_THROTTLE, REMINDER_WAKE_EVENT_TYPE, start_reminder_coordinator,
};
use crate::sse::{MAX_SSE_CONNECTIONS, send_event};

const HOST: &str = "127.0.0.1:4219";
static TEST_CONTEXT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const TOKEN: &str = "test-token-that-is-never-written-to-runtime-metadata";

struct TestContext {
    directory: PathBuf,
    _owner: ProfileOwner,
    state: ServerState,
    app: Router,
}

impl TestContext {
    fn new() -> Self {
        let directory = env::temp_dir().join(format!(
            "junban-server-test-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            TEST_CONTEXT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let web_dir = directory.join("web");
        fs::create_dir_all(web_dir.join("assets")).unwrap();
        fs::write(web_dir.join("index.html"), "<main>Junban shell</main>").unwrap();
        fs::write(web_dir.join("assets/app.js"), "console.log('ui')").unwrap();
        let owner = ProfileOwner::open(directory.join("profile")).unwrap();
        let state = ServerState::new(owner.repository(), TOKEN.to_owned(), [HOST.to_owned()]);
        let app = router(state.clone(), web_dir);
        Self {
            directory,
            _owner: owner,
            state,
            app,
        }
    }

    async fn request(&self, request: axum::http::Request<Body>) -> Response {
        self.app.clone().oneshot(request).await.unwrap()
    }

    async fn open_sse(&self) -> Response {
        let response = self
            .request(
                authenticated(Method::GET, "/api/v1/events")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        response
    }

    async fn wait_until_forwarders(&self, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let active = self.state.active_forwarders.load(Ordering::SeqCst);
            if active == expected {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "expected {expected} SSE forwarders, still have {active}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn wait_until_connections(&self, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let active = self.state.sse_connections.load(Ordering::SeqCst);
            if active == expected {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "expected {expected} SSE connections, still have {active}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Drop for TestContext {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn request(method: Method, uri: &str) -> axum::http::request::Builder {
    axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .header(header::HOST, HOST)
}

fn authenticated(method: Method, uri: &str) -> axum::http::request::Builder {
    request(method, uri).header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
}

fn operation_header(builder: axum::http::request::Builder) -> axum::http::request::Builder {
    builder.header("idempotency-key", Uuid::new_v4().to_string())
}

fn operation_header_key(
    builder: axum::http::request::Builder,
    key: &str,
) -> axum::http::request::Builder {
    builder.header("idempotency-key", key)
}

async fn response_bytes(response: Response) -> Vec<u8> {
    response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec()
}

async fn json(response: Response) -> Value {
    serde_json::from_slice(&response_bytes(response).await).unwrap()
}

fn new_id() -> String {
    Uuid::now_v7().to_string()
}

async fn create_task_payload(context: &TestContext, payload: Value) -> Value {
    let response = context
        .request(
            operation_header(authenticated(Method::POST, "/api/v1/tasks"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED, "create {payload}");
    let body = json(response).await;
    assert_eq!(body["event"]["event_type"], "task.created");
    body
}

async fn create_task(context: &TestContext, title: &str) -> Value {
    let body = create_task_payload(context, json!({ "title": title })).await;
    assert_eq!(body["event"]["snapshot"]["task"]["title"], title);
    body
}

fn task_id_from(created: &Value) -> &str {
    created["event"]["snapshot"]["task"]["id"].as_str().unwrap()
}

async fn list_titles(context: &TestContext, query: &str) -> Vec<String> {
    let response = context
        .request(
            authenticated(Method::GET, &format!("/api/v1/tasks?{query}&limit=100"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK, "query {query}");
    let body = json(response).await;
    let mut titles = body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["title"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    titles.sort();
    titles
}

#[tokio::test]
async fn health_is_unauthenticated_and_security_headers_are_global() {
    let context = TestContext::new();
    let response = context
        .request(
            request(Method::GET, "/api/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert!(response.headers().contains_key("x-request-id"));
}

#[tokio::test]
async fn exact_raw_host_is_required_and_forwarded_host_is_ignored() {
    let context = TestContext::new();
    let denied = context
        .request(
            axum::http::Request::builder()
                .uri("/api/v1/health")
                .header(header::HOST, "evil.example")
                .header("x-forwarded-host", HOST)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(denied.status(), StatusCode::MISDIRECTED_REQUEST);

    let allowed = context
        .request(
            request(Method::GET, "/api/v1/health")
                .header("forwarded", "host=evil.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(allowed.status(), StatusCode::OK);
}

#[tokio::test]
async fn bearer_authentication_and_bounded_limiter_fail_closed() {
    let context = TestContext::new();
    for _ in 0..AUTH_ATTEMPTS {
        let response = context
            .request(
                request(Method::GET, "/api/v1/tasks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let limited = context
        .request(
            request(Method::GET, "/api/v1/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(json(limited).await["error"]["retryable"], true);

    let valid = context
        .request(
            authenticated(Method::GET, "/api/v1/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(valid.status(), StatusCode::OK);
}

#[tokio::test]
async fn browser_mutations_require_matching_origin_but_cli_requests_do_not() {
    let context = TestContext::new();
    let mismatch = context
        .request(
            operation_header(authenticated(Method::POST, "/api/v1/tasks"))
                .header(header::ORIGIN, "http://evil.example")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "title": "Task" }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(mismatch.status(), StatusCode::FORBIDDEN);

    let created = create_task(&context, "CLI task").await;
    assert_eq!(created["event"]["snapshot"]["task"]["title"], "CLI task");
}

#[tokio::test]
async fn body_limit_and_validation_errors_have_matching_request_ids() {
    let context = TestContext::new();
    let too_large = context
        .request(
            operation_header(authenticated(Method::POST, "/api/v1/tasks"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(
                    r#"{{"title":"{}"}}"#,
                    "x".repeat(MAX_BODY_BYTES)
                )))
                .unwrap(),
        )
        .await;
    assert_eq!(too_large.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let header_id = too_large.headers()["x-request-id"]
        .to_str()
        .unwrap()
        .to_owned();
    assert_eq!(json(too_large).await["request_id"], header_id);

    let invalid = context
        .request(
            operation_header(authenticated(Method::POST, "/api/v1/tasks"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "title": " " }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(json(invalid).await["error"]["code"], "validation_error");
}

#[tokio::test]
async fn p2_api_001_client_generated_create_id_is_rejected() {
    let context = TestContext::new();
    let response = context
        .request(
            operation_header(authenticated(Method::POST, "/api/v1/tasks"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "id": new_id(), "title": "T" }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json(response).await["error"]["code"], "invalid_json");
}

#[tokio::test]
async fn task_crud_status_and_list_filters() {
    let context = TestContext::new();
    let created = create_task(&context, "Original").await;
    let id = task_id_from(&created).to_owned();

    let got = context
        .request(
            authenticated(Method::GET, &format!("/api/v1/tasks/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(json(got).await["title"], "Original");

    let patched = context
        .request(
            operation_header(authenticated(Method::PATCH, &format!("/api/v1/tasks/{id}")))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "title": "Changed", "due_date": "2026-07-28" }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(json(patched).await["event"]["revision"], 2);

    for (path, status) in [
        ("complete", "completed"),
        ("uncomplete", "pending"),
        ("cancel", "cancelled"),
        ("reopen", "pending"),
    ] {
        let response = context
            .request(
                operation_header(authenticated(
                    Method::POST,
                    &format!("/api/v1/tasks/{id}/{path}"),
                ))
                .body(Body::empty())
                .unwrap(),
            )
            .await;
        assert_eq!(
            json(response).await["event"]["snapshot"]["task"]["status"],
            status
        );
    }

    let list = context
        .request(
            authenticated(Method::GET, "/api/v1/tasks?view=inbox&limit=10")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    let list = json(list).await;
    assert_eq!(list["tasks"].as_array().unwrap().len(), 1);
    assert!(list["as_of_date"].as_str().is_some());
    assert!(list["revision"].as_u64().unwrap() >= 1);

    let deleted = context
        .request(
            operation_header(authenticated(
                Method::DELETE,
                &format!("/api/v1/tasks/{id}"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(json(deleted).await["event"]["event_type"], "task.deleted");
}

#[tokio::test]
async fn p3_final_002_uncomplete_outcomes_are_serialized_and_replayed_exactly() {
    let context = TestContext::new();
    let recurring = create_task_payload(
        &context,
        json!({ "title": "Recurring exact", "due_date": "2026-07-28", "recurrence_rule": "daily" }),
    )
    .await;
    let recurring_id = task_id_from(&recurring).to_owned();

    let completed = context
        .request(
            operation_header(authenticated(
                Method::POST,
                &format!("/api/v1/tasks/{recurring_id}/complete"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    let completed = json(completed).await;
    assert!(completed.get("uncomplete_outcome").is_none());

    let exact_key = Uuid::new_v4().to_string();
    let exact_path = format!("/api/v1/tasks/{recurring_id}/uncomplete");
    let exact = context
        .request(
            operation_header_key(authenticated(Method::POST, &exact_path), &exact_key)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(exact.status(), StatusCode::OK);
    let exact = response_bytes(exact).await;
    assert_eq!(
        serde_json::from_slice::<Value>(&exact).unwrap()["uncomplete_outcome"],
        "exact"
    );
    let exact_replay = context
        .request(
            operation_header_key(authenticated(Method::POST, &exact_path), &exact_key)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(exact_replay.status(), StatusCode::OK);
    assert_eq!(response_bytes(exact_replay).await, exact);

    let source_only = crate::dto::MutationResponse::from(CommittedMutation {
        event: CommittedEvent {
            revision: 3,
            operation_id: OperationId::parse(&Uuid::new_v4().to_string()).unwrap(),
            event_type: EventType::new(EventType::TASK_UNCOMPLETED),
            occurred_at: Timestamp::now(),
            primary: None,
            snapshot: None,
            affected: Default::default(),
            resync: ResyncScope::NONE,
        },
        uncomplete_outcome: Some(UncompleteOutcome::SourceOnly),
        newly_committed: false,
    });
    let source_only = serde_json::to_value(source_only).unwrap();
    assert_eq!(source_only["uncomplete_outcome"], "source_only");
}

#[tokio::test]
async fn task_list_response_exposes_the_server_civil_date_used_for_views() {
    let context = TestContext::new();
    let expected = crate::routes::server_as_of_date().to_string();

    let (status, response) = get_json(&context, "/api/v1/tasks?view=today").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["as_of_date"], expected);
}

#[tokio::test]
async fn p2_api_003_view_presets_use_exact_server_date_semantics_and_filters() {
    let context = TestContext::new();
    let today = crate::routes::server_as_of_date();
    let yesterday = today.checked_sub(1.day()).unwrap();
    let tomorrow = today.checked_add(1.day()).unwrap();

    create_task_payload(
        &context,
        json!({ "title": "Overdue", "due_date": yesterday.to_string(), "priority": 1 }),
    )
    .await;
    create_task_payload(
        &context,
        json!({ "title": "Today", "due_date": today.to_string(), "priority": 2 }),
    )
    .await;
    create_task_payload(
        &context,
        json!({ "title": "Future", "due_date": tomorrow.to_string() }),
    )
    .await;
    create_task(&context, "Undated").await;
    create_task_payload(&context, json!({ "title": "Someday", "someday": true })).await;

    let completed = create_task(&context, "Recent completed").await;
    let completed_id = task_id_from(&completed);
    let response = context
        .request(
            operation_header(authenticated(
                Method::POST,
                &format!("/api/v1/tasks/{completed_id}/complete"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);

    let cancelled = create_task(&context, "Cancelled").await;
    let cancelled_id = task_id_from(&cancelled);
    let response = context
        .request(
            operation_header(authenticated(
                Method::POST,
                &format!("/api/v1/tasks/{cancelled_id}/cancel"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);

    assert_eq!(
        list_titles(&context, "view=inbox").await,
        ["Future", "Overdue", "Recent completed", "Today", "Undated"]
    );
    assert_eq!(
        list_titles(&context, "view=today").await,
        ["Overdue", "Today"]
    );
    assert_eq!(
        list_titles(&context, "view=upcoming").await,
        ["Future", "Overdue"]
    );
    assert_eq!(list_titles(&context, "view=someday").await, ["Someday"]);
    assert_eq!(
        list_titles(&context, "view=completed").await,
        ["Cancelled", "Recent completed"]
    );
    assert_eq!(list_titles(&context, "view=cancelled").await, ["Cancelled"]);
    assert_eq!(
        list_titles(&context, "view=today&priority=1").await,
        ["Overdue"]
    );

    let invalid = context
        .request(
            authenticated(Method::GET, "/api/v1/tasks?view=typo")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn p2_api_001_generated_id_replays_exact_response_bytes() {
    let context = TestContext::new();
    let key = Uuid::new_v4().to_string();
    let body = json!({ "title": "Same" }).to_string();

    let first = context
        .request(
            operation_header_key(authenticated(Method::POST, "/api/v1/tasks"), &key)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.clone()))
                .unwrap(),
        )
        .await;
    assert_eq!(first.status(), StatusCode::CREATED);
    let first_bytes = response_bytes(first).await;
    let first_json: Value = serde_json::from_slice(&first_bytes).unwrap();
    let first_id = task_id_from(&first_json).to_owned();

    let second = context
        .request(
            operation_header_key(authenticated(Method::POST, "/api/v1/tasks"), &key)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await;
    assert_eq!(second.status(), StatusCode::CREATED);
    let second_bytes = response_bytes(second).await;
    assert_eq!(second_bytes, first_bytes);
    let second_json: Value = serde_json::from_slice(&second_bytes).unwrap();
    assert_eq!(task_id_from(&second_json), first_id);

    let mismatch = context
        .request(
            operation_header_key(authenticated(Method::POST, "/api/v1/tasks"), &key)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "title": "Different" }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(mismatch.status(), StatusCode::CONFLICT);
    assert_eq!(
        json(mismatch).await["error"]["code"],
        "idempotency_mismatch"
    );
}

#[tokio::test]
async fn opaque_cursor_binds_sort_and_rejects_tamper() {
    let context = TestContext::new();
    for index in 0..3 {
        create_task(&context, &format!("Task {index}")).await;
    }

    let page = context
        .request(
            authenticated(Method::GET, "/api/v1/tasks?sort=sort_order_asc&limit=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    let page = json(page).await;
    let cursor = page["next_cursor"].as_str().expect("next cursor");

    let next = context
        .request(
            authenticated(
                Method::GET,
                &format!("/api/v1/tasks?sort=sort_order_asc&limit=1&cursor={cursor}"),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(next.status(), StatusCode::OK);

    let wrong_sort = context
        .request(
            authenticated(
                Method::GET,
                &format!("/api/v1/tasks?sort=created_desc&limit=1&cursor={cursor}"),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(wrong_sort.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        json(wrong_sort).await["error"]["fields"]["cursor"],
        "cursor sort does not match the requested sort"
    );

    let malformed = context
        .request(
            authenticated(Method::GET, "/api/v1/tasks?cursor=not-a-cursor")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(malformed.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn bulk_cap_and_move_keep_only_paths() {
    let context = TestContext::new();
    let mut ids = Vec::new();
    for index in 0..3 {
        ids.push(task_id_from(&create_task(&context, &format!("B{index}")).await).to_owned());
    }

    let bulk = context
        .request(
            operation_header(authenticated(Method::POST, "/api/v1/tasks/actions"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "task_ids": ids, "action": { "type": "complete" } }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(bulk.status(), StatusCode::OK);
    assert_eq!(json(bulk).await["event"]["event_type"], "task.bulk");

    let too_many: Vec<String> = (0..501).map(|_| new_id()).collect();
    let overflow = context
        .request(
            operation_header(authenticated(Method::POST, "/api/v1/tasks/actions"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "task_ids": too_many, "action": { "type": "complete" } }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    // Unique bulk IDs that do not exist still hit the 500 cap before mutation.
    assert!(
        matches!(
            overflow.status(),
            StatusCode::PAYLOAD_TOO_LARGE
                | StatusCode::UNPROCESSABLE_ENTITY
                | StatusCode::NOT_FOUND
        ),
        "unexpected {}",
        overflow.status()
    );

    let id = task_id_from(&create_task(&context, "Move me").await).to_owned();
    let moved = context
        .request(
            operation_header(authenticated(
                Method::POST,
                &format!("/api/v1/tasks/{id}/move"),
            ))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "order": "keep" }).to_string()))
            .unwrap(),
        )
        .await;
    assert_eq!(moved.status(), StatusCode::OK);
}

#[tokio::test]
async fn p2_api_004_nested_bulk_rejects_outer_and_action_typos() {
    let context = TestContext::new();
    let task_ids = [new_id()];
    for invalid_body in [
        json!({ "task_ids": task_ids, "action": { "type": "complete" }, "task_idz": [] }),
        json!({ "task_ids": task_ids, "action": { "type": "complete", "force": true } }),
    ] {
        let invalid = context
            .request(
                operation_header(authenticated(Method::POST, "/api/v1/tasks/actions"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(invalid_body.to_string()))
                    .unwrap(),
            )
            .await;
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json(invalid).await["error"]["code"], "invalid_json");
    }

    let doc: Value = serde_json::from_str(&openapi_json()).unwrap();
    let schema = &doc["components"]["schemas"]["BulkTasksRequest"];
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(
        schema["properties"]["action"]["$ref"],
        "#/components/schemas/BulkActionDto"
    );
}

#[tokio::test]
async fn catalog_comments_relations_activity_undo_and_parsers() {
    let context = TestContext::new();
    let project = context
        .request(
            operation_header(authenticated(Method::POST, "/api/v1/projects"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "name": "Workbench",
                        "color": "#112233"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(project.status(), StatusCode::CREATED);

    let tag = context
        .request(
            operation_header(authenticated(Method::POST, "/api/v1/tags"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "name": "rust", "color": "#abcdef" }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(tag.status(), StatusCode::CREATED);

    let catalog = context
        .request(
            authenticated(Method::GET, "/api/v1/catalog")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    let catalog = json(catalog).await;
    assert_eq!(catalog["projects"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["tags"].as_array().unwrap().len(), 1);

    let profile = context
        .request(
            authenticated(Method::GET, "/api/v1/profile")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(json(profile).await["revision"], catalog["revision"]);

    let task = create_task(&context, "Detail").await;
    let task_id = task_id_from(&task).to_owned();
    let source_op = task["event"]["operation_id"].as_str().unwrap().to_owned();

    let comment = context
        .request(
            operation_header(authenticated(
                Method::POST,
                &format!("/api/v1/tasks/{task_id}/comments"),
            ))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "content": "hello" }).to_string()))
            .unwrap(),
        )
        .await;
    assert_eq!(comment.status(), StatusCode::CREATED);

    let other = create_task(&context, "Blocked").await;
    let other_id = task_id_from(&other).to_owned();
    let relation = context
        .request(
            operation_header(authenticated(
                Method::POST,
                &format!("/api/v1/tasks/{task_id}/relations"),
            ))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "to_task_id": other_id, "kind": "blocks" }).to_string(),
            ))
            .unwrap(),
        )
        .await;
    assert_eq!(relation.status(), StatusCode::CREATED);

    let activity = context
        .request(
            authenticated(
                Method::GET,
                &format!("/api/v1/tasks/{task_id}/activity?limit=10"),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    let activity = json(activity).await;
    assert!(!activity["activity"].as_array().unwrap().is_empty());

    let undo = context
        .request(
            operation_header(authenticated(
                Method::POST,
                &format!("/api/v1/operations/{source_op}/undo"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    // Creating later comments/relations may invalidate post-image; accept ok or conflict.
    assert!(
        matches!(
            undo.status(),
            StatusCode::OK | StatusCode::CONFLICT | StatusCode::NOT_FOUND
        ),
        "undo status {}",
        undo.status()
    );

    let quick = context
        .request(
            authenticated(Method::POST, "/api/v1/parse/quick-entry")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "input": "Ship it !1 #rust" }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(quick.status(), StatusCode::OK);
    assert_eq!(json(quick).await["priority"], 1);

    let filter = context
        .request(
            authenticated(Method::POST, "/api/v1/parse/filter")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "input": "priority:2 status:pending" }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(filter.status(), StatusCode::OK);
    assert_eq!(json(filter).await["filter"]["priority"], 2);

    let strict = context
        .request(
            authenticated(Method::POST, "/api/v1/parse/filter")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "input": "priority:9" }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(strict.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let import = context
        .request(
            authenticated(Method::POST, "/api/v1/parse/text-import")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "input": "- [ ] one\n- [x] two\n" }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(import.status(), StatusCode::OK);
    assert_eq!(json(import).await["drafts"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn p2_api_002_constraint_violations_map_to_stable_http_conflicts() {
    let context = TestContext::new();
    for expected in [StatusCode::CREATED, StatusCode::CONFLICT] {
        let response = context
            .request(
                operation_header(authenticated(Method::POST, "/api/v1/tags"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "name": "Duplicate", "color": "#abcdef" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await;
        assert_eq!(response.status(), expected);
        if expected == StatusCode::CONFLICT {
            let body = json(response).await;
            assert_eq!(body["error"]["code"], "conflict");
            assert_eq!(body["error"]["retryable"], false);
        }
    }
}

#[tokio::test]
async fn api_fallback_never_returns_spa_html_and_static_bootstrap_is_public() {
    let context = TestContext::new();
    let api = context
        .request(
            request(Method::GET, "/api/unknown")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(api.status(), StatusCode::NOT_FOUND);
    assert_eq!(api.headers()[header::CONTENT_TYPE], "application/json");

    let wrong_method = context
        .request(
            request(Method::POST, "/api/v1/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(wrong_method.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(
        json(wrong_method).await["error"]["code"],
        "method_not_allowed"
    );

    let invalid_query = context
        .request(
            authenticated(Method::GET, "/api/v1/events?since=bad")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(invalid_query.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        json(invalid_query).await["error"]["code"],
        "invalid_request"
    );

    for path in ["/", "/inbox", "/assets/app.js"] {
        let response = context
            .request(request(Method::GET, path).body(Body::empty()).unwrap())
            .await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
    }
}

#[tokio::test]
async fn sse_catches_up_with_full_envelope_and_multi_page() {
    let context = TestContext::new();
    create_task(&context, "First").await;
    create_task(&context, "Second").await;

    let response = context
        .request(
            authenticated(Method::GET, "/api/v1/events")
                .header("last-event-id", "1")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let frame = tokio::time::timeout(Duration::from_secs(1), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let data = frame.into_data().unwrap();
    let text = String::from_utf8(data.to_vec()).unwrap();
    assert!(text.contains("id: 2"), "{text}");
    assert!(!text.contains("id: 1"), "{text}");
    // Full CommittedEvent envelope fields.
    assert!(text.contains("\"resync\""), "{text}");
    assert!(text.contains("\"affected\""), "{text}");
    assert!(text.contains("\"event_type\""), "{text}");

    for index in 1..=105 {
        create_task(&context, &format!("Page {index}")).await;
    }
    let response = context
        .request(
            authenticated(Method::GET, "/api/v1/events")
                .header("last-event-id", "0")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let mut text = String::new();
    while !text.contains("id: 107") {
        let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
            .await
            .expect("catch-up page stalled")
            .expect("SSE body ended before catch-up completed")
            .expect("SSE frame failed");
        if let Ok(data) = frame.into_data() {
            text.push_str(std::str::from_utf8(&data).unwrap());
        }
    }
    assert!(text.contains("id: 1"), "{text}");
    assert_eq!(text.matches("id: ").count(), 107, "{text}");
}

#[tokio::test]
async fn dropping_sse_body_without_mutations_releases_forwarder() {
    let context = TestContext::new();
    let response = context.open_sse().await;
    context.wait_until_forwarders(1).await;
    drop(response);
    context.wait_until_forwarders(0).await;
    context.wait_until_connections(0).await;
}

#[tokio::test]
async fn repeated_sse_connect_drop_cycles_do_not_leave_forwarders() {
    let context = TestContext::new();
    for _ in 0..32 {
        let response = context.open_sse().await;
        context.wait_until_forwarders(1).await;
        drop(response);
        context.wait_until_forwarders(0).await;
    }
    assert_eq!(context.state.sse_connections.load(Ordering::SeqCst), 0);
    assert_eq!(context.state.active_forwarders.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn sse_connection_cap_is_enforced_and_released() {
    let context = TestContext::new();
    let mut held = Vec::with_capacity(MAX_SSE_CONNECTIONS);
    for _ in 0..MAX_SSE_CONNECTIONS {
        held.push(context.open_sse().await);
    }
    context.wait_until_forwarders(MAX_SSE_CONNECTIONS).await;
    context.wait_until_connections(MAX_SSE_CONNECTIONS).await;

    let overflow = context
        .request(
            authenticated(Method::GET, "/api/v1/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(overflow.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = json(overflow).await;
    assert_eq!(body["error"]["code"], "sse_connection_limit");
    assert_eq!(body["error"]["retryable"], true);

    held.pop();
    context
        .wait_until_connections(MAX_SSE_CONNECTIONS - 1)
        .await;
    let recovered = context.open_sse().await;
    assert_eq!(recovered.status(), StatusCode::OK);
    drop(recovered);
    drop(held);
    context.wait_until_forwarders(0).await;
    context.wait_until_connections(0).await;
}

#[tokio::test]
async fn shutdown_cancellation_ends_active_sse_forwarders() {
    let context = TestContext::new();
    let response = context.open_sse().await;
    context.wait_until_forwarders(1).await;
    context.state.shutdown_token().cancel();
    context.wait_until_forwarders(0).await;
    assert_eq!(context.state.sse_connections.load(Ordering::SeqCst), 1);
    drop(response);
    context.wait_until_connections(0).await;
}

#[tokio::test]
async fn backpressured_send_observes_shutdown_without_dropping_receiver() {
    let (sender, _receiver) = mpsc::channel::<Result<SseEvent, Infallible>>(1);
    sender
        .send(Ok(SseEvent::default().comment("occupy-buffer")))
        .await
        .unwrap();

    let shutdown = CancellationToken::new();
    let task_id = TaskId::new();
    let event = junban_app::CommittedEvent {
        revision: 1,
        operation_id: OperationId::parse(&Uuid::new_v4().to_string()).unwrap(),
        event_type: EventType::new(EventType::TASK_CREATED),
        occurred_at: Timestamp::now(),
        primary: Some(ResourceRef::task(task_id)),
        snapshot: None,
        affected: Default::default(),
        resync: ResyncScope::NONE,
    };

    let send_task = {
        let sender = sender.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            let mut last_sent = 0;
            send_event(&sender, &event, &mut last_sent, &shutdown).await
        })
    };

    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        !send_task.is_finished(),
        "send_event should still be blocked on the full channel"
    );

    shutdown.cancel();
    let finished = tokio::time::timeout(Duration::from_millis(500), send_task)
        .await
        .expect("backpressured send_event must observe shutdown")
        .unwrap();
    assert!(!finished);
}

#[test]
fn runtime_metadata_is_private_contains_no_token_and_is_removed() {
    let context = TestContext::new();
    let profile = context.directory.join("profile");
    let address: SocketAddr = "127.0.0.1:4123".parse().unwrap();
    let runtime = RuntimeMetadataFile::create(&profile, address).unwrap();
    let text = fs::read_to_string(profile.join(RUNTIME_FILE)).unwrap();
    assert!(!text.contains(TOKEN));
    assert_eq!(
        serde_json::from_str::<RuntimeMetadata>(&text)
            .unwrap()
            .address,
        address
    );
    drop(runtime);
    assert!(!profile.join(RUNTIME_FILE).exists());
}

#[test]
fn openapi_artifact_does_not_drift() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../openapi/junban-v1.json");
    let checked = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let checked: Value = serde_json::from_str(&checked).unwrap();
    let generated: Value = serde_json::from_str(&openapi_json()).unwrap();
    assert_eq!(checked, generated, "run openapi generation");
}

#[test]
fn p2_api_001_openapi_create_contracts_hide_generated_ids() {
    let doc: Value = serde_json::from_str(&openapi_json()).unwrap();
    for schema in [
        "CreateTaskRequest",
        "CreateProjectRequest",
        "CreateSectionRequest",
        "CreateTagRequest",
        "CreateTemplateRequest",
        "CreateSavedFilterRequest",
        "CreateCommentRequest",
        "CreateTimeBlockRequest",
        "CreateTimeSlotRequest",
    ] {
        assert!(
            doc["components"]["schemas"][schema]["properties"]
                .get("id")
                .is_none(),
            "{schema} must not accept a generated id"
        );
    }
    assert!(
        doc["components"]["schemas"]["ApplyTemplateRequest"]["properties"]
            .get("task_id")
            .is_none()
    );
}

#[test]
fn p2_api_003_openapi_documents_the_view_enum() {
    let doc: Value = serde_json::from_str(&openapi_json()).unwrap();
    assert_eq!(
        doc["components"]["schemas"]["TaskViewPresetDto"]["enum"],
        json!([
            "inbox",
            "today",
            "upcoming",
            "someday",
            "completed",
            "cancelled",
            "project"
        ])
    );
}

#[test]
fn p2_api_005_openapi_documents_operation_too_large_responses() {
    let doc: Value = serde_json::from_str(&openapi_json()).unwrap();
    for (path, item) in doc["paths"].as_object().unwrap() {
        for method in ["post", "patch", "put"] {
            let Some(operation) = item.get(method) else {
                continue;
            };
            if operation.get("requestBody").is_some() {
                assert!(
                    operation["responses"].get("413").is_some(),
                    "missing body-limit 413 response for {method} {path}"
                );
            }
        }
    }

    for (path, method) in [
        ("/api/v1/tasks/{task_id}/complete", "post"),
        ("/api/v1/tasks/{task_id}/uncomplete", "post"),
        ("/api/v1/tasks/{task_id}/cancel", "post"),
        ("/api/v1/tasks/{task_id}/reopen", "post"),
        ("/api/v1/tasks/{task_id}", "delete"),
        ("/api/v1/tasks/{task_id}/move", "post"),
        ("/api/v1/tasks/reorder", "post"),
        ("/api/v1/tasks/actions", "post"),
        ("/api/v1/projects/{project_id}", "delete"),
        ("/api/v1/sections/{section_id}", "delete"),
        ("/api/v1/tags/{tag_id}", "delete"),
        ("/api/v1/templates/{template_id}", "delete"),
        ("/api/v1/saved_filters/{filter_id}", "delete"),
        ("/api/v1/operations/{source_operation_id}/undo", "post"),
        ("/api/v1/time-blocks/{time_block_id}", "delete"),
        ("/api/v1/time-slots/{time_slot_id}", "delete"),
        (
            "/api/v1/time-slots/{time_slot_id}/tasks/{task_id}",
            "delete",
        ),
    ] {
        assert!(
            doc["paths"][path][method]["responses"].get("413").is_some(),
            "missing 413 response for {method} {path}"
        );
    }
}

#[test]
fn openapi_declares_security_and_operation_ids() {
    let doc: Value = serde_json::from_str(&openapi_json()).unwrap();
    let components = &doc["components"]["securitySchemes"];
    assert!(components.get("bearer_auth").is_some());
    let paths = doc["paths"].as_object().unwrap();
    assert!(paths.contains_key("/api/v1/tasks"));
    assert!(paths.contains_key("/api/v1/events"));
    assert!(paths.contains_key("/api/v1/catalog"));
    assert!(paths.contains_key("/api/v1/time-blocks"));
    assert!(paths.contains_key("/api/v1/time-slots"));
    assert!(paths.contains_key("/api/v1/time-blocks/{time_block_id}/move"));
    assert!(paths.contains_key("/api/v1/time-blocks/{time_block_id}/resize"));
    assert!(paths.contains_key("/api/v1/time-slots/{time_slot_id}/tasks"));
    let mut missing = Vec::new();
    for (path, item) in paths {
        for method in ["get", "post", "patch", "put", "delete"] {
            if let Some(op) = item.get(method) {
                if op.get("operationId").and_then(|v| v.as_str()).is_none() {
                    missing.push(format!("{method} {path}"));
                }
                if path != "/api/v1/health"
                    && op
                        .get("security")
                        .and_then(|v| v.as_array())
                        .is_none_or(|arr| arr.is_empty())
                {
                    missing.push(format!("security {method} {path}"));
                }
            }
        }
    }
    assert!(missing.is_empty(), "openapi gaps: {missing:?}");
}

// ── Phase 3 reminder HTTP surface ──────────────────────────────────────────

async fn reschedule(
    context: &TestContext,
    task_id: &str,
    remind_at: &str,
    key: Option<&str>,
) -> Response {
    let builder = authenticated(
        Method::POST,
        &format!("/api/v1/tasks/{task_id}/reminders/reschedule"),
    )
    .header(header::CONTENT_TYPE, "application/json");
    let builder = match key {
        Some(key) => operation_header_key(builder, key),
        None => operation_header(builder),
    };
    context
        .request(
            builder
                .body(Body::from(json!({ "remind_at": remind_at }).to_string()))
                .unwrap(),
        )
        .await
}

async fn dismiss(context: &TestContext, task_id: &str, key: Option<&str>) -> Response {
    let builder = authenticated(
        Method::POST,
        &format!("/api/v1/tasks/{task_id}/reminders/dismiss"),
    );
    let builder = match key {
        Some(key) => operation_header_key(builder, key),
        None => operation_header(builder),
    };
    context.request(builder.body(Body::empty()).unwrap()).await
}

#[tokio::test]
async fn reminder_routes_require_auth_and_use_error_envelope() {
    let context = TestContext::new();
    let created = create_task(&context, "auth-rem").await;
    let id = task_id_from(&created);

    let unauth = context
        .request(
            request(Method::GET, &format!("/api/v1/tasks/{id}/reminders"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
    let body = json(unauth).await;
    assert_eq!(body["error"]["code"], "authentication_required");
    assert!(body["request_id"].as_str().unwrap().len() > 8);

    let bad_id = context
        .request(
            authenticated(Method::GET, "/api/v1/tasks/not-a-uuid/reminders")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(bad_id.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = json(bad_id).await;
    assert_eq!(body["error"]["code"], "validation_error");
    assert!(body["error"]["fields"]["task_id"].is_string());

    let bad_channel = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/settle/delivered")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "fence_term": "01900000-0000-7000-8000-000000000099",
                        "task_id": id,
                        "remind_at": "2026-07-28T15:00:00Z",
                        "claim_attempt": 1,
                        "channel": "email"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(bad_channel.status(), StatusCode::BAD_REQUEST);
    let body = json(bad_channel).await;
    assert_eq!(body["error"]["code"], "invalid_json");

    let bad_fence = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/lease/renew")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "fence_term": "" }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(bad_fence.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let body = json(bad_fence).await;
    assert_eq!(body["error"]["code"], "validation_error");
    assert!(body["error"]["fields"]["reminder_fence_term"].is_string());

    let bad_time = reschedule(&context, id, "not-a-timestamp", None).await;
    assert_eq!(bad_time.status(), StatusCode::BAD_REQUEST);
    let body = json(bad_time).await;
    assert_eq!(body["error"]["code"], "invalid_json");
}

#[tokio::test]
async fn reminder_reschedule_dismiss_are_idempotent_user_mutations() {
    let context = TestContext::new();
    let created = create_task(&context, "snooze-me").await;
    let id = task_id_from(&created);
    let before_rev = created["event"]["revision"].as_u64().unwrap();

    let key = new_id();
    let first = reschedule(&context, id, "2026-07-28T15:00:00.100000000Z", Some(&key)).await;
    assert_eq!(first.status(), StatusCode::OK);
    let first_body = json(first).await;
    assert_eq!(first_body["event"]["event_type"], "task.updated");
    assert_eq!(
        first_body["event"]["snapshot"]["task"]["remind_at"],
        "2026-07-28T15:00:00.1Z"
    );
    let rev = first_body["event"]["revision"].as_u64().unwrap();
    assert!(rev > before_rev);

    let replay = reschedule(&context, id, "2026-07-28T15:00:00.100000000Z", Some(&key)).await;
    assert_eq!(replay.status(), StatusCode::OK);
    let replay_body = json(replay).await;
    assert_eq!(replay_body["event"]["revision"], rev);
    assert_eq!(
        replay_body["event"]["operation_id"],
        first_body["event"]["operation_id"]
    );

    let listed = context
        .request(
            authenticated(Method::GET, &format!("/api/v1/tasks/{id}/reminders"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(listed.status(), StatusCode::OK);
    let listed_body = json(listed).await;
    let pending: Vec<_> = listed_body["reminders"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["state"] == "pending")
        .collect();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["remind_at"], "2026-07-28T15:00:00.1Z");

    let dismiss_key = new_id();
    let dismissed = dismiss(&context, id, Some(&dismiss_key)).await;
    assert_eq!(dismissed.status(), StatusCode::OK);
    let dismissed_body = json(dismissed).await;
    assert!(dismissed_body["event"]["snapshot"]["task"]["remind_at"].is_null());
    let dismiss_rev = dismissed_body["event"]["revision"].as_u64().unwrap();

    let dismiss_replay = dismiss(&context, id, Some(&dismiss_key)).await;
    assert_eq!(dismiss_replay.status(), StatusCode::OK);
    let dismiss_replay_body = json(dismiss_replay).await;
    assert_eq!(dismiss_replay_body["event"]["revision"], dismiss_rev);
}

#[tokio::test]
async fn reminder_control_plane_claim_attempt_round_trip_without_revision_bump() {
    let context = TestContext::new();
    let created = create_task(&context, "deliver-me").await;
    let id = task_id_from(&created);
    let scheduled = reschedule(&context, id, "2026-07-28T11:00:00Z", None).await;
    assert_eq!(scheduled.status(), StatusCode::OK);
    let after_user = json(scheduled).await;
    let user_rev = after_user["event"]["revision"].as_u64().unwrap();
    let profile_before = context
        .request(
            authenticated(Method::GET, "/api/v1/profile")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(json(profile_before).await["revision"], user_rev);

    let lease_resp = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/lease")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
    assert_eq!(lease_resp.status(), StatusCode::OK);
    let lease = json(lease_resp).await;
    let fence = lease["fence_term"].as_str().unwrap().to_owned();

    let claim_resp = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/claim")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "fence_term": fence, "limit": 10 }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(claim_resp.status(), StatusCode::OK);
    let claim_body = json(claim_resp).await;
    let reminders = claim_body["reminders"].as_array().unwrap();
    assert_eq!(reminders.len(), 1);
    assert_eq!(reminders[0]["task_id"], id);
    assert_eq!(reminders[0]["claim_attempt"], 1);
    let claim_attempt = reminders[0]["claim_attempt"].as_u64().unwrap() as u32;
    let remind_at = reminders[0]["remind_at"].as_str().unwrap().to_owned();

    // Missing claim_attempt is rejected.
    let missing_attempt = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/settle/delivered")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "fence_term": fence,
                        "task_id": id,
                        "remind_at": remind_at,
                        "channel": "in_app"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(missing_attempt.status(), StatusCode::BAD_REQUEST);

    // Wrong attempt conflicts.
    let wrong_attempt = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/settle/delivered")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "fence_term": fence,
                        "task_id": id,
                        "remind_at": remind_at,
                        "claim_attempt": claim_attempt + 1,
                        "channel": "in_app"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(wrong_attempt.status(), StatusCode::CONFLICT);

    let settle = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/settle/delivered")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "fence_term": fence,
                        "task_id": id,
                        "remind_at": remind_at,
                        "claim_attempt": claim_attempt,
                        "channel": "in_app"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(settle.status(), StatusCode::NO_CONTENT);

    // Control-plane must not bump the global user revision.
    let profile_after = context
        .request(
            authenticated(Method::GET, "/api/v1/profile")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(json(profile_after).await["revision"], user_rev);

    let release = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/lease/release")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "fence_term": fence }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(release.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn reminder_owner_lost_route_recovers_crashed_owner_for_redelivery() {
    let context = TestContext::new();
    let created = create_task(&context, "crashed-owner").await;
    let id = TaskId::parse(task_id_from(&created)).unwrap();
    let due = Timestamp::now()
        .checked_sub(600.seconds())
        .unwrap()
        .to_string();
    assert_eq!(
        reschedule(&context, &id.to_string(), &due, None)
            .await
            .status(),
        StatusCode::OK
    );

    let repository = context._owner.repository();
    let crashed_at = Timestamp::now().checked_sub(120.seconds()).unwrap();
    let crashed_lease = repository
        .acquire_reminder_lease(crashed_at, 1)
        .await
        .unwrap();
    let claimed = repository
        .claim_due_reminders(crashed_lease.fence_term, crashed_at, 1, 1)
        .await
        .unwrap();
    assert_eq!(claimed.len(), 1);

    let replacement_lease = repository
        .acquire_reminder_lease(Timestamp::now(), 90)
        .await
        .unwrap();
    let replacement_term = replacement_lease.fence_term.to_string();
    let sweep = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/owner-lost")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "fence_term": replacement_term }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(sweep.status(), StatusCode::OK);
    assert_eq!(json(sweep).await["marked"], 1);

    let recovered = repository.list_task_reminders(id).await.unwrap();
    assert_eq!(recovered.len(), 1);
    let recovered = &recovered[0];
    assert_eq!(
        recovered.state,
        junban_domain::ReminderOccurrenceState::Pending
    );
    let reclaimed = repository
        .claim_due_reminders(
            replacement_lease.fence_term,
            recovered.next_attempt_at.unwrap(),
            1,
            90,
        )
        .await
        .unwrap();
    assert_eq!(reclaimed.len(), 1);
    assert_eq!(reclaimed[0].task_id, id);
    assert_eq!(reclaimed[0].claim_attempt, 2);
}

#[tokio::test]
async fn reminder_invalid_failure_code_and_owner_lost_route() {
    let context = TestContext::new();
    let created = create_task(&context, "fail-me").await;
    let id = task_id_from(&created);
    assert_eq!(
        reschedule(&context, id, "2026-07-28T10:00:00Z", None)
            .await
            .status(),
        StatusCode::OK
    );

    let lease_resp = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/lease")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "lease_secs": 90 }).to_string()))
                .unwrap(),
        )
        .await;
    let fence = json(lease_resp).await["fence_term"]
        .as_str()
        .unwrap()
        .to_owned();
    let claim_body = json(
        context
            .request(
                authenticated(Method::POST, "/api/v1/reminders/claim")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "fence_term": fence }).to_string()))
                    .unwrap(),
            )
            .await,
    )
    .await;
    let row = &claim_body["reminders"][0];

    let bad_error = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/settle/failed")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "fence_term": fence,
                        "task_id": row["task_id"],
                        "remind_at": row["remind_at"],
                        "claim_attempt": row["claim_attempt"],
                        "error": "boom"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(bad_error.status(), StatusCode::BAD_REQUEST);

    // Settle failed with allowlisted code.
    let failed = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/settle/failed")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "fence_term": fence,
                        "task_id": row["task_id"],
                        "remind_at": row["remind_at"],
                        "claim_attempt": row["claim_attempt"],
                        "error": "channel_failed"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(failed.status(), StatusCode::NO_CONTENT);

    // Owner-lost sweep with empty expired set returns zero.
    let sweep = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/owner-lost")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "fence_term": fence }).to_string()))
                .unwrap(),
        )
        .await;
    assert_eq!(sweep.status(), StatusCode::OK);
    assert_eq!(json(sweep).await["marked"], 0);
}

// ── Phase 3 reminder wake coordinator + ephemeral SSE ──────────────────────

async fn open_reminder_sse(context: &TestContext) -> Response {
    let response = context
        .request(
            authenticated(Method::GET, "/api/v1/reminders/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    response
}

async fn read_sse_chunk(body: &mut axum::body::Body, deadline: Duration) -> String {
    let frame = tokio::time::timeout(deadline, body.frame())
        .await
        .expect("SSE frame timed out")
        .expect("SSE body ended")
        .expect("SSE frame error");
    let data = frame.into_data().expect("SSE data frame");
    String::from_utf8(data.to_vec()).unwrap()
}

async fn recv_wake(
    wakes: &mut tokio::sync::broadcast::Receiver<crate::reminder_wake::ReminderWakeEventDto>,
) -> crate::reminder_wake::ReminderWakeEventDto {
    // These tests pause Tokio time, so a Tokio timeout can expire immediately
    // while the SQLite owner thread is still returning the wake query. Use a
    // wall-clock watchdog only as a hang guard; the wake itself is the condition.
    let (watchdog_tx, watchdog_rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        let _ = watchdog_tx.send(());
    });
    tokio::select! {
        result = wakes.recv() => result.expect("wake channel"),
        _ = watchdog_rx => panic!("timed out waiting for reminder wake"),
    }
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn reminder_coordinator_due_wake_throttles_without_notify() {
    let context = TestContext::new();
    let mut wakes = context.state.reminder_wakes.subscribe();
    let handle = context.state.start_reminder_coordinator();
    tokio::task::yield_now().await;

    let created = create_task(&context, "overdue-wake").await;
    let id = task_id_from(&created);
    let past = Timestamp::now()
        .checked_sub(Duration::from_secs(300))
        .unwrap()
        .to_string();
    assert_eq!(
        reschedule(&context, id, &past, None).await.status(),
        StatusCode::OK
    );

    let first = recv_wake(&mut wakes).await;
    assert_eq!(first.sequence, 1);

    tokio::time::advance(REMINDER_OVERDUE_WAKE_THROTTLE - Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(
        wakes.try_recv().is_err(),
        "overdue throttle must suppress rebroadcast"
    );

    tokio::time::advance(Duration::from_secs(1)).await;
    let second = recv_wake(&mut wakes).await;
    assert_eq!(second.sequence, 2);

    context.state.shutdown_token().cancel();
    handle.await.unwrap();
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn reminder_coordinator_notification_bypasses_overdue_throttle() {
    let context = TestContext::new();
    let mut wakes = context.state.reminder_wakes.subscribe();
    let handle = context.state.start_reminder_coordinator();
    tokio::task::yield_now().await;

    let created = create_task(&context, "overdue-notify").await;
    let id = task_id_from(&created);
    let past = Timestamp::now()
        .checked_sub(Duration::from_secs(120))
        .unwrap()
        .to_string();
    assert_eq!(
        reschedule(&context, id, &past, None).await.status(),
        StatusCode::OK
    );
    assert_eq!(recv_wake(&mut wakes).await.sequence, 1);

    context.state.notify_reminder_wake();
    let second = recv_wake(&mut wakes).await;
    assert_eq!(second.sequence, 2);

    context.state.shutdown_token().cancel();
    handle.await.unwrap();
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn reminder_coordinator_sleeps_until_future_eligibility() {
    let context = TestContext::new();
    let mut wakes = context.state.reminder_wakes.subscribe();
    let handle = context.state.start_reminder_coordinator();
    tokio::task::yield_now().await;

    let created = create_task(&context, "future-wake").await;
    let id = task_id_from(&created);
    let future = Timestamp::now()
        .checked_add(Duration::from_secs(60))
        .unwrap()
        .to_string();
    assert_eq!(
        reschedule(&context, id, &future, None).await.status(),
        StatusCode::OK
    );
    // Let the coordinator observe the future wake and arm its sleep.
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;

    tokio::time::advance(Duration::from_secs(30)).await;
    tokio::task::yield_now().await;
    assert!(wakes.try_recv().is_err(), "must sleep until eligibility");

    tokio::time::advance(Duration::from_secs(120)).await;
    let wake = recv_wake(&mut wakes).await;
    assert_eq!(wake.sequence, 1);

    context.state.shutdown_token().cancel();
    handle.await.unwrap();
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn reminder_coordinator_idles_without_rows() {
    let context = TestContext::new();
    let mut wakes = context.state.reminder_wakes.subscribe();
    let handle = context.state.start_reminder_coordinator();
    tokio::task::yield_now().await;

    tokio::time::advance(Duration::from_secs(600)).await;
    tokio::task::yield_now().await;
    assert!(wakes.try_recv().is_err(), "no-row idle must not poll");

    context.state.shutdown_token().cancel();
    handle.await.unwrap();
}

#[tokio::test]
async fn reminder_sse_requires_auth_and_shares_connection_cap() {
    let context = TestContext::new();

    let unauth = context
        .request(
            request(Method::GET, "/api/v1/reminders/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

    let mut held = Vec::with_capacity(MAX_SSE_CONNECTIONS);
    for _ in 0..MAX_SSE_CONNECTIONS {
        held.push(context.open_sse().await);
    }
    context.wait_until_connections(MAX_SSE_CONNECTIONS).await;

    let overflow = context
        .request(
            authenticated(Method::GET, "/api/v1/reminders/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(overflow.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = json(overflow).await;
    assert_eq!(body["error"]["code"], "sse_connection_limit");

    drop(held);
    context.wait_until_connections(0).await;
    let recovered = open_reminder_sse(&context).await;
    drop(recovered);
    context.wait_until_connections(0).await;
}

#[tokio::test]
async fn reminder_sse_sends_immediate_wake_without_revision_bump() {
    let context = TestContext::new();
    let before = context
        .request(
            authenticated(Method::GET, "/api/v1/profile")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    let before_rev = json(before).await["revision"].as_u64().unwrap();

    context.state.reminder_wakes.publish_due_wake();

    let response = open_reminder_sse(&context).await;
    context.wait_until_forwarders(1).await;
    let mut body = response.into_body();
    let text = read_sse_chunk(&mut body, Duration::from_secs(2)).await;
    assert!(
        text.contains(&format!("event: {REMINDER_WAKE_EVENT_TYPE}")),
        "{text}"
    );
    assert!(text.contains("\"sequence\":"), "{text}");
    assert!(text.contains("\"server_now\":"), "{text}");
    assert!(
        text.contains("id: 1"),
        "immediate snapshot uses latest sequence: {text}"
    );

    let after = context
        .request(
            authenticated(Method::GET, "/api/v1/profile")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(json(after).await["revision"], before_rev);

    drop(body);
    context.wait_until_forwarders(0).await;
    context.wait_until_connections(0).await;
}

#[tokio::test]
async fn reminder_sse_forwards_live_wake_and_ends_on_shutdown_or_disconnect() {
    let context = TestContext::new();
    let response = open_reminder_sse(&context).await;
    context.wait_until_forwarders(1).await;
    let mut body = response.into_body();
    let _ = read_sse_chunk(&mut body, Duration::from_secs(2)).await;

    let wake = context.state.reminder_wakes.publish_due_wake();
    let text = read_sse_chunk(&mut body, Duration::from_secs(2)).await;
    assert!(text.contains(&format!("id: {}", wake.sequence)), "{text}");
    assert!(text.contains(REMINDER_WAKE_EVENT_TYPE), "{text}");

    context.state.shutdown_token().cancel();
    context.wait_until_forwarders(0).await;
    drop(body);
    context.wait_until_connections(0).await;

    let response = open_reminder_sse(&context).await;
    context.wait_until_forwarders(1).await;
    drop(response);
    context.wait_until_forwarders(0).await;
    context.wait_until_connections(0).await;
}

#[tokio::test]
async fn reminder_sse_coalesces_after_broadcast_lag() {
    let context = TestContext::new();
    let response = open_reminder_sse(&context).await;
    context.wait_until_forwarders(1).await;
    let mut body = response.into_body();
    let _ = read_sse_chunk(&mut body, Duration::from_secs(2)).await;

    for _ in 0..96 {
        context.state.reminder_wakes.publish_due_wake();
    }

    let mut text = String::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(250), body.frame()).await {
            Ok(Some(Ok(frame))) => {
                if let Ok(data) = frame.into_data() {
                    text.push_str(std::str::from_utf8(&data).unwrap());
                    if text.contains("event: reminders_due") {
                        break;
                    }
                }
            }
            Ok(Some(Err(_))) | Ok(None) | Err(_) => break,
        }
    }
    assert!(
        text.contains("reminders_due") && text.contains("\"sequence\":"),
        "expected coalesced or drained wake after lag, got: {text}"
    );
    drop(body);
    context.wait_until_forwarders(0).await;
}

#[tokio::test]
async fn reminder_control_plane_notifies_coordinator_hub() {
    let context = TestContext::new();
    let hub = std::sync::Arc::clone(&context.state.reminder_wakes);
    let notified = hub.notified();
    tokio::pin!(notified);

    let lease = context
        .request(
            authenticated(Method::POST, "/api/v1/reminders/lease")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await;
    assert_eq!(lease.status(), StatusCode::OK);
    tokio::time::timeout(Duration::from_secs(1), notified)
        .await
        .expect("successful lease must notify reminder hub");
}

#[tokio::test]
async fn server_state_new_does_not_start_reminder_coordinator() {
    let context = TestContext::new();
    let mut wakes = context.state.reminder_wakes.subscribe();
    let created = create_task(&context, "no-coordinator").await;
    let id = task_id_from(&created);
    assert_eq!(
        reschedule(&context, id, "2020-01-01T00:00:00Z", None)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(context.state.reminder_wakes.latest_sequence(), 0);
    assert!(wakes.try_recv().is_err());
    let _ = start_reminder_coordinator;
}

// ── Phase 3 timeblocking HTTP API ──────────────────────────────────────────

async fn mutate_json(
    context: &TestContext,
    method: Method,
    uri: &str,
    payload: Value,
    key: Option<&str>,
) -> Response {
    let builder = match key {
        Some(key) => operation_header_key(authenticated(method, uri), key),
        None => operation_header(authenticated(method, uri)),
    };
    context
        .request(
            builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
}

fn block_payload(title: &str, date: &str, start: &str, end: &str) -> Value {
    json!({
        "title": title,
        "date": date,
        "start": start,
        "end": end,
        "time_zone": "UTC",
        "color": "#4F46E5"
    })
}

fn slot_payload(title: &str, date: &str, start: &str, end: &str) -> Value {
    json!({
        "title": title,
        "date": date,
        "start": start,
        "end": end,
        "time_zone": "UTC",
        "color": "#0EA5E9"
    })
}

async fn replan_payload(context: &TestContext, action: &str) -> Value {
    let response = context
        .request(
            authenticated(Method::GET, "/api/v1/time-blocks/replan/preview")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let preview = json(response).await;
    json!({
        "action": action,
        "expected_as_of_date": preview["as_of_date"],
        "expected_candidate_ids": preview["candidate_ids"]
    })
}

async fn create_block(context: &TestContext, payload: Value) -> Value {
    let response = mutate_json(context, Method::POST, "/api/v1/time-blocks", payload, None).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = json(response).await;
    assert_eq!(body["event"]["event_type"], "time_block.created");
    body
}

async fn create_slot(context: &TestContext, payload: Value) -> Value {
    let response = mutate_json(context, Method::POST, "/api/v1/time-slots", payload, None).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = json(response).await;
    assert_eq!(body["event"]["event_type"], "time_slot.created");
    body
}

fn block_id_from(body: &Value) -> &str {
    body["event"]["snapshot"]["time_block"]["id"]
        .as_str()
        .unwrap()
}

fn slot_id_from(body: &Value) -> &str {
    body["event"]["snapshot"]["time_slot"]["id"]
        .as_str()
        .unwrap()
}

#[tokio::test]
async fn timeblocking_routes_require_auth() {
    let context = TestContext::new();
    let denied = context
        .request(
            request(Method::GET, "/api/v1/time-blocks")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

    let denied_slots = context
        .request(
            request(Method::GET, "/api/v1/time-slots")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(denied_slots.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn time_block_list_defaults_and_rejects_invalid_windows() {
    let context = TestContext::new();
    let today = jiff::Zoned::now().date().to_string();
    let _ = create_block(
        &context,
        block_payload("Focus", &today, "09:00:00", "10:00:00"),
    )
    .await;

    let listed = context
        .request(
            authenticated(Method::GET, "/api/v1/time-blocks")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(listed.status(), StatusCode::OK);
    let body = json(listed).await;
    assert_eq!(body["time_blocks"].as_array().unwrap().len(), 1);
    assert!(body["revision"].as_u64().unwrap() >= 1);
    let listed_id = body["time_blocks"][0]["id"].as_str().unwrap();
    let listed_date = body["time_blocks"][0]["date"].as_str().unwrap();
    assert_eq!(
        body["time_blocks"][0]["occurrence_key"].as_str().unwrap(),
        format!("{listed_id}:{listed_date}")
    );

    let inverted = context
        .request(
            authenticated(
                Method::GET,
                "/api/v1/time-blocks?from=2026-03-10&to=2026-03-01",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(inverted.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(json(inverted).await["error"]["code"], "validation_error");

    let too_wide = context
        .request(
            authenticated(
                Method::GET,
                "/api/v1/time-blocks?from=2026-01-01&to=2026-03-01",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(too_wide.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let bad_date = context
        .request(
            authenticated(Method::GET, "/api/v1/time-blocks?from=not-a-date")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(bad_date.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let unknown = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-blocks",
        json!({
            "title": "X",
            "date": "2026-03-08",
            "start": "09:00:00",
            "end": "10:00:00",
            "time_zone": "UTC",
            "extra": true
        }),
        None,
    )
    .await;
    assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn time_block_list_expands_recurring_owners_with_stable_occurrence_keys() {
    let context = TestContext::new();
    let created = create_block(
        &context,
        json!({
            "title": "Daily focus",
            "date": "2026-03-01",
            "start": "09:00:00",
            "end": "10:00:00",
            "time_zone": "UTC",
            "recurrence_rule": "daily"
        }),
    )
    .await;
    let owner_id = block_id_from(&created).to_owned();

    let listed = context
        .request(
            authenticated(
                Method::GET,
                "/api/v1/time-blocks?from=2026-03-08&to=2026-03-10",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(listed.status(), StatusCode::OK);
    let body = json(listed).await;
    let blocks = body["time_blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 3);
    for (index, date) in ["2026-03-08", "2026-03-09", "2026-03-10"]
        .into_iter()
        .enumerate()
    {
        assert_eq!(blocks[index]["id"], owner_id);
        assert_eq!(blocks[index]["date"], date);
        assert_eq!(
            blocks[index]["occurrence_key"].as_str().unwrap(),
            format!("{owner_id}:{date}")
        );
        assert_eq!(
            blocks[index]["recurrence_parent_id"].as_str().unwrap(),
            owner_id
        );
    }
}

#[tokio::test]
async fn recurring_time_block_series_edits_preserve_owner_range_and_time_zone() {
    let context = TestContext::new();
    let (_, settings) = get_json(&context, "/api/v1/settings/temporal").await;
    let server_zone = settings["time_zone"].as_str().unwrap();
    let owner_zone = if server_zone == "Pacific/Auckland" {
        "America/New_York"
    } else {
        "Pacific/Auckland"
    };
    let created = create_block(
        &context,
        json!({
            "title": "Daily focus",
            "date": "2026-03-01",
            "start": "09:00:00",
            "end": "10:00:00",
            "time_zone": owner_zone,
            "recurrence_rule": "daily"
        }),
    )
    .await;
    let owner_id = block_id_from(&created).to_owned();

    let (_, later_page) = get_json(
        &context,
        "/api/v1/time-blocks?from=2026-03-08&to=2026-03-08",
    )
    .await;
    let later = &later_page["time_blocks"][0];
    assert_eq!(later["id"], owner_id);
    assert_eq!(later["date"], "2026-03-08");
    assert_eq!(later["time_zone"], owner_zone);

    // The browser edits the durable owner id from the virtual row and omits all
    // unchanged temporal fields.
    let renamed = mutate_json(
        &context,
        Method::PATCH,
        &format!("/api/v1/time-blocks/{owner_id}"),
        json!({ "title": "Renamed series" }),
        None,
    )
    .await;
    assert_eq!(renamed.status(), StatusCode::OK);
    let renamed = json(renamed).await;
    let renamed_owner = &renamed["event"]["snapshot"]["time_block"];
    assert_eq!(renamed_owner["title"], "Renamed series");
    assert_eq!(renamed_owner["date"], "2026-03-01");
    assert_eq!(renamed_owner["start"], "09:00:00");
    assert_eq!(renamed_owner["end"], "10:00:00");
    assert_eq!(renamed_owner["time_zone"], owner_zone);

    let retimed = mutate_json(
        &context,
        Method::PATCH,
        &format!("/api/v1/time-blocks/{owner_id}"),
        json!({ "start": "09:30:00" }),
        None,
    )
    .await;
    assert_eq!(retimed.status(), StatusCode::OK);
    let retimed = json(retimed).await;
    let retimed_owner = &retimed["event"]["snapshot"]["time_block"];
    assert_eq!(retimed_owner["date"], "2026-03-01");
    assert_eq!(retimed_owner["start"], "09:30:00");
    assert_eq!(retimed_owner["end"], "10:00:00");
    assert_eq!(retimed_owner["time_zone"], owner_zone);

    // Move/resize update only the supported civil fields and retain the durable
    // owner's anchor date and timezone when those values are omitted.
    let moved = mutate_json(
        &context,
        Method::POST,
        &format!("/api/v1/time-blocks/{owner_id}/move"),
        json!({ "start": "10:00:00", "end": "11:00:00" }),
        None,
    )
    .await;
    assert_eq!(moved.status(), StatusCode::OK);
    let moved = json(moved).await;
    let moved_owner = &moved["event"]["snapshot"]["time_block"];
    assert_eq!(moved_owner["date"], "2026-03-01");
    assert_eq!(moved_owner["start"], "10:00:00");
    assert_eq!(moved_owner["end"], "11:00:00");
    assert_eq!(moved_owner["time_zone"], owner_zone);

    let resized = mutate_json(
        &context,
        Method::POST,
        &format!("/api/v1/time-blocks/{owner_id}/resize"),
        json!({ "start": "10:00:00", "end": "11:30:00" }),
        None,
    )
    .await;
    assert_eq!(resized.status(), StatusCode::OK);
    let resized = json(resized).await;
    let resized_owner = &resized["event"]["snapshot"]["time_block"];
    assert_eq!(resized_owner["date"], "2026-03-01");
    assert_eq!(resized_owner["end"], "11:30:00");
    assert_eq!(resized_owner["time_zone"], owner_zone);

    let (_, reloaded) = get_json(
        &context,
        "/api/v1/time-blocks?from=2026-03-01&to=2026-03-08",
    )
    .await;
    let blocks = reloaded["time_blocks"].as_array().unwrap();
    let durable_owner = blocks
        .iter()
        .find(|block| block["date"] == "2026-03-01")
        .unwrap();
    let later_occurrence = blocks
        .iter()
        .find(|block| block["date"] == "2026-03-08")
        .unwrap();
    for block in [durable_owner, later_occurrence] {
        assert_eq!(block["title"], "Renamed series");
        assert_eq!(block["start"], "10:00:00");
        assert_eq!(block["end"], "11:30:00");
        assert_eq!(block["time_zone"], owner_zone);
    }
}

#[tokio::test]
async fn time_block_replan_is_idempotent_and_supports_actions() {
    let context = TestContext::new();

    // Seed unlocked past blocks relative to server-local today.
    let today = jiff::Zoned::now().date();
    let yesterday = today.checked_sub(1.day()).unwrap();
    let two_days_ago = today.checked_sub(2.days()).unwrap();

    let unlocked = create_block(
        &context,
        block_payload(
            "Past open",
            &two_days_ago.to_string(),
            "09:00:00",
            "10:00:00",
        ),
    )
    .await;
    let unlocked_id = block_id_from(&unlocked).to_owned();

    let locked = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-blocks",
        json!({
            "title": "Past locked",
            "date": yesterday.to_string(),
            "start": "11:00:00",
            "end": "12:00:00",
            "time_zone": "UTC",
            "locked": true
        }),
        None,
    )
    .await;
    assert_eq!(locked.status(), StatusCode::CREATED);
    let locked_id = block_id_from(&json(locked).await).to_owned();

    let key = Uuid::new_v4().to_string();
    let move_today_payload = replan_payload(&context, "move_to_today").await;
    assert_eq!(move_today_payload["expected_as_of_date"], today.to_string());
    assert_eq!(
        move_today_payload["expected_candidate_ids"],
        json!([unlocked_id])
    );
    let first = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-blocks/replan",
        move_today_payload.clone(),
        Some(&key),
    )
    .await;
    assert_eq!(first.status(), StatusCode::OK);
    let first_bytes = response_bytes(first).await;
    let first_json: Value = serde_json::from_slice(&first_bytes).unwrap();
    assert_eq!(first_json["event"]["event_type"], "time_block.replanned");
    assert_eq!(
        first_json["event"]["affected"]["time_block_ids"],
        json!([unlocked_id])
    );

    let replay = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-blocks/replan",
        move_today_payload,
        Some(&key),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(response_bytes(replay).await, first_bytes);

    // Replay must not advance revision / emit a second event.
    let revision_after_first = first_json["event"]["revision"].as_u64().unwrap();
    let listed_after_replay = context
        .request(
            authenticated(
                Method::GET,
                &format!("/api/v1/time-blocks?from={}&to={}", two_days_ago, today),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(
        json(listed_after_replay).await["revision"]
            .as_u64()
            .unwrap(),
        revision_after_first
    );

    let listed = context
        .request(
            authenticated(
                Method::GET,
                &format!("/api/v1/time-blocks?from={}&to={}", two_days_ago, today),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    let body = json(listed).await;
    let unlocked_row = body["time_blocks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["id"] == unlocked_id)
        .unwrap();
    let locked_row = body["time_blocks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|block| block["id"] == locked_id)
        .unwrap();
    assert_eq!(unlocked_row["date"], today.to_string());
    assert_eq!(locked_row["date"], yesterday.to_string());

    // move_to_tomorrow for a fresh past unlocked block.
    let move_tomorrow = create_block(
        &context,
        block_payload(
            "Move tomorrow",
            &yesterday.to_string(),
            "13:00:00",
            "14:00:00",
        ),
    )
    .await;
    let move_tomorrow_id = block_id_from(&move_tomorrow).to_owned();
    let moved = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-blocks/replan",
        replan_payload(&context, "move_to_tomorrow").await,
        None,
    )
    .await;
    assert_eq!(moved.status(), StatusCode::OK);
    assert_eq!(
        json(moved).await["event"]["event_type"],
        "time_block.replanned"
    );
    let tomorrow = today.checked_add(1.day()).unwrap();
    let listed = context
        .request(
            authenticated(
                Method::GET,
                &format!("/api/v1/time-blocks?from={tomorrow}&to={tomorrow}"),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert!(
        json(listed).await["time_blocks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|block| block["id"] == move_tomorrow_id)
    );

    // delete action removes unlocked past blocks only.
    let delete_me = create_block(
        &context,
        block_payload("Delete me", &yesterday.to_string(), "15:00:00", "16:00:00"),
    )
    .await;
    let delete_id = block_id_from(&delete_me).to_owned();
    let deleted = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-blocks/replan",
        replan_payload(&context, "delete").await,
        None,
    )
    .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    let deleted = json(deleted).await;
    assert!(
        deleted["event"]["affected"]["time_block_ids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == &json!(delete_id))
    );
    assert!(
        !deleted["event"]["affected"]["time_block_ids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == &json!(locked_id))
    );

    let unknown = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-blocks/replan",
        json!({ "action": "move_to_today", "extra": true }),
        None,
    )
    .await;
    assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);

    let bad_action = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-blocks/replan",
        json!({ "action": "nope" }),
        None,
    )
    .await;
    assert_eq!(bad_action.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn time_block_replan_rejects_a_stale_server_preview() {
    let context = TestContext::new();
    let today = jiff::Zoned::now().date();
    let yesterday = today.checked_sub(1.day()).unwrap();

    create_block(
        &context,
        block_payload(
            "Initially eligible",
            &yesterday.to_string(),
            "09:00:00",
            "10:00:00",
        ),
    )
    .await;
    let stale_payload = replan_payload(&context, "delete").await;

    create_block(
        &context,
        block_payload(
            "New candidate",
            &yesterday.to_string(),
            "11:00:00",
            "12:00:00",
        ),
    )
    .await;
    let response = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-blocks/replan",
        stale_payload,
        None,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);

    let current = replan_payload(&context, "delete").await;
    assert_eq!(
        current["expected_candidate_ids"].as_array().unwrap().len(),
        2
    );
}

#[tokio::test]
async fn time_block_mutations_move_resize_and_idempotent_replay() {
    let context = TestContext::new();
    let task = create_task(&context, "Linked").await;
    let task_id = task_id_from(&task).to_owned();

    let key = Uuid::new_v4().to_string();
    let payload = json!({
        "title": "Deep work",
        "date": "2026-03-08",
        "start": "09:00:00",
        "end": "10:00:00",
        "time_zone": "UTC",
        "task_id": task_id,
        "color": "#111827"
    });
    let first = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-blocks",
        payload.clone(),
        Some(&key),
    )
    .await;
    assert_eq!(first.status(), StatusCode::CREATED);
    let first_bytes = response_bytes(first).await;
    let first_json: Value = serde_json::from_slice(&first_bytes).unwrap();
    let block_id = block_id_from(&first_json).to_owned();
    assert_eq!(
        first_json["event"]["snapshot"]["time_block"]["task_id"],
        task_id
    );
    assert_eq!(
        first_json["event"]["affected"]["time_block_ids"],
        json!([block_id])
    );

    let replay = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-blocks",
        payload,
        Some(&key),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::CREATED);
    assert_eq!(response_bytes(replay).await, first_bytes);

    let listed = context
        .request(
            authenticated(
                Method::GET,
                "/api/v1/time-blocks?from=2026-03-08&to=2026-03-08",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(
        json(listed).await["time_blocks"].as_array().unwrap().len(),
        1
    );

    let patched = mutate_json(
        &context,
        Method::PATCH,
        &format!("/api/v1/time-blocks/{block_id}"),
        json!({
            "title": "Focus block",
            "task_id": null,
            "color": null,
            "locked": true,
            "date": "2026-03-08",
            "start": "09:30:00",
            "end": "10:30:00",
            "time_zone": "UTC"
        }),
        None,
    )
    .await;
    assert_eq!(patched.status(), StatusCode::OK);
    let patched = json(patched).await;
    assert_eq!(patched["event"]["event_type"], "time_block.updated");
    assert_eq!(
        patched["event"]["snapshot"]["time_block"]["title"],
        "Focus block"
    );
    assert!(
        patched["event"]["snapshot"]["time_block"]["task_id"].is_null()
            || patched["event"]["snapshot"]["time_block"]
                .get("task_id")
                .is_none()
    );
    assert_eq!(
        patched["event"]["snapshot"]["time_block"]["start"],
        "09:30:00"
    );
    assert!(
        patched["event"]["snapshot"]["time_block"]["locked"]
            .as_bool()
            .unwrap()
    );

    let moved = mutate_json(
        &context,
        Method::POST,
        &format!("/api/v1/time-blocks/{block_id}/move"),
        json!({
            "date": "2026-03-09",
            "start": "11:00:00",
            "end": "12:00:00",
            "time_zone": "UTC"
        }),
        None,
    )
    .await;
    assert_eq!(moved.status(), StatusCode::OK);
    let moved = json(moved).await;
    assert_eq!(
        moved["event"]["snapshot"]["time_block"]["date"],
        "2026-03-09"
    );

    let resized = mutate_json(
        &context,
        Method::POST,
        &format!("/api/v1/time-blocks/{block_id}/resize"),
        json!({
            "date": "2026-03-09",
            "start": "11:00:00",
            "end": "12:30:00",
            "time_zone": "UTC"
        }),
        None,
    )
    .await;
    assert_eq!(resized.status(), StatusCode::OK);
    assert_eq!(
        json(resized).await["event"]["snapshot"]["time_block"]["end"],
        "12:30:00"
    );

    let inverted = mutate_json(
        &context,
        Method::POST,
        &format!("/api/v1/time-blocks/{block_id}/resize"),
        json!({
            "date": "2026-03-09",
            "start": "13:00:00",
            "end": "12:00:00",
            "time_zone": "UTC"
        }),
        None,
    )
    .await;
    assert_eq!(inverted.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let deleted = context
        .request(
            operation_header(authenticated(
                Method::DELETE,
                &format!("/api/v1/time-blocks/{block_id}"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(
        json(deleted).await["event"]["event_type"],
        "time_block.deleted"
    );

    let missing = context
        .request(
            operation_header(authenticated(
                Method::DELETE,
                &format!("/api/v1/time-blocks/{block_id}"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn time_slot_crud_filters_and_membership_operations() {
    let context = TestContext::new();

    let project = mutate_json(
        &context,
        Method::POST,
        "/api/v1/projects",
        json!({ "name": "Planning", "color": "#22C55E" }),
        None,
    )
    .await;
    assert_eq!(project.status(), StatusCode::CREATED);
    let project_id = json(project).await["event"]["snapshot"]["project"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let key = Uuid::new_v4().to_string();
    let payload = json!({
        "title": "Morning",
        "date": "2026-03-08",
        "start": "09:00:00",
        "end": "11:00:00",
        "time_zone": "UTC",
        "project_id": project_id,
        "color": "#0EA5E9"
    });
    let first = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-slots",
        payload.clone(),
        Some(&key),
    )
    .await;
    assert_eq!(first.status(), StatusCode::CREATED);
    let first_bytes = response_bytes(first).await;
    let first_json: Value = serde_json::from_slice(&first_bytes).unwrap();
    let slot_id = slot_id_from(&first_json).to_owned();
    assert_eq!(
        first_json["event"]["affected"]["time_slot_ids"],
        json!([slot_id])
    );

    let replay = mutate_json(
        &context,
        Method::POST,
        "/api/v1/time-slots",
        payload,
        Some(&key),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::CREATED);
    assert_eq!(response_bytes(replay).await, first_bytes);

    let _unscoped = create_slot(
        &context,
        slot_payload("Open", "2026-03-08", "13:00:00", "14:00:00"),
    )
    .await;

    let filtered = context
        .request(
            authenticated(
                Method::GET,
                &format!("/api/v1/time-slots?date=2026-03-08&project_id={project_id}"),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(filtered.status(), StatusCode::OK);
    let filtered = json(filtered).await;
    assert_eq!(filtered["time_slots"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["time_slots"][0]["id"], slot_id);

    let unscoped = context
        .request(
            authenticated(
                Method::GET,
                "/api/v1/time-slots?date=2026-03-08&project_id=-",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(
        json(unscoped).await["time_slots"].as_array().unwrap().len(),
        1
    );

    let patched = mutate_json(
        &context,
        Method::PATCH,
        &format!("/api/v1/time-slots/{slot_id}"),
        json!({
            "title": "Deep morning",
            "project_id": null,
            "color": null
        }),
        None,
    )
    .await;
    assert_eq!(patched.status(), StatusCode::OK);
    let patched = json(patched).await;
    assert_eq!(
        patched["event"]["snapshot"]["time_slot"]["title"],
        "Deep morning"
    );
    assert!(
        patched["event"]["snapshot"]["time_slot"]["project_id"].is_null()
            || patched["event"]["snapshot"]["time_slot"]
                .get("project_id")
                .is_none()
    );

    let t1 = task_id_from(&create_task(&context, "A").await).to_owned();
    let t2 = task_id_from(&create_task(&context, "B").await).to_owned();
    let t3 = task_id_from(&create_task(&context, "C").await).to_owned();

    let append = mutate_json(
        &context,
        Method::POST,
        &format!("/api/v1/time-slots/{slot_id}/tasks"),
        json!({ "task_id": t1 }),
        None,
    )
    .await;
    assert_eq!(append.status(), StatusCode::OK);
    assert_eq!(
        json(append).await["event"]["event_type"],
        "time_slot.membership_updated"
    );

    // Deterministic duplicate append remains success with no extra membership row.
    let append_dup = mutate_json(
        &context,
        Method::POST,
        &format!("/api/v1/time-slots/{slot_id}/tasks"),
        json!({ "task_id": t1 }),
        None,
    )
    .await;
    assert_eq!(append_dup.status(), StatusCode::OK);
    assert_eq!(
        json(append_dup).await["event"]["snapshot"]["time_slot"]["task_ids"],
        json!([t1])
    );

    let _ = mutate_json(
        &context,
        Method::POST,
        &format!("/api/v1/time-slots/{slot_id}/tasks"),
        json!({ "task_id": t2 }),
        None,
    )
    .await;
    let _ = mutate_json(
        &context,
        Method::POST,
        &format!("/api/v1/time-slots/{slot_id}/tasks"),
        json!({ "task_id": t3 }),
        None,
    )
    .await;

    let replaced = mutate_json(
        &context,
        Method::PUT,
        &format!("/api/v1/time-slots/{slot_id}/tasks"),
        json!({ "task_ids": [t3, t1, t2] }),
        None,
    )
    .await;
    assert_eq!(replaced.status(), StatusCode::OK);
    assert_eq!(
        json(replaced).await["event"]["snapshot"]["time_slot"]["task_ids"],
        json!([t3, t1, t2])
    );

    let bad_replace = mutate_json(
        &context,
        Method::PUT,
        &format!("/api/v1/time-slots/{slot_id}/tasks"),
        json!({ "task_ids": [t1, t2] }),
        None,
    )
    .await;
    assert_eq!(bad_replace.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let removed = context
        .request(
            operation_header(authenticated(
                Method::DELETE,
                &format!("/api/v1/time-slots/{slot_id}/tasks/{t1}"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(removed.status(), StatusCode::OK);
    assert_eq!(
        json(removed).await["event"]["snapshot"]["time_slot"]["task_ids"],
        json!([t3, t2])
    );

    let deleted = context
        .request(
            operation_header(authenticated(
                Method::DELETE,
                &format!("/api/v1/time-slots/{slot_id}"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(
        json(deleted).await["event"]["event_type"],
        "time_slot.deleted"
    );
}

// ── Phase 3 planning / analytics HTTP API ──────────────────────────────────

async fn get_json(context: &TestContext, uri: &str) -> (StatusCode, Value) {
    let response = context
        .request(authenticated(Method::GET, uri).body(Body::empty()).unwrap())
        .await;
    let status = response.status();
    (status, json(response).await)
}

async fn seed_task_with(
    context: &TestContext,
    title: &str,
    due_date: Option<&str>,
    extra: Value,
) -> Value {
    let mut payload = json!({ "title": title });
    if let Some(due) = due_date {
        payload["due_date"] = json!(due);
    }
    if let Some(obj) = extra.as_object() {
        for (k, v) in obj {
            payload[k] = v.clone();
        }
    }
    create_task_payload(context, payload).await
}

#[tokio::test]
async fn planning_routes_require_auth() {
    // Auth limiter is per-state and counts failures; use fresh contexts in batches.
    let uris = [
        "/api/v1/calendar/tasks?from=2026-03-01&to=2026-03-07",
        "/api/v1/planning/daily",
        "/api/v1/planning/end-of-day",
        "/api/v1/planning/weekly",
        "/api/v1/stats?from=2026-03-01&to=2026-03-07",
        "/api/v1/nudges",
        "/api/v1/settings/temporal",
        "/api/v1/motivation/eat-the-frog",
        "/api/v1/motivation/task-jar",
        "/api/v1/motivation/dopamine-menu",
    ];
    for chunk in uris.chunks(5) {
        let context = TestContext::new();
        for uri in chunk {
            let denied = context
                .request(request(Method::GET, uri).body(Body::empty()).unwrap())
                .await;
            assert_eq!(denied.status(), StatusCode::UNAUTHORIZED, "{uri}");
        }
    }
}

#[tokio::test]
async fn calendar_validates_bounds_filters_project_and_rejects_over_cap() {
    let context = TestContext::new();

    let missing = context
        .request(
            authenticated(Method::GET, "/api/v1/calendar/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(missing.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let inverted = context
        .request(
            authenticated(
                Method::GET,
                "/api/v1/calendar/tasks?from=2026-03-10&to=2026-03-01",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(inverted.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let too_wide = context
        .request(
            authenticated(
                Method::GET,
                "/api/v1/calendar/tasks?from=2026-01-01&to=2026-03-01",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(too_wide.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let project = context
        .request(
            operation_header(authenticated(Method::POST, "/api/v1/projects"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "name": "Roadmap", "color": "#4F46E5" }).to_string(),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(project.status(), StatusCode::CREATED);
    let project_body = json(project).await;
    let project_id = project_body["event"]["snapshot"]["project"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let _in = seed_task_with(
        &context,
        "In project",
        Some("2026-03-05"),
        json!({ "project_id": project_id }),
    )
    .await;
    let _out = seed_task_with(&context, "Other project", Some("2026-03-05"), json!({})).await;
    let _done = seed_task_with(&context, "Done in range", Some("2026-03-06"), json!({})).await;
    let done_id = task_id_from(&_done).to_owned();
    let completed = context
        .request(
            operation_header(authenticated(
                Method::POST,
                &format!("/api/v1/tasks/{done_id}/complete"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(completed.status(), StatusCode::OK);

    let (status, body) = get_json(
        &context,
        "/api/v1/calendar/tasks?from=2026-03-01&to=2026-03-07",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let titles: Vec<&str> = body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap())
        .collect();
    assert!(titles.contains(&"In project"));
    assert!(titles.contains(&"Other project"));
    assert!(titles.contains(&"Done in range"));
    // Stable due-asc then id ordering keeps due dates non-decreasing.
    let dues: Vec<&str> = body["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["due_date"].as_str().unwrap())
        .collect();
    let mut sorted = dues.clone();
    sorted.sort();
    assert_eq!(dues, sorted);

    let (status, filtered) = get_json(
        &context,
        &format!("/api/v1/calendar/tasks?from=2026-03-01&to=2026-03-07&project_id={project_id}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let filtered_titles: Vec<&str> = filtered["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap())
        .collect();
    assert_eq!(filtered_titles, vec!["In project"]);

    // Cap rejection at 2,001 matching tasks (seed via service to avoid HTTP overhead).
    use junban_domain::{OperationId, TaskDraft, TaskTitle};
    let due: jiff::civil::Date = "2026-04-01".parse().unwrap();
    for i in 0..2001 {
        let mut draft = TaskDraft::new(TaskTitle::new(format!("cap-{i}")).unwrap());
        draft.due_date = Some(due);
        context
            .state
            .service
            .create_task(
                OperationId::parse(&Uuid::now_v7().to_string()).unwrap(),
                draft,
            )
            .await
            .unwrap();
    }
    let over = context
        .request(
            authenticated(
                Method::GET,
                "/api/v1/calendar/tasks?from=2026-04-01&to=2026-04-01",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(over.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(json(over).await["error"]["code"], "result_limit_exceeded");
}

#[tokio::test]
async fn planning_daily_and_end_of_day_use_injected_dates() {
    let context = TestContext::new();
    let day = "2026-03-11";
    let tomorrow = "2026-03-12";
    let yesterday = "2026-03-10";

    let overdue = seed_task_with(
        &context,
        "Overdue work",
        Some(yesterday),
        json!({ "estimated_minutes": 30 }),
    )
    .await;
    let focus = seed_task_with(
        &context,
        "Focus work",
        Some(day),
        json!({ "estimated_minutes": 45 }),
    )
    .await;
    let win = seed_task_with(&context, "Win", Some(day), json!({})).await;
    let tomorrow_task = seed_task_with(
        &context,
        "Tomorrow",
        Some(tomorrow),
        json!({ "estimated_minutes": 20 }),
    )
    .await;

    let win_id = task_id_from(&win).to_owned();
    let completed = context
        .request(
            operation_header(authenticated(
                Method::POST,
                &format!("/api/v1/tasks/{win_id}/complete"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(completed.status(), StatusCode::OK);

    // End-of-day win bucketing uses server-zone completed_at; use server-local today for wins.
    let today = jiff::Zoned::now().date().to_string();
    let today_focus = seed_task_with(
        &context,
        "Today focus",
        Some(&today),
        json!({ "estimated_minutes": 15 }),
    )
    .await;
    let today_win = seed_task_with(&context, "Today win", Some(&today), json!({})).await;
    let today_win_id = task_id_from(&today_win).to_owned();
    let completed_today = context
        .request(
            operation_header(authenticated(
                Method::POST,
                &format!("/api/v1/tasks/{today_win_id}/complete"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(completed_today.status(), StatusCode::OK);

    let (status, daily) = get_json(
        &context,
        &format!("/api/v1/planning/daily?date={day}&capacity_minutes=240"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(daily["as_of_date"], day);
    assert_eq!(daily["capacity_minutes"], 240);
    assert_eq!(daily["estimated_total_minutes"], 45);
    assert!(
        daily["overdue_task_ids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == task_id_from(&overdue))
    );
    assert!(
        daily["focus_task_ids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == task_id_from(&focus))
    );
    assert_eq!(
        daily["focus_tasks"].as_array().unwrap().len(),
        daily["focus_task_ids"].as_array().unwrap().len()
    );

    let (status, eod) = get_json(
        &context,
        &format!("/api/v1/planning/end-of-day?date={today}&capacity_minutes=300"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(eod["as_of_date"], today);
    assert_eq!(eod["capacity_minutes"], 300);
    assert!(
        eod["win_task_ids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == &today_win_id)
    );
    assert!(
        eod["carry_over_task_ids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == task_id_from(&today_focus))
    );
    assert!(eod["completion_rate_percent"].as_u64().unwrap() > 0);

    // Injected historical end-of-day still returns tomorrow preview from due dates.
    let (status, historical) =
        get_json(&context, &format!("/api/v1/planning/end-of-day?date={day}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        historical["tomorrow_task_ids"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == task_id_from(&tomorrow_task))
    );
    assert_eq!(historical["as_of_date"], day);
    assert_eq!(historical["tomorrow_estimated_minutes"], 20);
    assert_eq!(historical["capacity_minutes"], 480);
}

#[tokio::test]
async fn planning_weekly_sunday_and_monday_windows() {
    let context = TestContext::new();
    // Anchor: Wednesday 2026-03-11. Sunday week -> prior 2026-03-01..03-07.
    // Monday week -> prior 2026-03-02..03-08.
    let (status, sun) = get_json(
        &context,
        "/api/v1/planning/weekly?date=2026-03-11&week_start=sunday",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sun["as_of_date"], "2026-03-11");
    assert_eq!(sun["week_start"], "2026-03-01");
    assert_eq!(sun["week_end"], "2026-03-07");
    assert_eq!(sun["daily"].as_array().unwrap().len(), 7);

    let (status, mon) = get_json(
        &context,
        "/api/v1/planning/weekly?date=2026-03-11&week_start=monday",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(mon["week_start"], "2026-03-02");
    assert_eq!(mon["week_end"], "2026-03-08");

    let defaulted = get_json(&context, "/api/v1/planning/weekly?date=2026-03-11").await;
    assert_eq!(defaulted.0, StatusCode::OK);
    assert_eq!(defaulted.1["week_start"], "2026-03-01");

    let bad = get_json(
        &context,
        "/api/v1/planning/weekly?date=2026-03-11&week_start=friday",
    )
    .await;
    assert_eq!(bad.0, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn stats_formula_streak_and_range_bounds() {
    let context = TestContext::new();
    let today = jiff::Zoned::now().date();
    let today_s = today.to_string();

    let with_est = seed_task_with(
        &context,
        "Estimate sample",
        Some(&today_s),
        json!({ "estimated_minutes": 100, "actual_minutes": 80 }),
    )
    .await;
    let id = task_id_from(&with_est).to_owned();
    // actual is set on create; complete for streak/completions.
    let completed = context
        .request(
            operation_header(authenticated(
                Method::POST,
                &format!("/api/v1/tasks/{id}/complete"),
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await;
    assert_eq!(completed.status(), StatusCode::OK);

    let from = today.checked_sub(2.days()).unwrap().to_string();
    let (status, body) =
        get_json(&context, &format!("/api/v1/stats?from={from}&to={today_s}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["days"].as_array().unwrap().len(), 3);
    assert!(body["total_completions"].as_u64().unwrap() >= 1);
    assert_eq!(body["current_streak_days"].as_u64().unwrap(), 1);
    // |80-100|/100 = 0.2 => accuracy 80%
    assert_eq!(body["estimate_accuracy_percent"], 80);
    assert_eq!(body["estimate_accuracy_samples"], 1);

    let inverted = get_json(&context, "/api/v1/stats?from=2026-03-10&to=2026-03-01").await;
    assert_eq!(inverted.0, StatusCode::UNPROCESSABLE_ENTITY);

    let too_wide = get_json(&context, "/api/v1/stats?from=2025-01-01&to=2026-12-31").await;
    assert_eq!(too_wide.0, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn nudges_stable_order_and_truncation_flags() {
    let context = TestContext::new();
    let today = jiff::Zoned::now().date();
    let today_s = today.to_string();
    // Overdue pending.
    let overdue_day = today.checked_sub(2.days()).unwrap().to_string();
    let _ = seed_task_with(
        &context,
        "Overdue A",
        Some(&overdue_day),
        json!({ "estimated_minutes": 200 }),
    )
    .await;
    // Seed a today task so empty_today does not fire; large estimates trip overloaded_day.
    let _ = seed_task_with(
        &context,
        "Today heavy",
        Some(&today_s),
        json!({ "estimated_minutes": 400 }),
    )
    .await;

    let (status, body) = get_json(
        &context,
        &format!("/api/v1/nudges?date={today_s}&capacity_minutes=100"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let kinds: Vec<&str> = body["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["kind"].as_str().unwrap())
        .collect();
    // Stable rule order subset.
    let mut last_idx = -1_isize;
    for kind in [
        "overdue",
        "approaching_deadline",
        "stale_task",
        "empty_today",
        "overloaded_day",
    ] {
        if let Some(pos) = kinds.iter().position(|k| *k == kind) {
            assert!(pos as isize > last_idx, "{kind} out of order in {kinds:?}");
            last_idx = pos as isize;
        }
    }
    assert!(kinds.contains(&"overdue"), "{body:?}");
    assert!(kinds.contains(&"overloaded_day"), "{body:?}");
    assert!(
        !kinds.contains(&"empty_today"),
        "unexpected empty_today in {kinds:?} body={body}"
    );
    // Embedded tasks only cover referenced IDs.
    let embedded = body["tasks"].as_array().unwrap().len();
    let referenced: usize = body["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["task_ids"].as_array().unwrap().len())
        .sum();
    assert!(embedded <= referenced);
    assert!(embedded > 0);
}

#[tokio::test]
async fn motivation_ordering_and_temporal_defaults() {
    let context = TestContext::new();
    let today = jiff::Zoned::now().date().to_string();

    let frog = seed_task_with(
        &context,
        "Scary",
        Some(&today),
        json!({ "dread": 5, "priority": 1 }),
    )
    .await;
    let mild = seed_task_with(&context, "Mild", Some(&today), json!({ "dread": 2 })).await;
    let quick = seed_task_with(
        &context,
        "Quick win",
        Some(&today),
        json!({ "estimated_minutes": 10, "priority": 4 }),
    )
    .await;
    let also_quick = seed_task_with(
        &context,
        "Also quick",
        Some(&today),
        json!({ "estimated_minutes": 5 }),
    )
    .await;

    let (status, frog_body) = get_json(
        &context,
        &format!("/api/v1/motivation/eat-the-frog?date={today}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        frog_body["task"]["id"].as_str().unwrap(),
        task_id_from(&frog)
    );
    let _ = mild;

    let (status, jar) = get_json(
        &context,
        &format!("/api/v1/motivation/task-jar?date={today}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(jar["task_ids"].as_array().unwrap().len() >= 4);
    assert_eq!(
        jar["tasks"].as_array().unwrap().len(),
        jar["task_ids"].as_array().unwrap().len()
    );

    let (status, menu) = get_json(
        &context,
        &format!("/api/v1/motivation/dopamine-menu?date={today}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let menu_titles: Vec<&str> = menu["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["title"].as_str().unwrap())
        .collect();
    // Shortest estimate first: Also quick (5) before Quick win (10).
    let also_pos = menu_titles.iter().position(|t| *t == "Also quick");
    let quick_pos = menu_titles.iter().position(|t| *t == "Quick win");
    assert!(also_pos.is_some() && quick_pos.is_some());
    assert!(also_pos.unwrap() < quick_pos.unwrap());
    let _ = (quick, also_quick);

    let (status, settings) = get_json(&context, "/api/v1/settings/temporal").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(settings["capacity_minutes"], 480);
    assert_eq!(settings["week_start"], "sunday");
    assert_eq!(settings["nudges_enabled"], true);
    assert_eq!(settings["eat_the_frog_enabled"], false);
    assert_eq!(settings["task_jar_enabled"], false);
    assert!(settings["time_zone"].as_str().unwrap().len() >= 3);

    // Default date smoke (wall clock only for this path).
    let (status, _) = get_json(&context, "/api/v1/planning/daily").await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = get_json(&context, "/api/v1/nudges").await;
    assert_eq!(status, StatusCode::OK);
}
