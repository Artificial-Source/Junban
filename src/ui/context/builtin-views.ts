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

// Cache resolved components to avoid re-creating on every call
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cachedComponents = new Map<string, (props: any) => any>();

/**
 * Registry of factory functions that lazily create React components
 * for built-in plugins. Each factory is called at most once (result cached).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const builtinComponentFactories = new Map<string, () => Promise<ComponentType<any>>>();

/**
 * Register a built-in plugin's React component factory.
 * The factory is called lazily on first resolve and the result is cached.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerBuiltinComponent(
  pluginId: string,
  factory: () => Promise<ComponentType<any>>,
): void {
  builtinComponentFactories.set(pluginId, factory);
}

/**
 * Resolve a built-in React component for a plugin view.
 * Returns null if the pluginId has no registered factory.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveBuiltinComponent(
  pluginId: string,
): Promise<((props: any) => any) | null> {
  if (cachedComponents.has(pluginId)) {
    return cachedComponents.get(pluginId)!;
  }

  const factory = builtinComponentFactories.get(pluginId);
  if (!factory) {
    return null;
  }

  const Component = await factory();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapper = (props: any) => React.createElement(Component, props);
  cachedComponents.set(pluginId, wrapper);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Register built-in plugin factories
// ---------------------------------------------------------------------------

// Cache the proxy so it's created only once
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedTimeblockingProxy: any = null;

registerBuiltinComponent("timeblocking", async () => {
  const [{ createTimeblockingProxy }, { TimeblockingContext }, { TimeblockingView }] =
    await Promise.all([
      import("../../plugins/builtin/timeblocking/web-proxy.js"),
      import("../../plugins/builtin/timeblocking/context.js"),
      import("../../plugins/builtin/timeblocking/components/TimeblockingView.js"),
    ]);

  if (!cachedTimeblockingProxy) {
    cachedTimeblockingProxy = await createTimeblockingProxy();
  }

  return () =>
    React.createElement(
      TimeblockingContext.Provider,
      { value: cachedTimeblockingProxy },
      React.createElement(TimeblockingView),
    );
});
