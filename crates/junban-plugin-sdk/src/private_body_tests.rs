use proptest::prelude::*;

use super::*;
use crate::{
    private_body_types::*,
    util::{hex, sha256},
};

const SESSION: &str = "00000000-0000-4000-8000-000000000001";
const INVOCATION: &str = "00000000-0000-4000-8000-000000000002";
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn fence() -> AuthorityFence {
    AuthorityFence {
        plugin_id: "test-plugin".into(),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: INVOCATION.into(),
    }
}

fn callback() -> CallbackFence {
    CallbackFence {
        plugin_id: "test-plugin".into(),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: INVOCATION.into(),
        callback_id: 1,
    }
}

fn plugin_error() -> PluginError {
    PluginError {
        code: ErrorCode::InvalidInput,
        field: None,
        message: "bad".into(),
    }
}

fn host_error() -> HostError {
    HostError {
        code: ErrorCode::Unavailable,
        field: None,
        message: "later".into(),
    }
}

fn http_error() -> HttpError {
    HttpError {
        code: HttpErrorCode::Timeout,
        delivery: DeliveryState::NotSent,
        retryable: true,
        message: "later".into(),
    }
}

fn byte_vector() -> ByteList {
    ByteList::new(vec![0xfb, 0xff]).unwrap()
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
        limit: 1,
    }
}

fn assert_parent_golden(
    message: TypedParentMessage,
    expected_body: &str,
    expected_hash: &str,
) -> ParentFrame {
    assert_eq!(message.body(), expected_body.as_bytes());
    let (frame, body) = message.into_parts();
    let (size, hash) = match &frame {
        ParentFrame::Invoke {
            request_size,
            request_sha256,
            ..
        } => (*request_size, request_sha256),
        ParentFrame::CapabilityReply {
            response_size,
            response_sha256,
            ..
        } => (*response_size, response_sha256),
        _ => panic!("typed parent body used a bodyless frame"),
    };
    assert_eq!(size as usize, expected_body.len());
    assert_eq!(hash, expected_hash);
    assert_eq!(hex(&sha256(expected_body.as_bytes())), expected_hash);
    validate_parent_body(&frame, &body).unwrap();
    frame
}

fn assert_child_golden(
    message: TypedChildMessage,
    expected_body: &str,
    expected_hash: &str,
) -> ChildFrame {
    assert_eq!(message.body(), expected_body.as_bytes());
    let (frame, body) = message.into_parts();
    let (size, hash) = match &frame {
        ChildFrame::CapabilityRequest {
            request_size,
            request_sha256,
            ..
        } => (*request_size, request_sha256),
        ChildFrame::Outcome {
            outcome_size,
            outcome_sha256,
            ..
        } => (*outcome_size, outcome_sha256),
        _ => panic!("typed child body used a bodyless frame"),
    };
    assert_eq!(size as usize, expected_body.len());
    assert_eq!(hash, expected_hash);
    assert_eq!(hex(&sha256(expected_body.as_bytes())), expected_hash);
    validate_child_body(&frame, &body).unwrap();
    frame
}

