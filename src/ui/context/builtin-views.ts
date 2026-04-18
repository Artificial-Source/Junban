/**
 * Client-side component resolver for built-in React plugin views.
 * In Vite dev mode, the REST API can't serialize React components.
 * This module lazily creates proxy-backed React components.
 *
 * New built-in plugins register via registerBuiltinComponent() instead of
 * adding hardcoded branches here.
 */
import React from "react";
import type { ComponentType } from "react";
import type TimeblockingPlugin from "../../plugins/builtin/timeblocking/index.js";

type BuiltinViewProps = Record<string, unknown>;
type BuiltinViewComponent = ComponentType<BuiltinViewProps>;

// Cache resolved components to avoid re-creating on every call
const cachedComponents = new Map<string, (props: BuiltinViewProps) => React.ReactNode>();
// Cache in-flight component resolutions to avoid duplicate factory execution
const pendingComponents = new Map<string, Promise<(props: BuiltinViewProps) => React.ReactNode>>();

/**
 * Registry of factory functions that lazily create React components
 * for built-in plugins. Each factory is called at most once (result cached).
 */
const builtinComponentFactories = new Map<string, () => Promise<BuiltinViewComponent>>();

/**
 * Register a built-in plugin's React component factory.
 * The factory is called lazily on first resolve and the result is cached.
 */

export function registerBuiltinComponent(
  pluginId: string,
  factory: () => Promise<BuiltinViewComponent>,
): void {
  builtinComponentFactories.set(pluginId, factory);
}

/**
 * Resolve a built-in React component for a plugin view.
 * Returns null if the pluginId has no registered factory.
 */

export async function resolveBuiltinComponent(
  pluginId: string,
): Promise<((props: BuiltinViewProps) => React.ReactNode) | null> {
  if (cachedComponents.has(pluginId)) {
    return cachedComponents.get(pluginId)!;
  }

  if (pendingComponents.has(pluginId)) {
    return pendingComponents.get(pluginId)!;
  }

  const factory = builtinComponentFactories.get(pluginId);
  if (!factory) {
    return null;
  }

  const pendingComponent = (async () => {
    try {
      const Component = await factory();
      const wrapper = (props: BuiltinViewProps) => React.createElement(Component, props);
      cachedComponents.set(pluginId, wrapper);
      return wrapper;
    } finally {
      pendingComponents.delete(pluginId);
    }
  })();

  pendingComponents.set(pluginId, pendingComponent);
  return pendingComponent;
}

// ---------------------------------------------------------------------------
// Register built-in plugin factories
// ---------------------------------------------------------------------------

// Cache the proxy so it's created only once
let cachedTimeblockingProxy: unknown = null;
let cachedTimeblockingProxyPending: Promise<unknown> | null = null;

registerBuiltinComponent("timeblocking", async () => {
  const [{ createTimeblockingProxy }, { TimeblockingContext }, { TimeblockingView }] =
    await Promise.all([
      import("../../plugins/builtin/timeblocking/web-proxy.js"),
      import("../../plugins/builtin/timeblocking/context.js"),
      import("../../plugins/builtin/timeblocking/components/TimeblockingView.js"),
    ]);

  if (!cachedTimeblockingProxy) {
    if (!cachedTimeblockingProxyPending) {
      cachedTimeblockingProxyPending = createTimeblockingProxy().finally(() => {
        cachedTimeblockingProxyPending = null;
      });
    }
    cachedTimeblockingProxy = await cachedTimeblockingProxyPending;
  }

  return () =>
    React.createElement(
      TimeblockingContext.Provider,
      { value: cachedTimeblockingProxy as TimeblockingPlugin },
      React.createElement(TimeblockingView),
    );
});

registerBuiltinComponent("stats", async () => {
  const { StatsPluginView } = await import("../../plugins/builtin/stats/view.js");
  return StatsPluginView;
});

registerBuiltinComponent("someday", async () => {
  const { SomedayPluginView } = await import("../../plugins/builtin/someday/view.js");
  return SomedayPluginView;
});

registerBuiltinComponent("completed", async () => {
  const { CompletedPluginView } = await import("../../plugins/builtin/completed/view.js");
  return CompletedPluginView;
});

registerBuiltinComponent("cancelled", async () => {
  const { CancelledPluginView } = await import("../../plugins/builtin/cancelled/view.js");
  return CancelledPluginView;
});

registerBuiltinComponent("matrix", async () => {
  const { MatrixPluginView } = await import("../../plugins/builtin/matrix/view.js");
  return MatrixPluginView;
});

registerBuiltinComponent("calendar", async () => {
  const { CalendarPluginView } = await import("../../plugins/builtin/calendar/view.js");
  return CalendarPluginView;
});

registerBuiltinComponent("dopamine-menu", async () => {
  const { DopamineMenuPluginView } = await import("../../plugins/builtin/dopamine-menu/view.js");
  return DopamineMenuPluginView;
});
