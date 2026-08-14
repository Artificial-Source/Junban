/**
 * Permission approval dialog — exact capability list + signer-safe labels.
 */

import { useEffect, useRef } from "react";
import { Info, Shield } from "lucide-react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import {
  normalizePermissionId,
  permissionDescription,
  permissionScopeDescription,
} from "../parsers";
import type { PluginPermission } from "../types";

function displayCapability(cap: string): string {
  if (cap === "tasks:read") return "task:read";
  if (cap === "tasks:write") return "task:write";
  if (cap === "projects:read") return "project:read";
  if (cap === "projects:write") return "project:write";
  return cap;
}

export function PermissionDialog({
  pluginName,
  permissions,
  publisherKeyId,
  onApprove,
  onCancel,
  pending = false,
}: {
  pluginName: string;
  permissions: PluginPermission[];
  publisherKeyId?: string | null;
  onApprove: (permissions: PluginPermission[]) => void;
  onCancel: () => void;
  pending?: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, pending]);

  const rows = permissions.map((permission) => {
    const normalized = normalizePermissionId(permission.capability);
    return {
      permission,
      capability: displayCapability(permission.capability),
      description: permissionDescription(normalized),
      scopeDescription: permissionScopeDescription(permission),
    };
  });

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50"
      onClick={(event) => {
        if (event.target === overlayRef.current && !pending) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-permissions-title"
        className="mx-4 w-full max-w-md rounded-lg border border-border bg-surface p-6 shadow-xl"
      >
        <div className="mb-1 flex items-center gap-2">
          <Shield size={18} className="text-accent-foreground" aria-hidden="true" />
          <h2 id="plugin-permissions-title" className="text-lg font-semibold text-on-surface">
            Plugin Permissions
          </h2>
        </div>
        <p className="mb-4 text-sm text-on-surface-muted">
          <span className="font-medium text-on-surface">{pluginName}</span> is requesting the
          following permissions:
          {publisherKeyId ? <span className="sr-only"> Signer key: {publisherKeyId}.</span> : null}
        </p>

        <ul className="mb-6 space-y-2">
          {rows.map((row) => (
            <li key={row.permission.capability} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 shrink-0">
                <Info size={14} className="text-accent-foreground" aria-hidden="true" />
              </span>
              <div>
                <code className="rounded bg-surface-tertiary px-1 py-0.5 font-mono text-xs text-on-surface-secondary">
                  {row.capability}
                </code>
                <span className="ml-1.5 text-on-surface-secondary">— {row.description}</span>
                {row.scopeDescription ? (
                  <p className="mt-1 break-words text-xs text-on-surface-muted">
                    {row.scopeDescription}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            data-autofocus
            disabled={pending}
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm text-on-surface-secondary transition-colors hover:bg-surface-tertiary focus:ring-2 focus:ring-focus focus:outline-none disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => onApprove(permissions)}
            className="rounded-lg bg-accent-action px-4 py-2 text-sm text-on-accent-action transition-colors hover:bg-accent-action-hover focus:ring-2 focus:ring-focus focus:outline-none disabled:opacity-50"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