#[test]
fn generated_wit_identity_context_and_all_invocation_requests_have_goldens() {
    assert_eq!(GENERATED_WIT_SHA256, hex(&sha256(WIT_SOURCE.as_bytes())));
    assert_eq!(
        GENERATED_WIT_SHA256,
        "5705801973219a0e6981693653f2caefdf1090345b65494750c8d8a9bf4b15f4"
    );

    let requests = [
        (
            InvocationRequest::activate(None),
            r#"{"tag":"activate","val":{"entry-id":null,"argument":null}}"#,
            "7ff4622b19bb0c110396c79d00294e20274aa77ccb9505147a2b46d22798b165",
        ),
        (
            InvocationRequest::deactivate(Some("entry".into())),
            r#"{"tag":"deactivate","val":{"entry-id":"entry","argument":null}}"#,
            "f593b478992d312eced837bdea56eab66d9c8ff1a06f0650b56309af6313f23b",
        ),
        (
            InvocationRequest::invoke_command(
                Some("command".into()),
                CommandCall {
                    command_id: "command".into(),
                    values: Vec::new(),
                },
            ),
            r#"{"tag":"invoke-command","val":{"entry-id":"command","argument":{"command-id":"command","values":[]}}}"#,
            "930335acf8507ff3ae513df4b9e6da0327c3be04f3b3617b3761921fe5dec301",
        ),
        (
            InvocationRequest::handle_event(
                Some("event".into()),
                EventEnvelope {
                    event_epoch: "epoch".into(),
                    revision: 7,
                    kind: private_body_types::EventKind::TaskDeleted,
                    subject: EventSubject::DeletedTask("task-1".into()),
                },
            ),
            r#"{"tag":"handle-event","val":{"entry-id":"event","argument":{"event-epoch":"epoch","revision":7,"kind":"task-deleted","subject":{"tag":"deleted-task","val":"task-1"}}}}"#,
            "d3c91aabee44dc2c04c613d58eb4347c62a7d7b046fa9b752eec26f22ba44836",
        ),
        (
            InvocationRequest::render_surface(
                Some("surface".into()),
                SurfaceRequest {
                    surface_id: "surface".into(),
                },
            ),
            r#"{"tag":"render-surface","val":{"entry-id":"surface","argument":{"surface-id":"surface"}}}"#,
            "9d3547ba4d56cfd9f2633e2c60d8517870a6334255ad02e17d0c5dbbc199d222",
        ),
        (
            InvocationRequest::handle_surface_action(
                Some("action".into()),
                SurfaceAction {
                    surface_id: "surface".into(),
                    action_id: "action".into(),
                    values: Vec::new(),
                },
            ),
            r#"{"tag":"handle-surface-action","val":{"entry-id":"action","argument":{"surface-id":"surface","action-id":"action","values":[]}}}"#,
            "138af91e0719bba09a0d7040506ef2fc5aa7ba6a18219689178e840397052fd7",
        ),
        (
            InvocationRequest::validate_settings(None, SettingValues { values: Vec::new() }),
            r#"{"tag":"validate-settings","val":{"entry-id":null,"argument":{"values":[]}}}"#,
            "0a0de7b709951c81809833bf4243cfe112a1d28f344ea16903205262f3e581cc",
        ),
        (
            InvocationRequest::resync(
                Some("resync".into()),
                ResyncPage::Finalize(FinalizeResync {
                    session_id: "session".into(),
                }),
            ),
            r#"{"tag":"resync","val":{"entry-id":"resync","argument":{"tag":"finalize","val":{"session-id":"session"}}}}"#,
            "a3410b5239bd29cfc9b34f5ee09adcb5f931c4da100671cf44fc101ef255961b",
        ),
        (
            InvocationRequest::call_service(
                Some("service".into()),
                ServiceCall {
                    plugin_id: "dependency".into(),
                    service_id: "service".into(),
                    values: Vec::new(),
                },
            ),
            r#"{"tag":"call-service","val":{"entry-id":"service","argument":{"plugin-id":"dependency","service-id":"service","values":[]}}}"#,
            "df10dfe50beb6a25c2d185752a8951b164356be3fb4ba2a56cd36d2a4a19d6a1",
        ),
    ];

    for (request, body, hash) in requests {
        let expected_kind = request.kind();
        let expected_entry = request.entry_id().map(str::to_owned);
        let context = request.context(&fence()).unwrap();
        assert_eq!(context.plugin_id, "test-plugin");
        assert_eq!(context.package_generation, 7);
        assert_eq!(context.activation_epoch, 9);
        assert_eq!(context.host_session_id, SESSION);
        assert_eq!(context.invocation_id, INVOCATION);
        assert_eq!(context.entry_id, expected_entry);

        let frame = assert_parent_golden(
            request
                .into_parent_message(fence(), canonical_permission_hash(&[]).unwrap())
                .unwrap(),
            body,
            hash,
        );
        assert!(matches!(
            frame,
            ParentFrame::Invoke { kind, mode, .. }
                if kind == expected_kind && mode == expected_kind.mode()
        ));
    }
}

