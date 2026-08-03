/**
 * Local model package card — manifest metadata + verified status/selection.
 *
 * Does not import engine packages, workers, or cache loaders. Status and load
 * actions come from the Voice-tab controller after dynamic local import.
 */

import { useId, useState } from "react";
import { AlertCircle, CheckCircle2, Download, Trash2 } from "lucide-react";
import { LOCAL_VOICE_MANIFEST } from "../../../voice/local/manifest";
import type { LocalVoicePackage } from "../../../voice/local/types";
import {
  isLocalSttPackageId,
  isLocalTtsPackageId,
  type LocalSttPreference,
  type LocalTtsPreference,
  type LocalVoicePreferences,
} from "../../../voice/localPreferences";
import { formatBytes, shortDigest } from "./constants";

export type LocalModelVerifiedStatus = "not_loaded" | "ready" | "error";

export type LocalModelLoadProgressView = {
  packageId: string;
  loaded: number;
  total: number;
};

export type LocalModelController = {
  getStatus?: (packageId: string) => LocalModelVerifiedStatus;
  onConsentLoad?: (packageId: string) => void | Promise<void>;
  onRemove?: (packageId: string) => void | Promise<void>;
  isSelected?: (packageId: string) => boolean;
  onSelect?: (packageId: string) => void;
  progressFor?: (packageId: string) => LocalModelLoadProgressView | null;
  busyPackageId?: string | null;
  preferences?: LocalVoicePreferences;
  selectStt?: (value: LocalSttPreference) => void;
  selectTts?: (value: LocalTtsPreference) => void;
  error?: string | null;
  clearError?: () => void;
};

function packageTotalBytes(pkg: LocalVoicePackage): number {
  return pkg.files.reduce((sum, file) => sum + file.bytes, 0);
}

function primaryDigest(pkg: LocalVoicePackage): string {
  const largest = [...pkg.files].sort((a, b) => b.bytes - a.bytes)[0];
  return largest?.sha256 ?? "";
}

