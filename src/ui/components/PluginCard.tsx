import { useState, useEffect, useCallback } from "react";
import {
  Download,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Shield,
} from "lucide-react";
import {
  api,
  type PluginInfo,
  type StorePluginInfo,
  type SettingDefinitionInfo,
} from "../api/index.js";

// ── Gradient system ──────────────────────────────────

export const GRADIENT_PALETTE = [
  ["from-violet-500", "to-purple-600"],
  ["from-blue-500", "to-cyan-500"],
  ["from-emerald-500", "to-teal-500"],
  ["from-orange-500", "to-amber-500"],
  ["from-rose-500", "to-pink-500"],
  ["from-indigo-500", "to-blue-500"],
  ["from-fuchsia-500", "to-purple-500"],
  ["from-sky-500", "to-indigo-500"],
  ["from-lime-500", "to-green-500"],
  ["from-red-500", "to-orange-500"],
  ["from-teal-500", "to-cyan-500"],
  ["from-pink-500", "to-rose-500"],
] as const;

export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function getGradient(pluginId: string): [string, string] {
  const idx = hashString(pluginId) % GRADIENT_PALETTE.length;
  return GRADIENT_PALETTE[idx] as [string, string];
}

export function formatDownloads(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

// ── Gradient Banner ──────────────────────────────────

export function GradientBanner({ pluginId, icon }: { pluginId: string; icon?: string }) {
  const [from, to] = getGradient(pluginId);
  return (
    <div
      className={`h-16 rounded-t-lg bg-gradient-to-r ${from} ${to} flex items-center justify-center`}
    >
      <span className="text-3xl drop-shadow-sm">{icon || "🧩"}</span>
    </div>
  );
}

// ── Plugin Settings ──────────────────────────────────

export function PluginSettings({
  pluginId,
  definitions,
}: {
  pluginId: string;
  definitions: SettingDefinitionInfo[];
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const data = await api.getPluginSettings(pluginId);
      setValues(data);
      setLoaded(true);
    } catch {
      // Non-critical
    }
  }, [pluginId]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleChange = async (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    await api.updatePluginSetting(pluginId, key, value);
  };

  if (!loaded) {
    return <p className="text-xs text-on-surface-muted">Loading settings...</p>;
  }

  return (
    <div className="space-y-3">
      {definitions.map((def) => (
        <SettingField
          key={def.id}
          definition={def}
          value={values[def.id] ?? def.default}
          onChange={(v) => handleChange(def.id, v)}
        />
      ))}
    </div>
  );
}

