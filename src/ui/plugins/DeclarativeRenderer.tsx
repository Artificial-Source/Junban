/**
 * Trusted declarative renderer for frozen WIT ui-node surfaces.
 * Renders text as text only — no HTML, CSS injection, JS, or arbitrary URLs.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type {
  ContributionFence,
  PluginSurface,
  ScalarNamedValue,
  ScalarValue,
  UiContent,
  UiNode,
  UiTone,
} from "./types";

export type DeclarativeActionHandler = (
  actionId: string,
  values: ScalarNamedValue[],
) => void | Promise<void>;

export type DeclarativeRendererProps = {
  surface: PluginSurface;
  onAction?: DeclarativeActionHandler;
  /** When true, interactive controls are disabled (stale fence / revoked). */
  disabled?: boolean;
  className?: string;
};

function toneClass(tone: UiTone): string {
  switch (tone) {
    case "accent":
      return "text-accent-foreground";
    case "positive":
      return "text-success";
    case "warning":
      return "text-warning";
    case "danger":
      return "text-error";
    default:
      return "text-on-surface";
  }
}

function sizeClass(size: "small" | "medium" | "large", kind: "text" | "heading"): string {
  if (kind === "heading") {
    if (size === "small") return "text-sm font-semibold";
    if (size === "large") return "text-2xl font-semibold";
    return "text-lg font-semibold";
  }
  if (size === "small") return "text-xs";
  if (size === "large") return "text-base";
  return "text-sm";
}

function alignStyle(align: string): CSSProperties {
  switch (align) {
    case "center":
      return { alignItems: "center", justifyContent: "center" };
    case "end":
      return { alignItems: "flex-end", justifyContent: "flex-end" };
    case "stretch":
      return { alignItems: "stretch" };
    default:
      return { alignItems: "flex-start", justifyContent: "flex-start" };
  }
}

function gapStyle(gap: number): CSSProperties {
  return { gap: `${Math.min(64, Math.max(0, gap)) * 0.25}rem` };
}

function scalarDisplay(value: ScalarValue): string {
  switch (value.tag) {
    case "boolean-value":
      return value.val ? "true" : "false";
    case "integer-value":
      return String(value.val);
    default:
      return value.val;
  }
}

function childrenOf(nodes: UiNode[], parentIndex: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i]!.parentIndex === parentIndex) out.push(i);
  }
  return out;
}

function buttonClass(tone: UiTone): string {
  if (tone === "accent" || tone === "positive") {
    return "inline-flex items-center justify-center rounded-lg bg-accent-action px-4 py-2 text-sm font-medium text-on-accent-action hover:bg-accent-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50";
  }
  if (tone === "danger") {
    return "inline-flex items-center justify-center rounded-lg border border-error/40 bg-error/10 px-4 py-2 text-sm font-medium text-error hover:bg-error/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50";
  }
  if (tone === "warning") {
    return "inline-flex items-center justify-center rounded-lg bg-warning px-4 py-2 text-sm font-medium text-on-warning hover:bg-warning/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50";
  }
  // neutral / ghost-like secondary
  return "inline-flex items-center justify-center rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-on-surface-secondary hover:bg-surface-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50";
}