#[test]
fn every_invocation_success_and_guest_error_branch_has_a_golden() {
    let success = [
        (
            InvocationOutcome::Activate(WitResult::Ok(())),
            r#"{"tag":"activate","val":{"tag":"ok","val":null}}"#,
            "286c4496db0cae5f84aedcaedc9a54eaa04d9145780ee1cc80950230b8069767",
        ),
        (
            InvocationOutcome::Deactivate(WitResult::Ok(())),
            r#"{"tag":"deactivate","val":{"tag":"ok","val":null}}"#,
            "cb21dd1a6ff3d13719c7a4596f41d476a05acd01738c4948fc8bfc9b8f6b3af1",
        ),
        (
            InvocationOutcome::InvokeCommand(WitResult::Ok(PluginOutcome { effect: None })),
            r#"{"tag":"invoke-command","val":{"tag":"ok","val":{"effect":null}}}"#,
            "c37eda5d4b399458de170415c05fa7febda0ff32913b26b7979221786ff973ec",
        ),
        (
            InvocationOutcome::HandleEvent(WitResult::Ok(PluginOutcome { effect: None })),
            r#"{"tag":"handle-event","val":{"tag":"ok","val":{"effect":null}}}"#,
            "2bc0c8f6a27f388cb7906e2b7f3da17a5040a701ba6ade7ce898bbd91d807332",
        ),
        (
            InvocationOutcome::RenderSurface(WitResult::Ok(Surface {
                surface_id: "surface".into(),
                root_index: 0,
                nodes: Vec::new(),
            })),
            r#"{"tag":"render-surface","val":{"tag":"ok","val":{"surface-id":"surface","root-index":0,"nodes":[]}}}"#,
            "4093ba2d885556107945744128164708f35798f77634ef49b99dc28ce479f1e0",
        ),
        (
            InvocationOutcome::HandleSurfaceAction(WitResult::Ok(PluginOutcome { effect: None })),
            r#"{"tag":"handle-surface-action","val":{"tag":"ok","val":{"effect":null}}}"#,
            "3cafc1f1d4d6248550e1dd454f45d2eadc8c90ccf9a2e36daff91e0fdecddc09",
        ),
        (
            InvocationOutcome::ValidateSettings(WitResult::Ok(Vec::new())),
            r#"{"tag":"validate-settings","val":{"tag":"ok","val":[]}}"#,
            "4f1d30a16468071d0a3ab420c9baa900e88b9d1463a002f8fe6cf9c89e1c6c87",
        ),
        (
            InvocationOutcome::Resync(WitResult::Ok(ResyncPageOutcome::Finalized(
                FinalizedResync {
                    session_id: "session".into(),
                    choice: FinalKvChoice::LeaveKv,
                },
            ))),
            r#"{"tag":"resync","val":{"tag":"ok","val":{"tag":"finalized","val":{"session-id":"session","choice":"leave-kv"}}}}"#,
            "60cb74db1c45bcf87c8ec27c1ea512347c772cac1a8a05807cdb44e213871047",
        ),
        (
            InvocationOutcome::CallService(WitResult::Ok(ServiceData { values: Vec::new() })),
            r#"{"tag":"call-service","val":{"tag":"ok","val":{"values":[]}}}"#,
            "99819c0f0227eae7611faf2068c6b4bf83cd117ea89e5ba4401951a70c63d7df",
        ),
    ];
    let errors = [
        (
            InvocationOutcome::Activate(WitResult::Err(plugin_error())),
            r#"{"tag":"activate","val":{"tag":"err","val":{"code":"invalid-input","field":null,"message":"bad"}}}"#,
            "ea173f0a19bf439f736d3c8fbea95b315fb357b5772738da251b0093e3d6b32a",
        ),
        (
            InvocationOutcome::Deactivate(WitResult::Err(plugin_error())),
            r#"{"tag":"deactivate","val":{"tag":"err","val":{"code":"invalid-input","field":null,"message":"bad"}}}"#,
            "ffae081f616957472ee85edc8dcf478a03538392f95462ec4c62790017e1404c",
        ),
        (
            InvocationOutcome::InvokeCommand(WitResult::Err(plugin_error())),
            r#"{"tag":"invoke-command","val":{"tag":"err","val":{"code":"invalid-input","field":null,"message":"bad"}}}"#,
            "1a54df727cb98f60786860eb81f7337c30aeb680eb34de07ea8d8695ece399c3",
        ),
        (
            InvocationOutcome::HandleEvent(WitResult::Err(plugin_error())),
            r#"{"tag":"handle-event","val":{"tag":"err","val":{"code":"invalid-input","field":null,"message":"bad"}}}"#,
            "933f8d3acca6aa4862f77483e4269486b9e5d5a5b708b7f342e9c4318bfd07ee",
        ),
        (
            InvocationOutcome::RenderSurface(WitResult::Err(plugin_error())),
            r#"{"tag":"render-surface","val":{"tag":"err","val":{"code":"invalid-input","field":null,"message":"bad"}}}"#,
            "2bde935c0dfa8145694bc255a5afda7ee2e038c56072414f91c5bc03d312a90c",
        ),
        (
            InvocationOutcome::HandleSurfaceAction(WitResult::Err(plugin_error())),
            r#"{"tag":"handle-surface-action","val":{"tag":"err","val":{"code":"invalid-input","field":null,"message":"bad"}}}"#,
            "f6239fac292de146b42c7482175b772eeaca1be7e7d7521a0fd970811d74f541",
        ),
        (
            InvocationOutcome::ValidateSettings(WitResult::Err(plugin_error())),
            r#"{"tag":"validate-settings","val":{"tag":"err","val":{"code":"invalid-input","field":null,"message":"bad"}}}"#,
            "f8a3c04e5b36e0578fa854591c6e3e0d156fdd01e6c0feb6561c924706dfe642",
        ),
        (
            InvocationOutcome::Resync(WitResult::Err(plugin_error())),
            r#"{"tag":"resync","val":{"tag":"err","val":{"code":"invalid-input","field":null,"message":"bad"}}}"#,
            "9d59a7ecac9f7c7d3a1904bce907be36030ef0ed3fd1c87437005a67abacaafa",
        ),
        (
            InvocationOutcome::CallService(WitResult::Err(plugin_error())),
            r#"{"tag":"call-service","val":{"tag":"err","val":{"code":"invalid-input","field":null,"message":"bad"}}}"#,
            "e8e69e8b7ea9eada47f36514eaf365c9ba3714539f4e58f8930de893bf90e522",
        ),
    ];

    for (outcome, body, hash) in success.into_iter().chain(errors) {
        let expected_kind = outcome.kind();
        let frame = assert_child_golden(outcome.into_child_message(fence()).unwrap(), body, hash);
        assert!(matches!(
            frame,
            ChildFrame::Outcome { kind, .. } if kind == expected_kind
        ));
    }
}

