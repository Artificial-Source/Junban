import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api/index.js";
import {
  StructuredContentRenderer,
  type StructuredContent,
} from "../components/StructuredContentRenderer.js";
import { PluginErrorBoundary } from "../components/sidebar/PluginErrorBoundary.js";
import type { ViewInfo } from "../api/plugins.js";
import { resolveBuiltinComponent } from "../context/builtin-views.js";

interface PluginViewProps {
  viewId: string;
  viewInfo?: ViewInfo;
}

export function PluginView({ viewId, viewInfo }: PluginViewProps) {
  const [content, setContent] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [resolvedComponent, setResolvedComponent] = useState<((props: any) => any) | null>(null);
  const mountedRef = useRef(true);
  const isStructured = viewInfo?.contentType === "structured";
  const isReact = viewInfo?.contentType === "react";

  // Lazily resolve built-in React components that couldn't be serialized via REST.
  // Retries with exponential backoff since the plugin server may not be ready yet.
  const [resolveError, setResolveError] = useState<string | null>(null);
  useEffect(() => {
    if (!isReact || viewInfo?.component) return;
    if (!viewInfo?.pluginId) return;

    const MAX_RETRIES = 10;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let retryCount = 0;

    const attempt = () => {
      resolveBuiltinComponent(viewInfo.pluginId)
        .then((component) => {
          if (!cancelled && component) {
            setResolvedComponent(() => component);
          } else if (!cancelled && !component) {
            retryCount++;
            if (retryCount >= MAX_RETRIES) {
              setResolveError(
                `Plugin "${viewInfo.pluginId}" component could not be resolved after ${MAX_RETRIES} attempts.`,
              );
              return;
            }
            const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 16000);
            retryTimer = setTimeout(attempt, delay);
          }
        })
        .catch(() => {
          if (cancelled) return;
          retryCount++;
          if (retryCount >= MAX_RETRIES) {
            setResolveError(
              `Plugin "${viewInfo.pluginId}" component failed to load after ${MAX_RETRIES} attempts.`,
            );
            return;
          }
          const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 16000);
          retryTimer = setTimeout(attempt, delay);
        });
    };
    attempt();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [isReact, viewInfo?.component, viewInfo?.pluginId]);

  useEffect(() => {
    // Don't poll for content when rendering a React component
    if (isReact) return;

    mountedRef.current = true;

    const fetchContent = async () => {
      try {
        const text = await api.getPluginViewContent(viewId);
        if (mountedRef.current) setContent(text);
      } catch {
        // Non-critical
      }
    };

    fetchContent();
    // Structured views poll faster (timers need responsive updates)
    const interval = setInterval(fetchContent, isStructured ? 500 : 1000);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [viewId, isStructured, isReact]);

  const handleCommand = useCallback(async (commandId: string) => {
    await api.executePluginCommand(commandId);
  }, []);

  // React view with component from Tauri mode or resolved built-in
  const PluginComponent = viewInfo?.component ?? resolvedComponent;
  if (isReact && PluginComponent) {
    return (
      <PluginErrorBoundary pluginId={viewInfo!.pluginId}>
        <PluginComponent />
      </PluginErrorBoundary>
    );
  }

  // React view failed to resolve after max retries
  if (isReact && !PluginComponent && resolveError) {
    return <div className="p-6 text-error text-sm">{resolveError}</div>;
  }

  // React view still loading its component
  if (isReact && !PluginComponent) {
    return <div className="p-6 text-on-surface-muted text-sm">Loading plugin view...</div>;
  }

  if (isStructured) {
    let parsed: StructuredContent | null = null;
    try {
      parsed = JSON.parse(content) as StructuredContent;
    } catch {
      // Content isn't valid JSON yet — show nothing while loading
    }

    if (!parsed) {
      return <div className="p-6 text-on-surface-muted text-sm">Loading...</div>;
    }

    return (
      <div className="p-6 max-w-lg mx-auto">
        <StructuredContentRenderer content={parsed} onCommand={handleCommand} />
      </div>
    );
  }

  return (
    <div>
      <pre className="whitespace-pre-wrap text-sm text-on-surface-secondary font-mono">
        {content}
      </pre>
    </div>
  );
}

export { PluginErrorBoundary };
