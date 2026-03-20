import {
  Download,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Shield,
} from "lucide-react";
import type { StorePluginInfo } from "../../api/index.js";
import { GradientBanner, formatDownloads } from "./gradient-utils.js";

// ── Store mode card ──────────────────────────────────

export interface StoreCardProps {
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

export function StorePluginCard({
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

            {storePlugin.permissions && storePlugin.permissions.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-on-surface-secondary mb-1 flex items-center gap-1">
                    <Shield size={10} />
                    Permissions
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {storePlugin.permissions.map((p) => (
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
