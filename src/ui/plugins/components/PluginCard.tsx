/**
 * Installed plugin card for Settings → Extensions.
 * Preserves legacy gradient header + expand/settings chrome.
 */

import { useId } from "react";
import {
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Columns3,
  Compass,
  Lightbulb,
  List,
  Lock,
  Play,
  Puzzle,
  Shield,
  Target,
  Timer,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type {
  InstalledPlugin,
  PluginSetting,
  PluginSettingValue,
  SettingDeclaration,
} from "../types";
import { arePermissionsFullyGranted, normalizePermissionId } from "../parsers";
import { PluginSettingsPanel } from "./PluginSettingsPanel";

function displayCapability(cap: string): string {
  if (cap === "tasks:read") return "task:read";
  if (cap === "tasks:write") return "task:write";
  if (cap === "projects:read") return "project:read";
  if (cap === "projects:write") return "project:write";
  return cap;
}

const ICON_MAP: Record<string, LucideIcon> = {
  "bar-chart": BarChart3,
  "bar-chart-3": BarChart3,
  calendar: CalendarDays,
  "calendar-days": CalendarDays,
  "check-circle": CheckCircle2,
  "check-circle-2": CheckCircle2,
  columns: Columns3,
  compass: Compass,
  lightbulb: Lightbulb,
  list: List,
  play: Play,
  puzzle: Puzzle,
  target: Target,
  timer: Timer,
  "x-circle": XCircle,
  zap: Zap,
};

const GRADIENT_PALETTE = [
  "from-violet-500 to-purple-600",
  "from-blue-500 to-cyan-500",
  "from-emerald-500 to-teal-500",
  "from-orange-500 to-amber-500",
  "from-rose-500 to-pink-500",
  "from-indigo-500 to-blue-500",
  "from-fuchsia-500 to-purple-500",
  "from-sky-500 to-indigo-500",
  "from-lime-500 to-green-500",
  "from-red-500 to-orange-500",
  "from-teal-500 to-cyan-500",
  "from-pink-500 to-rose-500",
] as const;

function gradientFor(pluginId: string): string {
  let hash = 0;
  for (let index = 0; index < pluginId.length; index += 1) {
    hash = ((hash << 5) - hash + pluginId.charCodeAt(index)) | 0;
  }
  return GRADIENT_PALETTE[Math.abs(hash) % GRADIENT_PALETTE.length]!;
}

function iconFor(plugin: InstalledPlugin): LucideIcon {
  const icon = plugin.icon?.trim().toLowerCase();
  return (icon && ICON_MAP[icon]) || ICON_MAP.puzzle!;
}

export function PluginCard({
  plugin,
  expanded,
  onToggleExpand,
  toggling,
  onToggle,
  onRequestApproval,
  onRevoke,
  isRestricted,
  mutationDisabled = false,
  settingDeclarations = [],
  settingValues = [],
  onSettingChange,
  onRetry,
  onUninstall,
}: {
  plugin: InstalledPlugin;
  expanded: boolean;
  onToggleExpand: () => void;
  toggling?: boolean;
  onToggle: () => void;
  onRequestApproval?: () => void;
  onRevoke?: () => void;
  isRestricted?: boolean;
  mutationDisabled?: boolean;
  settingDeclarations?: SettingDeclaration[];
  settingValues?: PluginSetting[];
  onSettingChange?: (key: string, value: PluginSettingValue) => void;
  onRetry?: () => void;
  onUninstall?: () => void;
}) {
  const detailsId = useId();
  const toggleId = useId();
  const Icon = iconFor(plugin);
  const active = plugin.desiredEnabled && plugin.runtimeState.toLowerCase() === "active";
  const enabled = plugin.desiredEnabled;
  const permissions = plugin.requestedPermissions.map((permission) => permission.capability);
  const hasFullGrants = arePermissionsFullyGranted(
    plugin.requestedPermissions,
    plugin.grantedPermissions,
  );
  const needsApproval = !plugin.builtin && !hasFullGrants && !enabled;
  const author = plugin.author ?? (plugin.builtin ? "ASF" : plugin.publisherKeyId.slice(0, 12));

  const handleToggle = () => {
    if (!enabled && permissions.length > 0 && needsApproval && onRequestApproval) {
      onRequestApproval();
      return;
    }
    if (
      !enabled &&
      permissions.length > 0 &&
      plugin.builtin &&
      !hasFullGrants &&
      onRequestApproval
    ) {
      onRequestApproval();
      return;
    }
    onToggle();
  };

  return (
    <article
      data-testid={`plugin-card-${plugin.pluginId}`}
      className="overflow-hidden rounded-lg border border-border bg-surface transition-colors hover:border-border"
    >
      <div
        className={`flex h-16 items-center justify-center rounded-t-lg bg-gradient-to-r ${gradientFor(plugin.pluginId)}`}
      >
        <Icon aria-hidden="true" size={32} className="shrink-0 drop-shadow-sm" />
      </div>

      <div className="p-4">
        <div className="mb-1 flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-on-surface">{plugin.name}</h3>
              {plugin.builtin ? (
                <span className="shrink-0 rounded bg-surface-tertiary px-1.5 py-0.5 text-xs text-on-surface-secondary">
                  Built-in
                </span>
              ) : null}
              {needsApproval ? (
                <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
                  Needs Approval
                </span>
              ) : (
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                    active
                      ? "bg-success/10 text-success"
                      : "bg-surface-tertiary text-on-surface-muted"
                  }`}
                >
                  {active ? "Active" : enabled ? plugin.runtimeState : "Inactive"}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-on-surface-muted">by {author}</p>
          </div>

          {plugin.builtin ? (
            <label
              htmlFor={toggleId}
              className={`relative ml-2 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-within:ring-2 focus-within:ring-focus focus-within:ring-offset-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus ${
                enabled ? "bg-accent-action" : "bg-surface-tertiary"
              } ${toggling || mutationDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
            >
              <span className="sr-only">{plugin.name}</span>
              <input
                id={toggleId}
                type="checkbox"
                checked={enabled}
                disabled={toggling || mutationDisabled}
                onChange={handleToggle}
                className="peer sr-only"
              />
              <span
                aria-hidden="true"
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  enabled ? "translate-x-4.5" : "translate-x-0.5"
                }`}
              />
            </label>
          ) : null}
        </div>

        <p className="mt-2 line-clamp-2 text-xs text-on-surface-secondary">{plugin.description}</p>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-on-surface-muted">v{plugin.version}</span>
          <button
            type="button"
            onClick={onToggleExpand}
            disabled={isRestricted}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${plugin.name}`}
            className="p-1 text-on-surface-muted transition-colors hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {expanded ? (
        <div id={detailsId} className="space-y-3 border-t border-border px-4 pt-0 pb-4">
          <div className="pt-3">
            {permissions.length > 0 ? (
              <div>
                <p className="mb-1 flex items-center gap-1 text-xs font-medium text-on-surface-secondary">
                  <Shield size={10} />
                  Permissions
                </p>
                <div className="flex flex-wrap gap-1">
                  {permissions.map((capability) => (
                    <code
                      key={capability}
                      className="rounded bg-surface-tertiary px-1.5 py-0.5 text-xs text-on-surface-secondary"
                    >
                      {displayCapability(normalizePermissionId(capability))}
                    </code>
                  ))}
                </div>
              </div>
            ) : null}

            {isRestricted && !plugin.builtin ? (
              <p className="mt-2 flex items-center gap-1 text-xs text-warning">
                <Lock size={10} />
                Enable community plugins first
              </p>
            ) : null}

            {needsApproval && !isRestricted && onRequestApproval ? (
              <button
                type="button"
                onClick={onRequestApproval}
                disabled={mutationDisabled}
                className="mt-2 rounded bg-accent-action px-3 py-1 text-xs text-on-accent-action hover:bg-accent-action-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Approve Permissions
              </button>
            ) : null}

            {!plugin.builtin && enabled && permissions.length > 0 && onRevoke ? (
              <button
                type="button"
                onClick={onRevoke}
                disabled={isRestricted || mutationDisabled}
                className="mt-2 rounded border border-error/30 px-3 py-1 text-xs text-error hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Revoke Permissions
              </button>
            ) : null}

            {enabled && settingDeclarations.length > 0 && onSettingChange ? (
              <div className="mt-3">
                <PluginSettingsPanel
                  declarations={settingDeclarations}
                  values={settingValues}
                  disabled={isRestricted || mutationDisabled}
                  onChange={onSettingChange}
                />
              </div>
            ) : settingDeclarations.length === 0 ? (
              <p className="mt-2 text-xs text-on-surface-muted">No configurable settings.</p>
            ) : null}

            {plugin.failureCount > 0 || plugin.lastErrorCode ? (
              <div className="mt-3 rounded-md border border-error/30 bg-error/5 p-2" role="alert">
                <p className="text-xs text-error">
                  {plugin.lastErrorCode
                    ? `Error: ${plugin.lastErrorCode}`
                    : `Failed ${plugin.failureCount} time(s)`}
                </p>
                {onRetry ? (
                  <button
                    type="button"
                    disabled={mutationDisabled}
                    onClick={onRetry}
                    className="mt-1 text-xs font-medium text-error underline"
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}

            {!plugin.builtin && onUninstall ? (
              <button
                type="button"
                disabled={isRestricted || mutationDisabled}
                onClick={onUninstall}
                className="mt-2 rounded border border-error/30 px-3 py-1 text-xs text-error hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Uninstall
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}