#[test]
fn every_host_request_success_allowed_error_and_cancel_has_a_golden() {
    let requests = [
        (
            HostCallRequest::QueryTasks(task_query()),
            r#"{"tag":"query-tasks","val":{"task-id":null,"project-id":null,"section-id":null,"parent-id":null,"tag-ids":[],"statuses":[],"priorities":[],"due-from":null,"due-before":null,"search":null,"cursor":null,"limit":1}}"#,
            "4d184de8d0094b5189e34757ce50affb4a6f729ba2a29bceedf833e28731c9a7",
        ),
        (
            HostCallRequest::QueryProjects(CatalogQuery {
                cursor: None,
                limit: 1,
            }),
            r#"{"tag":"query-projects","val":{"cursor":null,"limit":1}}"#,
            "5580bb5fcfb7b4ee662ecd86c6b4be42b704dc0cccca00ec2c887f3feac9dbdd",
        ),
        (
            HostCallRequest::QueryTags(CatalogQuery {
                cursor: Some("next".into()),
                limit: 2,
            }),
            r#"{"tag":"query-tags","val":{"cursor":"next","limit":2}}"#,
            "e76bf3b487d5c8090ba44caecf196dc41f3eae1c88ac57939063efc922f099ca",
        ),
        (
            HostCallRequest::GetSettings(()),
            r#"{"tag":"get-settings","val":null}"#,
            "5fec639d592ceaaaac56dabceb10cbe65175e85dd9dadcf8b8b783b4d008c6b7",
        ),
        (
            HostCallRequest::GetKv(vec!["key".into()]),
            r#"{"tag":"get-kv","val":["key"]}"#,
            "7276f23925d6590408a4685913f2489c4e37b4f095401701d7e00b1cd839a3f7",
        ),
        (
            HostCallRequest::ListKv(HostStorageListKvArguments {
                cursor: None,
                limit: 1,
            }),
            r#"{"tag":"list-kv","val":{"cursor":null,"limit":1}}"#,
            "8372cff9df80e4b373cd68220fb931fc0a5a851fa66fc61488e4f54ade3400e7",
        ),
        (
            HostCallRequest::WallNow(()),
            r#"{"tag":"wall-now","val":null}"#,
            "5dbb42483a1593f07df85a016fbba4cc40a97c2d7f5949288825ab1c06cb5a30",
        ),
        (
            HostCallRequest::MonotonicMs(()),
            r#"{"tag":"monotonic-ms","val":null}"#,
            "871d79d264226e363202d8ef1597b996681f771b818e89d1c1802c4ea518d300",
        ),
        (
            HostCallRequest::HttpRequest(HttpRequest {
                method: private_body_types::HttpMethod::Post,
                origin: "https://example.com".into(),
                path_and_query: "/path".into(),
                headers: Vec::new(),
                body: byte_vector(),
            }),
            r#"{"tag":"http-request","val":{"method":"post","origin":"https://example.com","path-and-query":"/path","headers":[],"body":"-_8"}}"#,
            "37b1d7e5216a5b034eaaff04b5cae752597890c8a1312d9650a48c9cb25ae4a5",
        ),
        (
            HostCallRequest::Log(HostLogLogArguments {
                level: LogLevel::Info,
                message: "message".into(),
                fields: Vec::new(),
            }),
            r#"{"tag":"log","val":{"level":"info","message":"message","fields":[]}}"#,
            "36c2a78890131a833ae0a6fe4acb05a7a5bdb839129916dcf4c8b6c66a4f9ba1",
        ),
        (
            HostCallRequest::CallService(ServiceCall {
                plugin_id: "dependency".into(),
                service_id: "service".into(),
                values: Vec::new(),
            }),
            r#"{"tag":"call-service","val":{"plugin-id":"dependency","service-id":"service","values":[]}}"#,
            "77db0b45b9579e9400d223dd3b0f54a33d02eaadb0cde9fbfabcb6abae816af8",
        ),
    ];
    for (request, body, hash) in requests {
        let expected_kind = request.kind();
        let frame =
            assert_child_golden(request.into_child_message(callback()).unwrap(), body, hash);
        assert!(matches!(
            frame,
            ChildFrame::CapabilityRequest { kind, .. } if kind == expected_kind
        ));
    }

    let successes = [
        (
            HostCallReply::QueryTasks(WitResult::Ok(TaskPage {
                items: Vec::new(),
                next_cursor: None,
                revision: 7,
            })),
            r#"{"tag":"query-tasks","val":{"tag":"ok","val":{"items":[],"next-cursor":null,"revision":7}}}"#,
            "e8b28f7d06fbaad72a03b183a4ccac686c4b9497286b57f0e11ad862811236f8",
        ),
        (
            HostCallReply::QueryProjects(WitResult::Ok(ProjectPage {
                items: Vec::new(),
                next_cursor: None,
                revision: 7,
            })),
            r#"{"tag":"query-projects","val":{"tag":"ok","val":{"items":[],"next-cursor":null,"revision":7}}}"#,
            "936bd679f1ba1d705f04abf80da89c0b58c4235a11d542f60c7c2931aa405615",
        ),
        (
            HostCallReply::QueryTags(WitResult::Ok(TagPage {
                items: Vec::new(),
                next_cursor: None,
                revision: 7,
            })),
            r#"{"tag":"query-tags","val":{"tag":"ok","val":{"items":[],"next-cursor":null,"revision":7}}}"#,
            "c1c6ecb76d877bb91e8d33d01bff67c2568b8616d3c820bf34c560a502f5431d",
        ),
        (
            HostCallReply::GetSettings(WitResult::Ok(Vec::new())),
            r#"{"tag":"get-settings","val":{"tag":"ok","val":[]}}"#,
            "2e4903688897b313211c411e41cfd0e3d717a592d149c5bb37c73868f0c27350",
        ),
        (
            HostCallReply::GetKv(WitResult::Ok(vec![KvEntry {
                key: "key".into(),
                value: byte_vector(),
            }])),
            r#"{"tag":"get-kv","val":{"tag":"ok","val":[{"key":"key","value":"-_8"}]}}"#,
            "d10a208f11bed6c62e603aaedeb5b197ac55863bcca0f455faad32aa1f0f09b6",
        ),
        (
            HostCallReply::ListKv(WitResult::Ok(KvPage {
                entries: Vec::new(),
                next_cursor: None,
            })),
            r#"{"tag":"list-kv","val":{"tag":"ok","val":{"entries":[],"next-cursor":null}}}"#,
            "32bddb995109c1561de6afd9b335a4dd08c099ae4c3b494bedfd57d2ac3f76a7",
        ),
        (
            HostCallReply::WallNow("2030-01-02T03:04:05Z".into()),
            r#"{"tag":"wall-now","val":"2030-01-02T03:04:05Z"}"#,
            "8f805d98763e3c352cc8ab125760039ad0b37204317f7f3862a59b68ffb05132",
        ),
        (
            HostCallReply::MonotonicMs(9),
            r#"{"tag":"monotonic-ms","val":9}"#,
            "554ae4066853a60750ea523a1081a5623a748d76b6d948add9a29971b823448a",
        ),
        (
            HostCallReply::HttpRequest(WitResult::Ok(HttpResponse {
                status: 200,
                headers: Vec::new(),
                body: byte_vector(),
                truncated: false,
            })),
            r#"{"tag":"http-request","val":{"tag":"ok","val":{"status":200,"headers":[],"body":"-_8","truncated":false}}}"#,
            "8f7779e48a55566c57e8f084414b3db701a48c47e66b564a0a010326ceab28c3",
        ),
        (
            HostCallReply::Log(()),
            r#"{"tag":"log","val":null}"#,
            "00e9311be676dffb6eb4d4200887ff0b1809c3bf0f2c7cb499a11f2a6356ce1d",
        ),
        (
            HostCallReply::CallService(WitResult::Ok(ServiceData { values: Vec::new() })),
            r#"{"tag":"call-service","val":{"tag":"ok","val":{"values":[]}}}"#,
            "99819c0f0227eae7611faf2068c6b4bf83cd117ea89e5ba4401951a70c63d7df",
        ),
    ];
    for (reply, body, hash) in successes {
        let kind = reply.kind();
        assert_eq!(reply.branch(), CapabilityReplyKind::Success);
        let frame =
            assert_parent_golden(reply.into_parent_message(callback()).unwrap(), body, hash);
        assert!(matches!(
            frame,
            ParentFrame::CapabilityReply {
                kind: actual,
                result: CapabilityReplyKind::Success,
                ..
            } if actual == kind
        ));
    }

    let errors = [
        (
            HostCallReply::QueryTasks(WitResult::Err(host_error())),
            r#"{"tag":"query-tasks","val":{"tag":"err","val":{"code":"unavailable","field":null,"message":"later"}}}"#,
            "eaa64fa8923cfcfb59fa0d5c6d4b95959e183fea1bee72171f228c27df68204e",
        ),
        (
            HostCallReply::QueryProjects(WitResult::Err(host_error())),
            r#"{"tag":"query-projects","val":{"tag":"err","val":{"code":"unavailable","field":null,"message":"later"}}}"#,
            "8906b41e0d10fe696d662c85c30b0dcfe25bacc79406676fecd5088f09495c9b",
        ),
        (
            HostCallReply::QueryTags(WitResult::Err(host_error())),
            r#"{"tag":"query-tags","val":{"tag":"err","val":{"code":"unavailable","field":null,"message":"later"}}}"#,
            "17b27acab66e49ef9521f00757976175a5a2c890b071cca846a7b338fbe10939",
        ),
        (
            HostCallReply::GetSettings(WitResult::Err(host_error())),
            r#"{"tag":"get-settings","val":{"tag":"err","val":{"code":"unavailable","field":null,"message":"later"}}}"#,
            "1ec94a36f141ec3c2a526e7bc54f75088f8d04fa893b1390f0172d987c1a8622",
        ),
        (
            HostCallReply::GetKv(WitResult::Err(host_error())),
            r#"{"tag":"get-kv","val":{"tag":"err","val":{"code":"unavailable","field":null,"message":"later"}}}"#,
            "65c19a70966f769f639c5c266fd88d9b28eaf119cbbce54f58cbd099a1283058",
        ),
        (
            HostCallReply::ListKv(WitResult::Err(host_error())),
            r#"{"tag":"list-kv","val":{"tag":"err","val":{"code":"unavailable","field":null,"message":"later"}}}"#,
            "f62bb0ba5281b77e17a9469f32c14892b4295f6518c4a2b47e7809f566c1133e",
        ),
        (
            HostCallReply::HttpRequest(WitResult::Err(http_error())),
            r#"{"tag":"http-request","val":{"tag":"err","val":{"code":"timeout","delivery":"not-sent","retryable":true,"message":"later"}}}"#,
            "be6a78a75211b64bed330f621305e2a2c438752ca3fe8563f1d817a1cee00170",
        ),
        (
            HostCallReply::CallService(WitResult::Err(host_error())),
            r#"{"tag":"call-service","val":{"tag":"err","val":{"code":"unavailable","field":null,"message":"later"}}}"#,
            "d706a573255d233c2afa3c72e9c0eb1e91a50f362c7f0cfc91dce9046a9c8e80",
        ),
    ];
    for (reply, body, hash) in errors {
        let kind = reply.kind();
        assert_eq!(reply.branch(), CapabilityReplyKind::Error);
        let frame =
            assert_parent_golden(reply.into_parent_message(callback()).unwrap(), body, hash);
        assert!(matches!(
            frame,
            ParentFrame::CapabilityReply {
                kind: actual,
                result: CapabilityReplyKind::Error,
                ..
            } if actual == kind
        ));
    }

    for kind in HOST_CALL_KINDS {
        let message = HostCallReply::Cancelled(*kind)
            .into_parent_message(callback())
            .unwrap();
        assert!(message.body().is_empty());
        let (frame, body) = message.into_parts();
        assert!(body.is_empty());
        assert!(matches!(
            &frame,
            ParentFrame::CapabilityReply {
                kind: actual,
                result: CapabilityReplyKind::Cancelled,
                response_sha256,
                response_size: 0,
                ..
            } if actual == kind && response_sha256 == EMPTY_SHA256
        ));
        validate_parent_body(&frame, &body).unwrap();
    }
}