function SettingField({
  definition,
  value,
  onChange,
}: {
  definition: SettingDefinitionInfo;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-on-surface-secondary mb-1">
        {definition.name}
        {definition.description && (
          <span className="font-normal text-on-surface-muted ml-1">— {definition.description}</span>
        )}
      </label>
      {definition.type === "text" && (
        <input
          type="text"
          value={String(value ?? "")}
          placeholder={definition.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1 text-sm border border-border rounded bg-surface text-on-surface"
        />
      )}
      {definition.type === "number" && (
        <input
          type="number"
          value={Number(value ?? 0)}
          min={definition.min}
          max={definition.max}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-24 px-2 py-1 text-sm border border-border rounded bg-surface text-on-surface"
        />
      )}
      {definition.type === "boolean" && (
        <button
          onClick={() => onChange(!value)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            value ? "bg-accent" : "bg-surface-tertiary"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              value ? "translate-x-4.5" : "translate-x-0.5"
            }`}
          />
        </button>
      )}
      {definition.type === "select" && (
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="px-2 py-1 text-sm border border-border rounded bg-surface text-on-surface"
        >
          {definition.options?.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ── Store mode card ──────────────────────────────────

interface StoreCardProps {
  mode: "store";
  plugin: StorePluginInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  installed: boolean;
  installing: boolean;
  uninstalling: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  // For inactive built-ins shown in the store
  isBuiltin?: boolean;
  activating?: boolean;
  onActivate?: () => void;
}

interface SettingsCardProps {
  mode: "settings";
  plugin: PluginInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  // Built-in specific
  toggling?: boolean;
  onToggle?: () => void;
  // Community specific
  onRequestApproval?: () => void;
  onRevoke?: () => void;
}

export type PluginCardProps = StoreCardProps | SettingsCardProps;

export function PluginCard(props: PluginCardProps) {
  if (props.mode === "store") {
    return <StorePluginCard {...props} />;
  }
  return <SettingsPluginCard {...props} />;
}

// ── Store Plugin Card ────────────────────────────────

function StorePluginCard({
  plugin,
  expanded,
  onToggleExpand,
  installed,
  installing,
  uninstalling,
  onInstall,
  onUninstall,
  isBuiltin,
  activating,
  onActivate,
}: StoreCardProps) {
  const storePlugin = plugin as StorePluginInfo;

  const actionButton = () => {
    if (isBuiltin && onActivate) {
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onActivate();
          }}
          disabled={activating}
          className="text-xs px-2.5 py-1 rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1 transition-colors"
        >
          {activating ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              Activating...
            </>
          ) : (
            "Activate"
          )}
        </button>
      );
    }

    if (installed) {
      return (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onUninstall();
          }}
          disabled={uninstalling}
          className="text-xs px-2.5 py-1 rounded-md border border-error/30 text-error hover:bg-error/10 disabled:opacity-50 flex items-center gap-1 transition-colors"
        >
          {uninstalling ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              Removing...
            </>
          ) : (
            <>
              <Trash2 size={12} />
              Uninstall
            </>
          )}
        </button>
      );
    }

    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          onInstall();
        }}
        disabled={installing || !storePlugin.downloadUrl}
        className="text-xs px-2.5 py-1 rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1 transition-colors"
      >
        {installing ? (
          <>
            <Loader2 size={12} className="animate-spin" />
            Installing...
          </>
        ) : (
          <>
            <Download size={12} />
            Install
          </>
        )}
      </button>
    );
  };

  return (
    <div className="border border-border rounded-lg bg-surface overflow-hidden hover:border-border-hover transition-colors">
      <GradientBanner pluginId={storePlugin.id} icon={storePlugin.icon} />

      <div className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between mb-1">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-sm text-on-surface truncate">{storePlugin.name}</h3>
              {isBuiltin && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">
                  Built-in
                </span>
              )}
            </div>
            <p className="text-xs text-on-surface-muted mt-0.5">by {storePlugin.author}</p>
          </div>
          <div className="shrink-0 ml-2">{actionButton()}</div>
        </div>

        {/* Description */}
        <p className="text-xs text-on-surface-secondary mt-2 line-clamp-2">
          {storePlugin.description}
        </p>

        {/* Footer: tags, downloads, version, expand toggle */}
        <div className="flex items-center justify-between mt-3">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            {storePlugin.tags?.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-xs px-1.5 py-0.5 rounded-md bg-surface-tertiary text-on-surface-muted"
              >
                {tag}
              </span>
            ))}
            {storePlugin.downloads != null && storePlugin.downloads > 0 && (
              <span className="text-xs text-on-surface-muted flex items-center gap-0.5">
                <Download size={10} />
                {formatDownloads(storePlugin.downloads)}
              </span>
            )}
            <span className="text-xs text-on-surface-muted">v{storePlugin.version}</span>
          </div>
          <button
            onClick={onToggleExpand}
            className="text-on-surface-muted hover:text-on-surface p-1 transition-colors"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Expanded detail section */}
      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t border-border mt-0 space-y-3">
          <div className="pt-3">
            {storePlugin.longDescription && (
              <p className="text-xs text-on-surface-secondary leading-relaxed">
                {storePlugin.longDescription}
              </p>
            )}

            {(storePlugin as any).permissions &&
              ((storePlugin as any).permissions as string[]).length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-on-surface-secondary mb-1 flex items-center gap-1">
                    <Shield size={10} />
                    Permissions
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {((storePlugin as any).permissions as string[]).map((p) => (
                      <span
                        key={p}
                        className="text-xs font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning"
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            {storePlugin.repository && (
              <a
                href={storePlugin.repository}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent-hover mt-3"
              >
                <ExternalLink size={10} />
                View Repository
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Settings Plugin Card ─────────────────────────────

function SettingsPluginCard({
  plugin,
  expanded,
  onToggleExpand,
  toggling,
  onToggle,
  onRequestApproval,
  onRevoke,
}: SettingsCardProps) {
  const isBuiltin = plugin.builtin;
  const isPending = !plugin.enabled && plugin.permissions.length > 0 && !isBuiltin;

  return (
    <div className="border border-border rounded-lg bg-surface overflow-hidden hover:border-border-hover transition-colors">
      <GradientBanner pluginId={plugin.id} icon={plugin.icon} />

      <div className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between mb-1">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-sm text-on-surface truncate">{plugin.name}</h3>
              {isBuiltin && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">
                  Built-in
                </span>
              )}
              {isPending ? (
                <span className="text-xs px-1.5 py-0.5 rounded bg-warning/10 text-warning shrink-0">
                  Needs Approval
                </span>
              ) : (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                    plugin.enabled
                      ? "bg-success/10 text-success"
                      : "bg-surface-tertiary text-on-surface-muted"
                  }`}
                >
                  {plugin.enabled ? "Active" : "Inactive"}
                </span>
              )}
            </div>
            <p className="text-xs text-on-surface-muted mt-0.5">by {plugin.author}</p>
          </div>

          {/* Action: toggle switch for built-in, or nothing for community (actions in expanded) */}
          {isBuiltin && onToggle && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              disabled={toggling}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ml-2 ${
                plugin.enabled ? "bg-accent" : "bg-surface-tertiary"
              } ${toggling ? "opacity-50" : ""}`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  plugin.enabled ? "translate-x-4.5" : "translate-x-0.5"
                }`}
              />
            </button>
          )}
        </div>

        {/* Description */}
        <p className="text-xs text-on-surface-secondary mt-2 line-clamp-2">{plugin.description}</p>

        {/* Footer: version + expand toggle */}
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-on-surface-muted">v{plugin.version}</span>
          <button
            onClick={onToggleExpand}
            className="text-on-surface-muted hover:text-on-surface p-1 transition-colors"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* Expanded detail section */}
      {expanded && (
        <div className="px-4 pb-4 pt-0 border-t border-border space-y-3">
          <div className="pt-3">
            {/* Permissions */}
            {plugin.permissions.length > 0 && (
              <div>
                <p className="text-xs font-medium text-on-surface-secondary mb-1 flex items-center gap-1">
                  <Shield size={10} />
                  Permissions
                </p>
                <div className="flex flex-wrap gap-1">
                  {plugin.permissions.map((p) => (
                    <span
                      key={p}
                      className="text-xs font-mono px-1.5 py-0.5 rounded bg-surface-tertiary text-on-surface-secondary"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Approval / Revoke buttons for community plugins */}
            {isPending && onRequestApproval && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestApproval();
                }}
                className="mt-2 px-3 py-1 text-xs bg-accent text-white rounded hover:bg-accent-hover"
              >
                Approve Permissions
              </button>
            )}

            {!isBuiltin && plugin.enabled && plugin.permissions.length > 0 && onRevoke && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRevoke();
                }}
                className="mt-2 px-3 py-1 text-xs text-error border border-error/30 rounded hover:bg-error/10"
              >
                Revoke Permissions
              </button>
            )}

            {/* Settings */}
            {plugin.enabled && plugin.settings.length > 0 ? (
              <div className="mt-3">
                <p className="text-xs font-medium text-on-surface-secondary mb-2">Settings</p>
                <PluginSettings pluginId={plugin.id} definitions={plugin.settings} />
              </div>
            ) : plugin.settings.length === 0 ? (
              <p className="text-xs text-on-surface-muted mt-2">No configurable settings.</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
