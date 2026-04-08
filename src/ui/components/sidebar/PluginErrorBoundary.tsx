import { Component, type ErrorInfo, type ReactNode } from "react";

interface PluginErrorBoundaryProps {
  pluginId: string;
  children: ReactNode;
}

interface PluginErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class PluginErrorBoundary extends Component<
  PluginErrorBoundaryProps,
  PluginErrorBoundaryState
> {
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
          <pre className="mt-2 overflow-auto rounded bg-surface-secondary p-2 text-xs">
            {this.state.error?.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