fn invoke_frame(kind: InvocationKind, body: &[u8]) -> ParentFrame {
    ParentFrame::Invoke {
        fence: fence(),
        kind,
        mode: kind.mode(),
        permission_hash: canonical_permission_hash(&[]).unwrap(),
        request_sha256: hex(&sha256(body)),
        request_size: body.len() as u32,
    }
}

fn outcome_frame(kind: InvocationKind, body: &[u8]) -> ChildFrame {
    ChildFrame::Outcome {
        fence: fence(),
        kind,
        outcome_sha256: hex(&sha256(body)),
        outcome_size: body.len() as u32,
    }
}

fn host_request_frame(kind: HostCallKind, body: &[u8]) -> ChildFrame {
    ChildFrame::CapabilityRequest {
        callback: callback(),
        kind,
        request_sha256: hex(&sha256(body)),
        request_size: body.len() as u32,
    }
}

fn host_reply_frame(kind: HostCallKind, result: CapabilityReplyKind, body: &[u8]) -> ParentFrame {
    ParentFrame::CapabilityReply {
        callback: callback(),
        kind,
        result,
        response_sha256: hex(&sha256(body)),
        response_size: body.len() as u32,
    }
}

#[test]
fn canonical_decoder_rejects_structural_kind_branch_byte_and_numeric_alternates() {
    let malformed_invocations = [
        br#"{"tag":"activate","val":{"entry-id":null,"argument":null,"unknown":true}}"#.as_slice(),
        br#"{"tag":"activate","val":{"entry-id":null,"entry-id":null,"argument":null}}"#,
        br#"{"tag":"activate","val":{"argument":null}}"#,
        br#"{"tag":"activate","val":{"argument":null,"entry-id":null}}"#,
        br#"{ "tag":"activate","val":{"entry-id":null,"argument":null}}"#,
        br#"{"tag":"activate","val":{"entry-id":null,"argument":null},"extra":null}"#,
        br#"{"tag":"unknown","val":{"entry-id":null,"argument":null}}"#,
        br#"{"tag":"activate","val":{"entry-id":null,"argument":null}}trailing"#,
    ];
    for body in malformed_invocations {
        assert!(validate_parent_body(&invoke_frame(InvocationKind::Activate, body), body).is_err());
    }

    let activate = br#"{"tag":"activate","val":{"entry-id":null,"argument":null}}"#;
    assert!(
        validate_parent_body(
            &invoke_frame(InvocationKind::Deactivate, activate),
            activate
        )
        .is_err()
    );
    let wrong_result = br#"{"tag":"activate","val":{"tag":"ok","val":{}}}"#;
    assert!(
        validate_child_body(
            &outcome_frame(InvocationKind::Activate, wrong_result),
            wrong_result
        )
        .is_err()
    );

    let task_with_omitted_option = br#"{"tag":"query-tasks","val":{"project-id":null,"section-id":null,"parent-id":null,"tag-ids":[],"statuses":[],"priorities":[],"due-from":null,"due-before":null,"search":null,"cursor":null,"limit":1}}"#;
    assert!(
        validate_child_body(
            &host_request_frame(HostCallKind::QueryTasks, task_with_omitted_option),
            task_with_omitted_option
        )
        .is_err()
    );
    let function_arguments_with_omitted_option = br#"{"tag":"list-kv","val":{"limit":1}}"#;
    assert!(
        validate_child_body(
            &host_request_frame(HostCallKind::ListKv, function_arguments_with_omitted_option),
            function_arguments_with_omitted_option
        )
        .is_err()
    );
    let omitted_unit = br#"{"tag":"get-settings"}"#;
    assert!(
        validate_child_body(
            &host_request_frame(HostCallKind::GetSettings, omitted_unit),
            omitted_unit
        )
        .is_err()
    );

    let canonical_http = br#"{"tag":"http-request","val":{"method":"post","origin":"https://example.com","path-and-query":"/path","headers":[],"body":"-_8"}}"#;
    validate_child_body(
        &host_request_frame(HostCallKind::HttpRequest, canonical_http),
        canonical_http,
    )
    .unwrap();
    for alternate in [
        br#"{"tag":"http-request","val":{"method":"post","origin":"https://example.com","path-and-query":"/path","headers":[],"body":"-_8="}}"#.as_slice(),
        br#"{"tag":"http-request","val":{"method":"post","origin":"https://example.com","path-and-query":"/path","headers":[],"body":"+/8"}}"#,
        br#"{"tag":"http-request","val":{"method":"post","origin":"https://example.com","path-and-query":"/path","headers":[],"body":[251,255]}}"#,
    ] {
        assert!(
            validate_child_body(
                &host_request_frame(HostCallKind::HttpRequest, alternate),
                alternate
            )
            .is_err()
        );
    }

    let maximum = br#"{"tag":"monotonic-ms","val":18446744073709551615}"#;
    validate_parent_body(
        &host_reply_frame(
            HostCallKind::MonotonicMs,
            CapabilityReplyKind::Success,
            maximum,
        ),
        maximum,
    )
    .unwrap();
    for alternate in [
        br#"{"tag":"monotonic-ms","val":18446744073709551616}"#.as_slice(),
        br#"{"tag":"monotonic-ms","val":1.0}"#,
        br#"{"tag":"monotonic-ms","val":1e0}"#,
        br#"{"tag":"monotonic-ms","val":-0}"#,
    ] {
        assert!(
            validate_parent_body(
                &host_reply_frame(
                    HostCallKind::MonotonicMs,
                    CapabilityReplyKind::Success,
                    alternate,
                ),
                alternate
            )
            .is_err()
        );
    }

    let signed_minimum = br#"{"tag":"log","val":{"level":"info","message":"m","fields":[{"name":"n","value":{"tag":"integer-value","val":-9223372036854775808}}]}}"#;
    validate_child_body(
        &host_request_frame(HostCallKind::Log, signed_minimum),
        signed_minimum,
    )
    .unwrap();
    let signed_overflow = br#"{"tag":"log","val":{"level":"info","message":"m","fields":[{"name":"n","value":{"tag":"integer-value","val":-9223372036854775809}}]}}"#;
    assert!(
        validate_child_body(
            &host_request_frame(HostCallKind::Log, signed_overflow),
            signed_overflow
        )
        .is_err()
    );

    let error_reply = HostCallReply::QueryTasks(WitResult::Err(host_error()))
        .into_parent_message(callback())
        .unwrap();
    let (mut wrong_branch, error_body) = error_reply.into_parts();
    if let ParentFrame::CapabilityReply { result, .. } = &mut wrong_branch {
        *result = CapabilityReplyKind::Success;
    }
    assert!(validate_parent_body(&wrong_branch, &error_body).is_err());

    for kind in [
        HostCallKind::WallNow,
        HostCallKind::MonotonicMs,
        HostCallKind::Log,
    ] {
        let body = br#"{"tag":"log","val":null}"#;
        assert!(
            validate_parent_frame(&host_reply_frame(kind, CapabilityReplyKind::Error, body))
                .is_err()
        );
    }

    let cancelled_with_body = host_reply_frame(
        HostCallKind::QueryTasks,
        CapabilityReplyKind::Cancelled,
        b"null",
    );
    assert!(validate_parent_body(&cancelled_with_body, b"null").is_err());

    let oversized_typed = HostCallRequest::HttpRequest(HttpRequest {
        method: private_body_types::HttpMethod::Post,
        origin: "https://example.com".into(),
        path_and_query: "/path".into(),
        headers: Vec::new(),
        body: ByteList::new(vec![0; HOST_CALLBACK_BODY_BYTES_MAX]).unwrap(),
    });
    assert!(matches!(
        oversized_typed.into_child_message(callback()),
        Err(SdkError::Protocol {
            field: "body length"
        })
    ));

    let oversized = vec![b' '; HOST_CALLBACK_BODY_BYTES_MAX + 1];
    assert!(decode_host_call_request(HostCallKind::Log, &oversized).is_err());
    let oversized_frame = ChildFrame::CapabilityRequest {
        callback: callback(),
        kind: HostCallKind::Log,
        request_sha256: "0".repeat(64),
        request_size: HOST_CALLBACK_BODY_BYTES_MAX as u32 + 1,
    };
    assert!(validate_child_body(&oversized_frame, &[]).is_err());
}

proptest! {
    #[test]
    fn bounded_private_body_decoders_never_panic(
        body in proptest::collection::vec(any::<u8>(), 0..8192)
    ) {
        for kind in [
            InvocationKind::Activate,
            InvocationKind::Deactivate,
            InvocationKind::InvokeCommand,
            InvocationKind::HandleEvent,
            InvocationKind::RenderSurface,
            InvocationKind::HandleSurfaceAction,
            InvocationKind::ValidateSettings,
            InvocationKind::Resync,
            InvocationKind::CallService,
        ] {
            let _ = decode_invocation_request(kind, &body);
            let _ = decode_invocation_outcome(kind, &body);
        }
        for kind in HOST_CALL_KINDS {
            let _ = decode_host_call_request(*kind, &body);
            let _ = decode_host_call_reply(*kind, CapabilityReplyKind::Success, &body);
            let _ = decode_host_call_reply(*kind, CapabilityReplyKind::Error, &body);
            let _ = decode_host_call_reply(*kind, CapabilityReplyKind::Cancelled, &body);
        }
    }
}
