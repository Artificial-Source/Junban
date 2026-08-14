import type * as T from "junban:plugin/types@0.1.0";

const BULK_COMPLETE_COMMAND = "bulk-complete";
const TASK_IDS_INPUT = "task-ids";
const TASK_IDS_MAX = 500;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function pluginError(code: T.ErrorCode, field: string, message: string): T.PluginError {
  return { code, field, message };
}

/** Pure command mapping retained as the source-level unit-test boundary. */
export function buildBulkCompleteOutcome(call: T.CommandCall): T.PluginOutcome {
  if (call.commandId !== BULK_COMPLETE_COMMAND) {
    throw pluginError("invalid-input", "command-id", "Expected the bulk-complete command.");
  }

  if (call.values.length !== 1) {
    throw pluginError("invalid-input", TASK_IDS_INPUT, "Expected exactly one task-ids input.");
  }
  const input = call.values[0]!;
  if (input.name !== TASK_IDS_INPUT || input.value.tag !== "task-id-list") {
    throw pluginError("invalid-input", TASK_IDS_INPUT, "Expected a typed task-id-list input.");
  }

  const taskIds = input.value.val;
  if (taskIds.length === 0 || taskIds.length > TASK_IDS_MAX) {
    throw pluginError("invalid-input", TASK_IDS_INPUT, "Expected between 1 and 500 task IDs.");
  }

  const unique = new Set<string>();
  for (const taskId of taskIds) {
    if (!CANONICAL_UUID.test(taskId)) {
      throw pluginError("invalid-input", TASK_IDS_INPUT, "Expected canonical task IDs.");
    }
    if (unique.has(taskId)) {
      throw pluginError("invalid-input", TASK_IDS_INPUT, "Task IDs must be unique.");
    }
    unique.add(taskId);
  }

  return {
    effect: {
      tag: "domain-mutation",
      val: {
        tag: "bulk-tasks",
        val: {
          taskIds: [...taskIds],
          action: { tag: "complete" },
        },
      },
    },
  };
}

export const guest = {
  activate(_context: T.InvocationContext): void {},

  deactivate(_context: T.InvocationContext): void {},

  invokeCommand(_context: T.InvocationContext, call: T.CommandCall): T.PluginOutcome {
    return buildBulkCompleteOutcome(call);
  },

  handleEvent(_context: T.InvocationContext, _event: T.EventEnvelope): T.PluginOutcome {
    return {};
  },

  renderSurface(_context: T.InvocationContext, _request: T.SurfaceRequest): T.Surface {
    throw pluginError("not-found", "surface-id", "This plugin declares no surfaces.");
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
        return {
          tag: "finalized",
          val: {
            sessionId: page.val.sessionId,
            choice: "leave-kv",
          },
        };
    }
  },

  callService(_context: T.InvocationContext, _call: T.ServiceCall): T.ServiceData {
    return { values: [] };
  },
} satisfies typeof import("junban:plugin/guest@0.1.0");
