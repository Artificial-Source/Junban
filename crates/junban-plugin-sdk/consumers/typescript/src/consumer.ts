import { getSettings } from "junban:plugin/host-settings@0.1.0";
import type * as T from "junban:plugin/types@0.1.0";

const CALIBRATION_WORKING_SET_BYTES = 64 * 1024 * 1024;
let calibrationSink = 0;

/** Exact `TaskDraft::new` defaults, before host/domain validation. */
function newTaskDraft(title: string): T.TaskDraft {
  return {
    title,
    description: "",
    priority: undefined,
    dueDate: undefined,
    dueTime: undefined,
    deadline: undefined,
    someday: false,
    estimatedMinutes: undefined,
    actualMinutes: undefined,
    dread: undefined,
    projectId: undefined,
    sectionId: undefined,
    parentId: undefined,
    tagIds: [],
    sortOrder: 0n,
    recurrenceRule: undefined,
    remindAt: undefined,
    recurrenceAnchorDay: undefined,
  };
}

/** Compile-time/public-binding exercise, including every change distinction. */
function exercisePublicTypes(): void {
  const due: T.LocalDueTime = { time: "09:30:00", timeZone: "Europe/London" };
  const three = <V>(value: V) => [
    { tag: "unchanged" } as const,
    { tag: "clear" } as const,
    { tag: "set", val: value } as const,
  ];
  const stringChanges: T.OptionalStringChange[] = three("value");
  const idChanges: T.OptionalIdChange[] = three("id");
  const dateChanges: T.OptionalDateChange[] = three("2026-08-04");
  const timestampChanges: T.OptionalTimestampChange[] = three("2026-08-04T00:00:00Z");
  const dueTimeChanges: T.OptionalLocalDueTimeChange[] = three(due);
  const u32Changes: T.OptionalU32Change[] = three(1);
  const u8Changes: T.OptionalU8Change[] = three(1);
  const priorityChanges: T.OptionalPriorityChange[] = three("p1" as T.Priority);
  const patch: T.TaskPatch = {
    title: { tag: "unchanged" },
    description: { tag: "set", val: "" },
    priority: priorityChanges[2]!,
    dueDate: dateChanges[1]!,
    dueTime: dueTimeChanges[2]!,
    deadline: timestampChanges[0]!,
    someday: { tag: "set", val: false },
    estimatedMinutes: u32Changes[0]!,
    actualMinutes: u32Changes[1]!,
    dread: u8Changes[2]!,
    projectId: idChanges[0]!,
    sectionId: idChanges[1]!,
    parentId: idChanges[2]!,
    tagIds: { tag: "replace", val: [] },
    sortOrder: { tag: "set", val: 0n },
    recurrenceRule: stringChanges[1]!,
    remindAt: timestampChanges[2]!,
    recurrenceAnchorDay: u8Changes[1]!,
  };
  const actions: T.BulkAction[] = [
    { tag: "complete" },
    { tag: "uncomplete" },
    { tag: "cancel" },
    { tag: "reopen" },
    { tag: "delete" },
    {
      tag: "move",
      val: { projectId: idChanges[0]!, sectionId: idChanges[1]!, parentId: idChanges[2]! },
    },
    { tag: "tag", val: { add: [], remove: [] } },
    {
      tag: "schedule",
      val: {
        dueDate: dateChanges[0]!,
        dueTime: dueTimeChanges[1]!,
        deadline: timestampChanges[2]!,
        someday: { tag: "unchanged" },
      },
    },
    { tag: "priority", val: { tag: "clear" } },
    { tag: "priority", val: { tag: "set", val: "p4" } },
  ];
  const views: T.ProjectView[] = ["list", "board", "calendar"];
  const priorities: Array<T.Priority | undefined> = [undefined, "p1", "p2", "p3", "p4"];
  const snapshots: T.SnapshotRecords[] = [
    { tag: "tasks", val: [] },
    { tag: "projects", val: [] },
    { tag: "tags", val: [] },
  ];
  const scalars: T.ScalarValue[] = [
    { tag: "string-value", val: "" },
    { tag: "integer-value", val: 0n },
    { tag: "boolean-value", val: false },
    { tag: "date-value", val: "2026-08-04" },
    { tag: "timestamp-value", val: "2026-08-04T00:00:00Z" },
    { tag: "task-id", val: "task" },
    { tag: "project-id", val: "project" },
    { tag: "tag-id", val: "tag" },
    { tag: "plugin-id", val: "plugin" },
    { tag: "option-id", val: "option" },
  ];
  const data: T.DataValue[] = [
    { tag: "scalar", val: scalars[0]! },
    { tag: "string-list", val: [] },
    { tag: "integer-list", val: new BigInt64Array() },
    { tag: "boolean-list", val: [] },
    { tag: "date-list", val: [] },
    { tag: "timestamp-list", val: [] },
    { tag: "task-id-list", val: [] },
    { tag: "project-id-list", val: [] },
    { tag: "tag-id-list", val: [] },
    { tag: "plugin-id-list", val: [] },
    { tag: "option-id-list", val: [] },
  ];
  const draft = newTaskDraft("task");
  const projectDraft: T.ProjectDraft = {
    name: "project",
    color: "#000000",
    favorite: false,
    archived: false,
    view: "list",
    sortOrder: 0n,
  };
  const projectPatch: T.ProjectPatch = {
    name: { tag: "unchanged" },
    color: { tag: "set", val: "#000000" },
    icon: stringChanges[1]!,
    parentId: idChanges[0]!,
    favorite: { tag: "unchanged" },
    archived: { tag: "set", val: false },
    view: { tag: "set", val: "calendar" },
    sortOrder: { tag: "unchanged" },
  };
  const tagDraft: T.TagDraft = { name: "tag", color: "#000000" };
  const tagPatch: T.TagPatch = {
    name: { tag: "unchanged" },
    color: { tag: "set", val: "#000000" },
  };
  const mutations: T.DomainMutation[] = [
    { tag: "create-task", val: draft },
    { tag: "patch-task", val: { taskId: "task", patch } },
    { tag: "complete-task", val: "task" },
    { tag: "uncomplete-task", val: "task" },
    { tag: "cancel-task", val: "task" },
    { tag: "reopen-task", val: "task" },
    { tag: "delete-task", val: "task" },
    { tag: "bulk-tasks", val: { taskIds: ["task"], action: actions[0]! } },
    { tag: "create-project", val: projectDraft },
    { tag: "patch-project", val: { projectId: "project", patch: projectPatch } },
    { tag: "delete-project", val: "project" },
    { tag: "create-tag", val: tagDraft },
    { tag: "patch-tag", val: { tagId: "tag", patch: tagPatch } },
    { tag: "delete-tag", val: "tag" },
  ];
  const taskView: T.TaskView = {
    id: "task",
    title: "task",
    description: "",
    status: "pending",
    someday: false,
    tagIds: [],
    sortOrder: 0n,
    createdAt: "2026-08-04T00:00:00Z",
    updatedAt: "2026-08-04T00:00:00Z",
    revision: 1n,
  };
  const projectView: T.ProjectViewRecord = {
    id: "project",
    name: "project",
    color: "#000000",
    favorite: false,
    archived: false,
    view: "list",
    sortOrder: 0n,
    createdAt: taskView.createdAt,
    updatedAt: taskView.updatedAt,
    revision: 1n,
  };
  const tagView: T.TagView = {
    id: "tag",
    name: "tag",
    color: "#000000",
    createdAt: taskView.createdAt,
    updatedAt: taskView.updatedAt,
    revision: 1n,
  };
  const sectionView: T.SectionView = {
    id: "section",
    projectId: "project",
    name: "section",
    collapsed: false,
    sortOrder: 0n,
    createdAt: taskView.createdAt,
    updatedAt: taskView.updatedAt,
    revision: 1n,
  };
  const subjects: T.EventSubject[] = [
    { tag: "task", val: taskView },
    { tag: "project", val: projectView },
    { tag: "tag", val: tagView },
    { tag: "section", val: sectionView },
    { tag: "deleted-task", val: "task" },
    { tag: "deleted-project", val: "project" },
    { tag: "deleted-tag", val: "tag" },
    { tag: "deleted-section", val: "section" },
  ];
  const text = { text: "", tone: "neutral" as const, size: "small" as const };
  const contents: T.UiContent[] = [
    { tag: "stack", val: { gap: 0, align: "start" } },
    { tag: "row", val: { gap: 0, align: "center" } },
    { tag: "heading", val: text },
    { tag: "text", val: text },
    { tag: "badge", val: text },
    { tag: "metric", val: { label: "", value: "", tone: "neutral" } },
    { tag: "progress", val: { label: "", value: 0, maximum: 1 } },
    { tag: "button", val: { label: "", actionId: "action", tone: "accent" } },
    { tag: "text-input", val: { label: "", actionId: "action", value: scalars[0]!, options: [] } },
    {
      tag: "number-input",
      val: { label: "", actionId: "action", value: scalars[1]!, options: [] },
    },
    { tag: "select", val: { label: "", actionId: "action", value: scalars[9]!, options: [] } },
    { tag: "toggle", val: { label: "", actionId: "action", value: scalars[2]!, options: [] } },
    { tag: "task-list", val: { taskIds: [] } },
    { tag: "task-ref", val: "task" },
    { tag: "divider" },
    { tag: "empty-state", val: text },
    { tag: "error-state", val: text },
  ];
  const settings: T.SettingValue[] = [
    { tag: "text", val: "" },
    { tag: "integer", val: 0n },
    { tag: "boolean", val: false },
    { tag: "option-id", val: "option" },
  ];
  const effects: T.PluginEffect[] = [
    { tag: "domain-mutation", val: mutations[0]! },
    {
      tag: "kv-patch",
      val: {
        operations: [
          { tag: "set", val: { key: "key", value: new Uint8Array() } },
          { tag: "delete", val: "old" },
        ],
      },
    },
  ];
  const errors: [T.HostError, T.PluginError, T.HttpError] = [
    { code: "cancelled", message: "" },
    { code: "invalid-input", field: "title", message: "" },
    { code: "delivery-ambiguous", delivery: "may-have-been-sent", retryable: false, message: "" },
  ];
  const pages = [
    { items: [taskView], revision: 1n } satisfies T.TaskPage,
    { items: [projectView], revision: 1n } satisfies T.ProjectPage,
    { items: [tagView], revision: 1n } satisfies T.TagPage,
    { entries: [{ key: "key", value: new Uint8Array() }] } satisfies T.KvPage,
  ];
  void [
    draft,
    patch,
    actions,
    views,
    priorities,
    snapshots,
    scalars,
    data,
    mutations,
    subjects,
    contents,
    settings,
    effects,
    errors,
    pages,
  ];
}

