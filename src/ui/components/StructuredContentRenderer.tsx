import { api } from "../api/index.js";

// ── Element types ──

interface TextElement {
  type: "text";
  value: string;
  variant?: "title" | "subtitle" | "body" | "caption" | "mono";
}

interface BadgeElement {
  type: "badge";
  value: string;
  color?: "default" | "accent" | "success" | "warning" | "error";
}

interface ProgressElement {
  type: "progress";
  value: number;
  max: number;
  label?: string;
  color?: "accent" | "success" | "warning" | "error";
}

interface ButtonElement {
  type: "button";
  label: string;
  commandId: string;
  variant?: "primary" | "secondary" | "ghost";
}

interface DividerElement {
  type: "divider";
}

interface RowElement {
  type: "row";
  elements: UIElement[];
  gap?: "sm" | "md" | "lg";
  justify?: "start" | "center" | "end" | "between";
}

interface SpacerElement {
  type: "spacer";
  size?: "sm" | "md" | "lg";
}

export type UIElement =
  | TextElement
  | BadgeElement
  | ProgressElement
  | ButtonElement
  | DividerElement
  | RowElement
  | SpacerElement;

export interface StructuredContent {
  layout: "stack" | "center";
  elements: UIElement[];
}

// ── Variant maps ──

const textVariantClasses: Record<string, string> = {
  title: "text-xl font-bold text-on-surface",
  subtitle: "text-sm font-medium text-on-surface-secondary uppercase tracking-wide",
  body: "text-sm text-on-surface",
  caption: "text-xs text-on-surface-muted",
  mono: "text-4xl font-mono font-bold text-on-surface tabular-nums tracking-tight",
};

const badgeColorClasses: Record<string, string> = {
  default: "bg-surface-tertiary text-on-surface-secondary",
  accent: "bg-accent/15 text-accent",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  error: "bg-error/15 text-error",
};

const progressColorClasses: Record<string, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
};

const buttonVariantClasses: Record<string, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover active:scale-[0.97] font-medium",
  secondary:
    "bg-surface-tertiary text-on-surface hover:bg-surface-tertiary/80 active:scale-[0.97] border border-border",
  ghost:
    "text-on-surface-secondary hover:bg-surface-tertiary hover:text-on-surface active:scale-[0.97]",
};

const gapClasses: Record<string, string> = {
  sm: "gap-1.5",
  md: "gap-3",
  lg: "gap-5",
};

const justifyClasses: Record<string, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
};

const spacerClasses: Record<string, string> = {
  sm: "h-2",
  md: "h-4",
  lg: "h-6",
};

// ── Element renderers ──

function RenderElement({
  element,
  onCommand,
}: {
  element: UIElement;
  onCommand: (id: string) => void;
}) {
  switch (element.type) {
    case "text":
      return <div className={textVariantClasses[element.variant ?? "body"]}>{element.value}</div>;

    case "badge":
      return (
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badgeColorClasses[element.color ?? "default"]}`}
        >
          {element.value}
        </span>
      );

    case "progress": {
      const pct = element.max > 0 ? Math.min((element.value / element.max) * 100, 100) : 0;
      const barColor = progressColorClasses[element.color ?? "accent"];
      return (
        <div className="w-full">
          {element.label && (
            <div className="text-xs text-on-surface-muted mb-1">{element.label}</div>
          )}
          <div className="w-full h-2 rounded-full bg-surface-tertiary overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${barColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      );
    }

    case "button":
      return (
        <button
          onClick={() => onCommand(element.commandId)}
          className={`px-4 py-2 rounded-lg text-sm transition-all ${buttonVariantClasses[element.variant ?? "secondary"]}`}
        >
          {element.label}
        </button>
      );

    case "divider":
      return <hr className="border-border" />;

    case "row":
      return (
        <div
          className={`flex items-center flex-wrap ${gapClasses[element.gap ?? "md"]} ${justifyClasses[element.justify ?? "center"]}`}
        >
          {element.elements.map((child, i) => (
            <RenderElement key={i} element={child} onCommand={onCommand} />
          ))}
        </div>
      );

    case "spacer":
      return <div className={spacerClasses[element.size ?? "md"]} />;

    default:
      // Unknown element type — silently skip (forward-compatible)
      return null;
  }
}

// ── Main renderer ──

interface StructuredContentRendererProps {
  content: StructuredContent;
  onCommand?: (commandId: string) => void;
}

export function StructuredContentRenderer({ content, onCommand }: StructuredContentRendererProps) {
  const handleCommand = async (commandId: string) => {
    if (onCommand) {
      onCommand(commandId);
    } else {
      await api.executePluginCommand(commandId);
    }
  };

  const layoutClasses =
    content.layout === "center" ? "flex flex-col items-center gap-4" : "flex flex-col gap-3";

  return (
    <div className={layoutClasses}>
      {content.elements.map((element, i) => (
        <RenderElement key={i} element={element} onCommand={handleCommand} />
      ))}
    </div>
  );
}
