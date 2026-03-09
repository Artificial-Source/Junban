/**
 * Client-side component resolver for built-in React plugin views.
 * In Vite dev mode, the REST API can't serialize React components.
 * This module lazily creates proxy-backed React components.
 */
import React from "react";

// Cache proxy instances to avoid re-creating on every call
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedTimeblockingProxy: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cachedComponents = new Map<string, (props: any) => any>();

/**
 * Resolve a built-in React component for a plugin view.
 * Returns null if the pluginId has no built-in React component.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveBuiltinComponent(pluginId: string): Promise<((props: any) => any) | null> {
  if (cachedComponents.has(pluginId)) {
    return cachedComponents.get(pluginId)!;
  }

  if (pluginId === "timeblocking") {
    const component = await createTimeblockingComponent();
    cachedComponents.set(pluginId, component);
    return component;
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createTimeblockingComponent(): Promise<(props: any) => any> {
  // Dynamic imports to avoid bundling when not needed
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
}
