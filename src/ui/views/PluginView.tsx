import { useState, useEffect, useRef, useCallback, Component, type ReactNode, type ErrorInfo } from "react";
import { api } from "../api/index.js";
import {
  StructuredContentRenderer,
  type StructuredContent,
} from "../components/StructuredContentRenderer.js";
import type { ViewInfo } from "../api/plugins.js";
import { resolveBuiltinComponent } from "../context/builtin-views.js";

interface PluginErrorBoundaryProps {
  pluginId: string;
  children: ReactNode;
}

interface PluginErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class PluginErrorBoundary extends Component<PluginErrorBoundaryProps, PluginErrorBoundaryState> {
  constructor(props: PluginErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): PluginErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Plugin "${this.props.pluginId}" crashed:`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="p-6 text-red-500 text-sm">
          <p className="font-semibold">Plugin Error</p>
          <p className="mt-1 text-on-surface-muted">
            The plugin &quot;{this.props.pluginId}&quot; encountered an error and was disabled.
          </p>
          <pre className="mt-2 text-xs bg-surface-secondary p-2 rounded overflow-auto">
            {this.state.error?.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

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
  // Retries on failure since the plugin server may not be ready yet.
  useEffect(() => {
    if (!isReact || viewInfo?.component) return;
    if (!viewInfo?.pluginId) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    const attempt = () => {
      resolveBuiltinComponent(viewInfo.pluginId).then((component) => {
        if (!cancelled && component) {
          setResolvedComponent(() => component);
        } else if (!cancelled && !component) {
          retryTimer = setTimeout(attempt, 1000);
        }
      }).catch(() => {
        if (!cancelled) retryTimer = setTimeout(attempt, 1000);
      });
    };
    attempt();

    return () => { cancelled = true; clearTimeout(retryTimer); };
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