function progressLabel(progress: LocalModelLoadProgressView | null | undefined): string | null {
  if (!progress) return null;
  if (progress.total > 0) {
    const pct = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
    return `Loading ${pct}%`;
  }
  return "Loading…";
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
  const status = controller?.getStatus?.(pkg.id) ?? "not_loaded";
  const selected = controller?.isSelected?.(pkg.id) ?? false;
  const busy =
    controller?.busyPackageId === pkg.id ||
    (controller?.busyPackageId != null && controller.busyPackageId !== "");
  const cardBusy = controller?.busyPackageId === pkg.id;
  const progress = controller?.progressFor?.(pkg.id) ?? null;
  const total = packageTotalBytes(pkg);
  const digest = primaryDigest(pkg);
  const loadAvailable = Boolean(controller?.onConsentLoad);
  const removeAvailable = Boolean(controller?.onRemove);
  const selectAvailable = Boolean(controller?.onSelect) && status === "ready";

  const handleLoad = async () => {
    if (!consented || !controller?.onConsentLoad || cardBusy) return;
    await controller.onConsentLoad(pkg.id);
  };

  const handleRemove = async () => {
    if (!controller?.onRemove || cardBusy) return;
    setConfirmRemove(false);
    await controller.onRemove(pkg.id);
  };

  const handleSelect = () => {
    if (!selectAvailable || !controller?.onSelect || cardBusy) return;
    controller.onSelect(pkg.id);
  };

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
          {selected && status === "ready" && (
            <span className="rounded bg-accent-action/15 px-1.5 py-0.5 text-[10px] text-accent-foreground">
              Selected
            </span>
          )}
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
              disabled={!loadAvailable || cardBusy || busy}
              onChange={(event) => setConsented(event.target.checked)}
              className="mt-0.5 accent-accent-action"
            />
            <span>
              I understand this downloads the pinned revision from Hugging Face and verifies SHA-256
              before use. Choose Browser speech explicitly to leave a local model.
            </span>
          </label>
        )}

        {cardBusy && (
          <p className="mt-2 text-[11px] text-on-surface-muted" role="status" aria-live="polite">
            {progressLabel(progress) ?? "Working…"}
          </p>
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
      </div>

      <div className="ml-2 flex shrink-0 flex-col items-end gap-2">
        {status === "ready" ? (
          <>
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle2 size={12} aria-hidden="true" />
              Ready
            </span>
            {selectAvailable &&
              (selected ? (
                <span className="text-xs font-medium text-accent-foreground" aria-current="true">
                  Selected
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Use ${pkg.displayName}`}
                  disabled={cardBusy}
                  onClick={handleSelect}
                  className="text-xs text-accent-foreground transition-colors hover:text-accent-foreground-hover disabled:opacity-50"
                >
                  Use
                </button>
              ))}
            {removeAvailable && (
              <button
                type="button"
                aria-label={`Remove ${pkg.displayName}`}
                disabled={cardBusy}
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
            disabled={!consented || cardBusy || Boolean(controller?.busyPackageId)}
            onClick={() => void handleLoad()}
            aria-label={`Load ${pkg.displayName}`}
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
  const prefs = controller?.preferences;
  const sttValue = prefs?.stt ?? "browser";
  const ttsValue = prefs?.tts ?? "browser";

  return (
    <fieldset className="space-y-4" data-testid="local-models-section">
      <legend className="mb-2 text-sm font-semibold text-on-surface">Local Models</legend>
      <p className="-mt-2 text-xs text-on-surface-muted">
        Local models run in your browser after an explicit load. Browser speech is used only when
        you select it — local load or inference failure does not fall back automatically. Packages
        are pinned by source, revision, license, size, and digest.
      </p>

      {controller?.error && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-error">
          <AlertCircle size={12} aria-hidden="true" />
          <span>{controller.error}</span>
          {controller.clearError && (
            <button type="button" className="underline" onClick={controller.clearError}>
              Dismiss
            </button>
          )}
        </p>
      )}

      {(controller?.selectStt || controller?.selectTts) && (
        <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
          <p className="text-xs font-medium text-on-surface-secondary">Active local selection</p>
          {controller.selectStt && (
            <div>
              <label
                htmlFor="local-stt-selection"
                className="mb-1 block text-xs font-medium text-on-surface-secondary"
              >
                Speech-to-text
              </label>
              <select
                id="local-stt-selection"
                aria-label="Local speech-to-text selection"
                value={sttValue}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "browser" || isLocalSttPackageId(value)) {
                    controller.selectStt?.(value);
                  }
                }}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
              >
                <option value="browser">Browser speech</option>
                {packages
                  .filter((pkg) => isLocalSttPackageId(pkg.id))
                  .map((pkg) => (
                    <option
                      key={pkg.id}
                      value={pkg.id}
                      disabled={(controller.getStatus?.(pkg.id) ?? "not_loaded") !== "ready"}
                    >
                      {pkg.displayName}
                      {(controller.getStatus?.(pkg.id) ?? "not_loaded") !== "ready"
                        ? " (not loaded)"
                        : ""}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {controller.selectTts && (
            <div>
              <label
                htmlFor="local-tts-selection"
                className="mb-1 block text-xs font-medium text-on-surface-secondary"
              >
                Text-to-speech
              </label>
              <select
                id="local-tts-selection"
                aria-label="Local text-to-speech selection"
                value={ttsValue}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "browser" || isLocalTtsPackageId(value)) {
                    controller.selectTts?.(value);
                  }
                }}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
              >
                <option value="browser">Browser speech</option>
                {packages
                  .filter((pkg) => isLocalTtsPackageId(pkg.id))
                  .map((pkg) => (
                    <option
                      key={pkg.id}
                      value={pkg.id}
                      disabled={(controller.getStatus?.(pkg.id) ?? "not_loaded") !== "ready"}
                    >
                      {pkg.displayName}
                      {(controller.getStatus?.(pkg.id) ?? "not_loaded") !== "ready"
                        ? " (not loaded)"
                        : ""}
                    </option>
                  ))}
              </select>
            </div>
          )}
        </div>
      )}

      <div className="space-y-3" aria-live="polite">
        {packages.map((pkg) => (
          <LocalModelCard key={pkg.id} pkg={pkg} controller={controller} />
        ))}
      </div>
    </fieldset>
  );
}
