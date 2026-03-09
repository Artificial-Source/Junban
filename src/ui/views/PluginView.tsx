import { useState, useEffect, useRef, useCallback, Component, type ReactNode, type ErrorInfo } from "react";
import { api } from "../api/index.js";
import {
  StructuredContentRenderer,
  type StructuredContent,
} from "../components/StructuredContentRenderer.js";
import type { ViewInfo } from "../api/plugins.js";

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
  const mountedRef = useRef(true);
  const isStructured = viewInfo?.contentType === "structured";
  const isReact = viewInfo?.contentType === "react";

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

  if (isReact && viewInfo?.component) {
    const PluginComponent = viewInfo.component;
    return (
      <PluginErrorBoundary pluginId={viewInfo.pluginId}>
        <PluginComponent />
      </PluginErrorBoundary>
    );
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