function NodeView({
  nodes,
  index,
  onAction,
  disabled,
  values,
  setValue,
}: {
  nodes: UiNode[];
  index: number;
  onAction?: DeclarativeActionHandler;
  disabled: boolean;
  values: Record<string, ScalarValue>;
  setValue: (actionId: string, value: ScalarValue) => void;
}): ReactNode {
  const node = nodes[index];
  if (!node) return null;
  const content = node.content;
  const kids = childrenOf(nodes, index);

  const renderKids = (layout: "stack" | "row", gap: number, align: string) => (
    <div
      className={layout === "row" ? "flex flex-wrap" : "flex flex-col"}
      style={{ ...gapStyle(gap), ...alignStyle(align) }}
      data-ui-node={node.id}
    >
      {kids.map((child) => (
        <NodeView
          key={nodes[child]!.id}
          nodes={nodes}
          index={child}
          onAction={onAction}
          disabled={disabled}
          values={values}
          setValue={setValue}
        />
      ))}
    </div>
  );

  switch (content.tag) {
    case "stack":
      return renderKids("stack", content.val.gap, content.val.align);
    case "row":
      return renderKids("row", content.val.gap, content.val.align);
    case "heading":
      return (
        <h3
          data-ui-node={node.id}
          className={`${sizeClass(content.val.size, "heading")} ${toneClass(content.val.tone)}`}
        >
          {content.val.text}
        </h3>
      );
    case "text":
      return (
        <p
          data-ui-node={node.id}
          className={`${sizeClass(content.val.size, "text")} ${toneClass(content.val.tone)}`}
        >
          {content.val.text}
        </p>
      );
    case "badge":
      return (
        <span
          data-ui-node={node.id}
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
            content.val.tone === "accent"
              ? "bg-accent-action/15 text-accent-foreground"
              : content.val.tone === "positive"
                ? "bg-success/15 text-success"
                : content.val.tone === "warning"
                  ? "bg-warning/15 text-warning"
                  : content.val.tone === "danger"
                    ? "bg-error/15 text-error"
                    : "bg-surface-tertiary text-on-surface-secondary"
          }`}
        >
          {content.val.text}
        </span>
      );
    case "metric":
      return (
        <div data-ui-node={node.id} className="flex flex-col gap-0.5">
          <span className="text-xs text-on-surface-muted">{content.val.label}</span>
          <span className={`text-lg font-semibold tabular-nums ${toneClass(content.val.tone)}`}>
            {content.val.value}
          </span>
        </div>
      );
    case "progress": {
      const pct = Math.round((content.val.value / content.val.maximum) * 100);
      return (
        <div data-ui-node={node.id} className="w-full max-w-md">
          {content.val.label ? (
            <div className="mb-1 flex justify-between text-xs text-on-surface-muted">
              <span>{content.val.label}</span>
              <span className="tabular-nums">{pct}%</span>
            </div>
          ) : null}
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary"
            role="progressbar"
            aria-valuenow={content.val.value}
            aria-valuemin={0}
            aria-valuemax={content.val.maximum}
            aria-label={content.val.label || "Progress"}
          >
            <div className="h-full rounded-full bg-accent-action" style={{ width: `${pct}%` }} />
          </div>
        </div>
      );
    }
    case "button":
      return (
        <button
          type="button"
          data-ui-node={node.id}
          data-action-id={content.val.actionId}
          disabled={disabled}
          className={buttonClass(content.val.tone)}
          onClick={() => {
            if (disabled || !onAction) return;
            const named: ScalarNamedValue[] = Object.entries(values).map(([name, value]) => ({
              name,
              value,
            }));
            void onAction(content.val.actionId, named);
          }}
        >
          {content.val.label}
        </button>
      );
    case "text-input": {
      const current = values[content.val.actionId] ?? content.val.value;
      const display =
        current.tag === "string-value" || current.tag === "option-id"
          ? current.val
          : scalarDisplay(current);
      return (
        <label data-ui-node={node.id} className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-on-surface-secondary">{content.val.label}</span>
          <input
            type="text"
            value={display}
            disabled={disabled}
            onChange={(e) =>
              setValue(content.val.actionId, { tag: "string-value", val: e.target.value })
            }
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-focus disabled:opacity-50"
          />
        </label>
      );
    }
    case "number-input": {
      const current = values[content.val.actionId] ?? content.val.value;
      const num = current.tag === "integer-value" ? current.val : Number(scalarDisplay(current));
      return (
        <label data-ui-node={node.id} className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-on-surface-secondary">{content.val.label}</span>
          <input
            type="number"
            value={Number.isFinite(num) ? num : 0}
            disabled={disabled}
            onChange={(e) =>
              setValue(content.val.actionId, {
                tag: "integer-value",
                val: Math.trunc(Number(e.target.value) || 0),
              })
            }
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-focus disabled:opacity-50"
          />
        </label>
      );
    }
    case "select": {
      const current = values[content.val.actionId] ?? content.val.value;
      const selected =
        current.tag === "option-id" || current.tag === "string-value"
          ? current.val
          : scalarDisplay(current);
      return (
        <label data-ui-node={node.id} className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-on-surface-secondary">{content.val.label}</span>
          <select
            value={selected}
            disabled={disabled}
            onChange={(e) =>
              setValue(content.val.actionId, { tag: "option-id", val: e.target.value })
            }
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-focus disabled:opacity-50"
          >
            {content.val.options.map((opt) => (
              <option key={opt.name} value={scalarDisplay(opt.value)}>
                {opt.name}
              </option>
            ))}
          </select>
        </label>
      );
    }
    case "toggle": {
      const current = values[content.val.actionId] ?? content.val.value;
      const on = current.tag === "boolean-value" ? current.val : false;
      return (
        <label
          data-ui-node={node.id}
          className="inline-flex items-center gap-2 text-sm text-on-surface"
        >
          <input
            type="checkbox"
            checked={on}
            disabled={disabled}
            onChange={(e) =>
              setValue(content.val.actionId, { tag: "boolean-value", val: e.target.checked })
            }
            className="h-4 w-4 rounded border-border"
          />
          <span>{content.val.label}</span>
        </label>
      );
    }
    case "task-list":
      return (
        <ul data-ui-node={node.id} className="list-inside list-disc text-sm text-on-surface">
          {content.val.taskIds.map((id) => (
            <li key={id} className="font-mono text-xs text-on-surface-secondary">
              {id}
            </li>
          ))}
        </ul>
      );
    case "task-ref":
      return (
        <span data-ui-node={node.id} className="font-mono text-xs text-on-surface-secondary">
          {content.val}
        </span>
      );
    case "divider":
      return <hr data-ui-node={node.id} className="my-2 border-border" />;
    case "empty-state":
    case "error-state":
      return (
        <p
          data-ui-node={node.id}
          role={content.tag === "error-state" ? "alert" : "status"}
          className={`${sizeClass(content.val.size, "text")} ${
            content.tag === "error-state" ? "text-error" : toneClass(content.val.tone)
          }`}
        >
          {content.val.text}
        </p>
      );
    default: {
      const _exhaustive: never = content;
      void _exhaustive;
      return null;
    }
  }
}

export function DeclarativeRenderer({
  surface,
  onAction,
  disabled = false,
  className = "",
}: DeclarativeRendererProps) {
  const [values, setValues] = useState<Record<string, ScalarValue>>({});

  const setValue = (actionId: string, value: ScalarValue) => {
    setValues((prev) => ({ ...prev, [actionId]: value }));
  };

  const root = useMemo(() => surface.rootIndex, [surface.rootIndex]);

  if (surface.nodes.length === 0 || root < 0 || root >= surface.nodes.length) {
    return (
      <p role="alert" className="text-sm text-error">
        Invalid plugin surface.
      </p>
    );
  }

  return (
    <div
      className={className}
      data-testid="declarative-surface"
      data-surface-id={surface.surfaceId}
    >
      <NodeView
        nodes={surface.nodes}
        index={root}
        onAction={onAction}
        disabled={disabled}
        values={values}
        setValue={setValue}
      />
    </div>
  );
}

/** Build fence payload for invoke/render from a contribution or render result. */
export function fenceOf(source: {
  packageGeneration: number;
  activationEpoch: number;
  hostSessionId: string;
}): ContributionFence {
  return {
    packageGeneration: source.packageGeneration,
    activationEpoch: source.activationEpoch,
    hostSessionId: source.hostSessionId,
  };
}

/** Collect leaf content tags for tests (no HTML). */
export function collectSurfaceTexts(surface: PluginSurface): string[] {
  const out: string[] = [];
  for (const node of surface.nodes) {
    const c = node.content;
    if (
      c.tag === "heading" ||
      c.tag === "text" ||
      c.tag === "badge" ||
      c.tag === "empty-state" ||
      c.tag === "error-state"
    ) {
      out.push(c.val.text);
    } else if (c.tag === "button") {
      out.push(c.val.label);
    } else if (c.tag === "metric") {
      out.push(c.val.label, c.val.value);
    }
  }
  return out;
}

/** Type guard helper for content discrimination in tests. */
export function isUiContentTag(content: UiContent, tag: UiContent["tag"]): boolean {
  return content.tag === tag;
}
