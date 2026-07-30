//! In-process router tests for the Phase 2 HTTP/SSE surface.

use std::{
    convert::Infallible,
    env, fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::atomic::Ordering,
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
use junban_app::{EventType, ResourceRef, ResyncScope};
use junban_domain::{OperationId, TaskId};
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
            "junban-server-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
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
    // Drive the current-thread runtime until the coordinator publishes.
    for _ in 0..50 {
        tokio::select! {
            biased;
            result = wakes.recv() => return result.expect("wake channel"),
            () = tokio::task::yield_now() => {}
        }
    }
    // Final blocking recv with paused-time timeout as a safety net.
    tokio::time::timeout(Duration::from_secs(5), wakes.recv())
        .await
        .expect("timed out waiting for reminder wake")
        .expect("wake channel closed")
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
