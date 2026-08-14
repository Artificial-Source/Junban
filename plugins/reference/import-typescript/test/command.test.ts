import type * as T from "junban:plugin/types@0.1.0";
import { buildBulkCompleteOutcome } from "../src/plugin.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function taskId(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function callWith(taskIds: string[]): T.CommandCall {
  return {
    commandId: "bulk-complete",
    values: [{ name: "task-ids", value: { tag: "task-id-list", val: taskIds } }],
  };
}

function rejects(call: T.CommandCall, field: string): void {
  try {
    buildBulkCompleteOutcome(call);
  } catch (error: unknown) {
    const pluginError = error as Partial<T.PluginError>;
    assert(
      pluginError.code === "invalid-input",
      `expected invalid-input, received ${pluginError.code}`,
    );
    assert(pluginError.field === field, `expected ${field}, received ${pluginError.field}`);
    return;
  }
  throw new Error("expected command mapping to reject input");
}

const first = taskId(1);
const second = taskId(2);
const outcome = buildBulkCompleteOutcome(callWith([first, second]));
assert(
  JSON.stringify(outcome) ===
    JSON.stringify({
      effect: {
        tag: "domain-mutation",
        val: {
          tag: "bulk-tasks",
          val: { taskIds: [first, second], action: { tag: "complete" } },
        },
      },
    }),
  "valid command did not map to the exact bulk complete mutation",
);

rejects(callWith([]), "task-ids");
rejects(callWith([first, first]), "task-ids");
rejects(callWith(Array.from({ length: 501 }, (_, index) => taskId(index + 1))), "task-ids");
rejects({ commandId: "bulk-delete", values: callWith([first]).values }, "command-id");
rejects({ commandId: "bulk-complete", values: [] }, "task-ids");
rejects(
  {
    commandId: "bulk-complete",
    values: [{ name: "tasks", value: { tag: "task-id-list", val: [first] } }],
  },
  "task-ids",
);
rejects(
  {
    commandId: "bulk-complete",
    values: [{ name: "task-ids", value: { tag: "string-list", val: [first] } }],
  },
  "task-ids",
);
rejects(callWith(["not-a-canonical-task-id"]), "task-ids");
