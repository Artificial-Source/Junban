import type * as T from "junban:plugin/types@0.1.0";

/**
 * Non-shipped, capability-free guest used only to preserve the frozen
 * standalone TypeScript memory profile in the Slice 2E calibration.
 */
export const guest = {
  activate(_context: T.InvocationContext): void {},
  deactivate(_context: T.InvocationContext): void {},
  invokeCommand(_context: T.InvocationContext, _call: T.CommandCall): T.PluginOutcome {
    return {};
  },
  handleEvent(_context: T.InvocationContext, _event: T.EventEnvelope): T.PluginOutcome {
    return {};
  },
  renderSurface(_context: T.InvocationContext, request: T.SurfaceRequest): T.Surface {
    return {
      surfaceId: request.surfaceId,
      rootIndex: 0,
      nodes: [{ id: "root", content: { tag: "stack", val: { gap: 0, align: "start" } } }],
    };
  },
  handleSurfaceAction(
    _context: T.InvocationContext,
    _action: T.SurfaceAction,
  ): T.PluginOutcome {
    return {};
  },
  validateSettings(
    _context: T.InvocationContext,
    _values: T.SettingValues,
  ): T.ValidationIssue[] {
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
    return { values: [] };
  },
} satisfies typeof import("junban:plugin/guest@0.1.0");
