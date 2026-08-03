/**
 * Local model package card — manifest metadata + deferred controller hooks.
 *
 * Does not import engine packages, workers, or cache loaders. Initial state is
 * always "not loaded" unless a later controller supplies verified status.
 */

import { useId, useState } from "react";
import { AlertCircle, CheckCircle2, Download, Trash2 } from "lucide-react";
import { LOCAL_VOICE_MANIFEST } from "../../../voice/local/manifest";
import type { LocalVoicePackage } from "../../../voice/local/types";
import { formatBytes, shortDigest } from "./constants";

export type LocalModelVerifiedStatus = "not_loaded" | "ready" | "error";

export type LocalModelController = {
  /** Verified status supplied by a later worker controller. Defaults to not_loaded. */
  getStatus?: (packageId: string) => LocalModelVerifiedStatus;
  onConsentLoad?: (packageId: string) => void | Promise<void>;
  onRemove?: (packageId: string) => void | Promise<void>;
};

function packageTotalBytes(pkg: LocalVoicePackage): number {
  return pkg.files.reduce((sum, file) => sum + file.bytes, 0);
}

function primaryDigest(pkg: LocalVoicePackage): string {
  const largest = [...pkg.files].sort((a, b) => b.bytes - a.bytes)[0];
  return largest?.sha256 ?? "";
}

export function LocalModelCard({
  pkg,
  controller,
}: {
  pkg: LocalVoicePackage;
  controller?: LocalModelController;
}) {
  const consentId = useId();
  const [consented, setConsented] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = controller?.getStatus?.(pkg.id) ?? "not_loaded";
  const total = packageTotalBytes(pkg);
  const digest = primaryDigest(pkg);

  const handleLoad = async () => {
    if (!consented || !controller?.onConsentLoad || busy) return;
    setBusy(true);
    try {
      await controller.onConsentLoad(pkg.id);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!controller?.onRemove || busy) return;
    setConfirmRemove(false);
    setBusy(true);
    try {
      await controller.onRemove(pkg.id);
    } finally {
      setBusy(false);
    }
  };

  const loadAvailable = Boolean(controller?.onConsentLoad);
  const removeAvailable = Boolean(controller?.onRemove);

  return (
    <div
      data-testid={`local-model-card-${pkg.id}`}
      className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface-secondary p-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-on-surface">{pkg.displayName}</span>
          <span className="rounded bg-surface-tertiary px-1.5 py-0.5 text-[10px] text-on-surface-muted">
            {pkg.engine.toUpperCase()}
          </span>
          <span className="text-[10px] text-on-surface-muted">{formatBytes(total)}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-on-surface-muted">
          {pkg.repo} @ {pkg.revision.slice(0, 12)}
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-on-surface-muted">
          <dt>License</dt>
          <dd className="text-on-surface-secondary">{pkg.license}</dd>
          <dt>Engine</dt>
          <dd className="truncate text-on-surface-secondary">{pkg.engineVersion}</dd>
          <dt>Digest</dt>
          <dd className="font-mono text-on-surface-secondary">{shortDigest(digest)}</dd>
          <dt>Files</dt>
          <dd className="text-on-surface-secondary">{pkg.files.length} pinned</dd>
        </dl>

        {status === "not_loaded" && (
          <label
            htmlFor={consentId}
            className="mt-3 flex items-start gap-2 text-xs text-on-surface"
          >
            <input
              id={consentId}
              type="checkbox"
              checked={consented}
              disabled={!loadAvailable || busy}
              onChange={(event) => setConsented(event.target.checked)}
              className="mt-0.5 accent-accent-action"
            />
            <span>
              I understand this downloads the pinned revision from Hugging Face and verifies SHA-256
              before use. Browser speech remains available if load fails.
            </span>
          </label>
        )}

        {confirmRemove && (
          <div className="mt-2 flex items-center gap-2 rounded border border-error/20 bg-error/5 p-2">
            <p className="flex-1 text-xs text-on-surface">Remove verified local files?</p>
            <button
              type="button"
              onClick={() => void handleRemove()}
              className="rounded bg-error px-2 py-0.5 text-xs text-white hover:bg-error/90"
            >
              Remove
            </button>
            <button
              type="button"
              onClick={() => setConfirmRemove(false)}
              className="rounded border border-border px-2 py-0.5 text-xs text-on-surface-secondary"
            >
              Cancel
            </button>
          </div>
        )}

        {!loadAvailable && status === "not_loaded" && (
          <p className="mt-2 text-[11px] text-on-surface-muted">
            Load controls connect in a later wave. Manifest details are shown for review only — this
            package is not loaded.
          </p>
        )}
      </div>

      <div className="ml-2 flex shrink-0 flex-col items-end gap-2">
        {status === "ready" ? (
          <>
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle2 size={12} aria-hidden="true" />
              Ready
            </span>
            {removeAvailable && (
              <button
                type="button"
                aria-label={`Remove ${pkg.displayName}`}
                disabled={busy}
                onClick={() => setConfirmRemove(true)}
                className="p-1 text-on-surface-muted transition-colors hover:text-error disabled:opacity-50"
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            )}
          </>
        ) : status === "error" ? (
          <span className="flex items-center gap-1 text-xs text-error">
            <AlertCircle size={12} aria-hidden="true" />
            Error
          </span>
        ) : loadAvailable ? (
          <button
            type="button"
            disabled={!consented || busy}
            onClick={() => void handleLoad()}
            className="flex items-center gap-1 text-xs text-accent-foreground transition-colors hover:text-accent-foreground-hover disabled:opacity-50"
          >
            <Download size={12} aria-hidden="true" />
            Load
          </button>
        ) : (
          <span className="text-xs text-on-surface-muted">Not loaded</span>
        )}
      </div>
    </div>
  );
}

export function LocalModelsSection({ controller }: { controller?: LocalModelController }) {
  const packages = LOCAL_VOICE_MANIFEST.packages;

  return (
    <fieldset className="space-y-4" data-testid="local-models-section">
      <legend className="mb-2 text-sm font-semibold text-on-surface">Local Models</legend>
      <p className="-mt-2 text-xs text-on-surface-muted">
        Local models run in your browser after an explicit load. Browser speech remains the
        fallback. Packages are pinned by source, revision, license, size, and digest.
      </p>
      <div className="space-y-3">
        {packages.map((pkg) => (
          <LocalModelCard key={pkg.id} pkg={pkg} controller={controller} />
        ))}
      </div>
    </fieldset>
  );
}
