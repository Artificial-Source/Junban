/**
 * Typed plugin settings editor driven by fail-closed setting declarations.
 */

import { useEffect, useState } from "react";
import type { PluginSetting, PluginSettingValue, SettingDeclaration } from "../types";

export function PluginSettingsPanel({
  declarations,
  values,
  disabled,
  onChange,
}: {
  declarations: SettingDeclaration[];
  values: PluginSetting[];
  disabled?: boolean;
  onChange: (key: string, value: PluginSettingValue) => void;
}) {
  const valueMap = new Map(values.map((v) => [v.key, v.value]));
  const [draft, setDraft] = useState<Record<string, PluginSettingValue>>({});

  useEffect(() => {
    const next: Record<string, PluginSettingValue> = {};
    for (const decl of declarations) {
      if (decl.schema.type === "text" && decl.schema.secret) continue;
      const existing = valueMap.get(decl.id);
      next[decl.id] =
        existing !== undefined
          ? existing
          : decl.schema.type === "select"
            ? decl.schema.default
            : decl.schema.default;
    }
    setDraft(next);
    // Only re-seed when declaration ids or server values change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [declarations, values]);

  if (declarations.length === 0) {
    return <p className="text-xs text-on-surface-muted">No settings declared for this plugin.</p>;
  }

  return (
    <div className="space-y-3" data-testid="plugin-settings-panel">
      <h4 className="text-xs font-semibold tracking-wide text-on-surface-secondary uppercase">
        Settings
      </h4>
      {declarations.map((decl) => {
        if (decl.schema.type === "text" && decl.schema.secret) {
          return (
            <p key={decl.id} className="text-xs text-on-surface-muted">
              {decl.label}: managed securely (not shown)
            </p>
          );
        }
        const value = draft[decl.id] ?? decl.schema.default;
        return (
          <label key={decl.id} className="block">
            <span className="mb-1 block text-xs font-medium text-on-surface-secondary">
              {decl.label}
            </span>
            {decl.schema.type === "integer" ? (
              <input
                type="number"
                min={decl.schema.min}
                max={decl.schema.max}
                step={decl.schema.step}
                disabled={disabled}
                value={typeof value === "number" ? value : Number(value) || decl.schema.default}
                onChange={(e) => {
                  const next = Math.trunc(Number(e.target.value));
                  setDraft((prev) => ({ ...prev, [decl.id]: next }));
                  onChange(decl.id, next);
                }}
                className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-focus disabled:opacity-50"
              />
            ) : decl.schema.type === "boolean" ? (
              <input
                type="checkbox"
                disabled={disabled}
                checked={Boolean(value)}
                onChange={(e) => {
                  setDraft((prev) => ({ ...prev, [decl.id]: e.target.checked }));
                  onChange(decl.id, e.target.checked);
                }}
                className="h-4 w-4 rounded border-border"
              />
            ) : decl.schema.type === "select" ? (
              <select
                disabled={disabled}
                value={String(value)}
                onChange={(e) => {
                  setDraft((prev) => ({ ...prev, [decl.id]: e.target.value }));
                  onChange(decl.id, e.target.value);
                }}
                className="w-full max-w-xs rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-focus disabled:opacity-50"
              >
                {decl.schema.options.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                disabled={disabled}
                value={String(value ?? "")}
                maxLength={decl.schema.maxBytes}
                onChange={(e) => {
                  setDraft((prev) => ({ ...prev, [decl.id]: e.target.value }));
                  onChange(decl.id, e.target.value);
                }}
                className="w-full max-w-xs rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-focus disabled:opacity-50"
              />
            )}
            {decl.description ? (
              <span className="mt-0.5 block text-[11px] text-on-surface-muted">
                {decl.description}
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}
