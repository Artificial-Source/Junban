import { Download, Trash2, Loader2, ExternalLink, Shield } from "lucide-react";
import { getGradient, formatDownloads } from "../PluginCard.js";
import { PluginSettings } from "../PluginCard.js";
import type { BrowserPlugin } from "./plugin-browser-types.js";

// ── PluginDetail ─────────────────────────────────────

export function PluginDetail({
  plugin,
  installing,
  uninstalling,
  activating,
  onInstall,
  onUninstall,
  onToggle,
  error,
}: {
  plugin: BrowserPlugin;
  installing: boolean;
  uninstalling: boolean;
  activating: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onToggle: () => void;
  error: string | null;
}) {
  const [from, to] = getGradient(plugin.id);

  return (
    <div className="flex flex-col">
      {/* Gradient banner */}
      <div className={`h-32 bg-gradient-to-r ${from} ${to} flex items-center justify-center`}>
        <span className="text-5xl drop-shadow-md">{plugin.icon || "🧩"}</span>
      </div>

      <div className="p-5 space-y-5">
        {/* Header */}
        <div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-on-surface">{plugin.name}</h2>
              <div className="flex items-center gap-2 mt-1 text-xs text-on-surface-muted flex-wrap">
                {plugin.downloads != null && plugin.downloads > 0 && (
                  <span className="flex items-center gap-0.5">
                    <Download size={11} />
                    {formatDownloads(plugin.downloads)}
                  </span>
                )}
                <span>v{plugin.version}</span>
                <span>by {plugin.author}</span>
              </div>
            </div>

            {/* Status badge */}
            {plugin.installed && (
              <span
                className={`shrink-0 text-xs px-2 py-1 rounded-md font-medium ${
                  plugin.enabled
                    ? "bg-success/10 text-success"
                    : "bg-surface-tertiary text-on-surface-muted"
                }`}
              >
                {plugin.enabled ? "Enabled" : "Disabled"}
              </span>
            )}
          </div>

          {/* Repository link */}
          {plugin.repository && (
            <a
              href={plugin.repository}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-accent hover:text-accent-hover mt-2"
            >
              <ExternalLink size={11} />
              {plugin.repository.replace(/^https?:\/\//, "")}
            </a>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded-lg">
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-wrap">
          {plugin.installed ? (
            <>
              {/* Toggle enable/disable */}
              <button
                onClick={onToggle}
                disabled={activating}
                className={`text-sm px-4 py-1.5 rounded-md flex items-center gap-1.5 transition-colors ${
                  plugin.enabled
                    ? "border border-border text-on-surface-secondary hover:bg-surface-secondary"
                    : "bg-accent text-white hover:bg-accent-hover"
                } disabled:opacity-50`}
              >
                {activating ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : plugin.enabled ? (
                  "Disable"
                ) : (
                  "Enable"
                )}
              </button>

              {/* Uninstall (not for built-in) */}
              {!plugin.builtin && (
                <button
                  onClick={onUninstall}
                  disabled={uninstalling}
                  className="text-sm px-4 py-1.5 rounded-md border border-error/30 text-error hover:bg-error/10 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                >
                  {uninstalling ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                  {uninstalling ? "Removing..." : "Uninstall"}
                </button>
              )}
            </>
          ) : (
            <button
              onClick={onInstall}
              disabled={installing || !plugin.downloadUrl}
              className="text-sm px-4 py-1.5 rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-50 flex items-center gap-1.5 transition-colors"
            >
              {installing ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Installing...
                </>
              ) : (
                <>
                  <Download size={14} />
                  Install
                </>
              )}
            </button>
          )}
        </div>

        {/* Description */}
        <section>
          <h3 className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wider mb-2">
            Description
          </h3>
          <p className="text-sm text-on-surface-secondary leading-relaxed">
            {plugin.longDescription || plugin.description}
          </p>
        </section>

        {/* Permissions */}
        {plugin.permissions.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wider mb-2 flex items-center gap-1">
              <Shield size={12} />
              Permissions
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {plugin.permissions.map((p) => (
                <span
                  key={p}
                  className="text-xs font-mono px-2 py-1 rounded bg-warning/10 text-warning"
                >
                  {p}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Tags */}
        {plugin.tags.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wider mb-2">
              Tags
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {plugin.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-2 py-1 rounded-md bg-surface-tertiary text-on-surface-muted"
                >
                  {tag}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Settings (only if installed + enabled + has settings) */}
        {plugin.installed && plugin.enabled && plugin.settings.length > 0 && (
          <section>
            <h3 className="text-xs font-semibold text-on-surface-secondary uppercase tracking-wider mb-2">
              Settings
            </h3>
            <PluginSettings pluginId={plugin.id} definitions={plugin.settings} />
          </section>
        )}
      </div>
    </div>
  );
}