let activationCount = 0n;

function spin(): never {
  let value = 1n;
  while (true) {
    value = BigInt.asUintN(64, value * 6364136223846793005n + 1n);
  }
}

function calibrationWorkingSetBarrier(): void {
  const bytes = new Uint8Array(CALIBRATION_WORKING_SET_BYTES);
  for (let offset = 0; offset < bytes.length; offset += 4 * 1024) {
    bytes[offset] = (offset / (4 * 1024)) & 0xff;
  }
  getSettings();
  calibrationSink ^= bytes[bytes.length - 4 * 1024]!;
}

export const guest = {
  activate(_context: T.InvocationContext): void {
    exercisePublicTypes();
    activationCount += 1n;
  },
  deactivate(_context: T.InvocationContext): void {},
  invokeCommand(_context: T.InvocationContext, call: T.CommandCall): T.PluginOutcome {
    if (call.commandId === "guest-error") {
      throw {
        code: "invalid-input",
        field: "command-id",
        message: "retained fixture guest error",
      } satisfies T.PluginError;
    }
    if (call.commandId === "trap") {
      throw new Error("retained TypeScript hostile trap marker");
    }
    if (call.commandId === "spin") {
      spin();
    }
    if (call.commandId === "memory-calibration-barrier") {
      calibrationWorkingSetBarrier();
      return {};
    }
    if (call.commandId === "oversized-output") {
      return {
        effect: {
          tag: "kv-patch",
          val: {
            operations: [
              {
                tag: "set",
                val: { key: "oversized", value: new Uint8Array(300 * 1024) },
              },
            ],
          },
        },
      };
    }
    return {};
  },
  handleEvent(_context: T.InvocationContext, event: T.EventEnvelope): T.PluginOutcome {
    if (event.eventEpoch === "spin") {
      spin();
    }
    return {};
  },
  renderSurface(_context: T.InvocationContext, request: T.SurfaceRequest): T.Surface {
    return {
      surfaceId: request.surfaceId,
      rootIndex: 0,
      nodes: [{ id: "root", content: { tag: "stack", val: { gap: 0, align: "start" } } }],
    };
  },
  handleSurfaceAction(_context: T.InvocationContext, _action: T.SurfaceAction): T.PluginOutcome {
    return {};
  },
  validateSettings(_context: T.InvocationContext, _values: T.SettingValues): T.ValidationIssue[] {
    return [];
  },
  resync(_context: T.InvocationContext, page: T.ResyncPage): T.ResyncPageOutcome {
    switch (page.tag) {
      case "snapshot":
        return {
          tag: "snapshot-ack",
          val: {
            sessionId: page.val.sessionId,
            pageIndex: page.val.pageIndex,
            kind: page.val.kind,
          },
        };
      case "flush-staged-kv":
        return {
          tag: "flush-ack",
          val: {
            sessionId: page.val.sessionId,
            requestIndex: page.val.requestIndex,
            state: "complete",
          },
        };
      case "finalize":
        return { tag: "finalized", val: { sessionId: page.val.sessionId, choice: "leave-kv" } };
    }
  },
  callService(_context: T.InvocationContext, _call: T.ServiceCall): T.ServiceData {
    return {
      values: [
        {
          name: "activation-count",
          value: {
            tag: "scalar",
            val: { tag: "integer-value", val: activationCount },
          },
        },
      ],
    };
  },
} satisfies typeof import("junban:plugin/guest@0.1.0");
