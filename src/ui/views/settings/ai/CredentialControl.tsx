/**
 * Write-only credential set / replace / delete control.
 * Never prefills, renders, stores, or logs secret bytes after submit.
 */

import { useId, useState } from "react";
import type {
  AiCredentialMetadataDto,
  AiCredentialTargetDto,
  AiSecretKindDto,
} from "../../../ai/types";
import { primaryButtonClass, secondaryButtonClass } from "../settingsHelpers";
import { ConfirmDialog } from "../../../components/ConfirmDialog";

export function CredentialControl({
  target,
  label = "API Key",
  helpText,
  present,
  metadata,
  defaultKind = "api_key",
  kindOptions,
  busy = false,
  disabled = false,
  onSubmit,
  onDelete,
}: {
  target: AiCredentialTargetDto;
  label?: string;
  helpText?: string;
  present: boolean;
  metadata?: AiCredentialMetadataDto | null;
  defaultKind?: AiSecretKindDto;
  kindOptions?: { value: AiSecretKindDto; label: string }[];
  busy?: boolean;
  disabled?: boolean;
  onSubmit: (body: { kind: AiSecretKindDto; secret: string }) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const inputId = useId();
  const kindId = useId();
  const [secret, setSecret] = useState("");
  const [kind, setKind] = useState<AiSecretKindDto>(defaultKind);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const value = secret.trim();
    if (!value) {
      setLocalError("Enter a credential value before saving.");
      return;
    }
    setLocalError(null);
    const payload = { kind, secret: value };
    const ok = await onSubmit(payload);
    // Scrub local state regardless of outcome once handed off.
    setSecret("");
    payload.secret = "";
    if (!ok && !localError) {
      // Parent surfaces transport errors; keep field empty.
    }
  };

  const handleDelete = async () => {
    setConfirmDelete(false);
    setLocalError(null);
    await onDelete();
    setSecret("");
  };

  return (
    <div data-testid={`credential-control-${target}`} className="space-y-2">
      <div className="flex items-center gap-2">
        <label htmlFor={inputId} className="block text-xs font-medium text-on-surface-secondary">
          {label}
          {present && <span className="ml-2 font-normal text-success">Configured</span>}
        </label>
      </div>

      {kindOptions && kindOptions.length > 1 && (
        <div>
          <label htmlFor={kindId} className="sr-only">
            Credential kind
          </label>
          <select
            id={kindId}
            value={kind}
            disabled={disabled || busy}
            onChange={(event) => setKind(event.target.value as AiSecretKindDto)}
            className="mb-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
          >
            {kindOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <input
        id={inputId}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={secret}
        disabled={disabled || busy}
        onChange={(event) => {
          setSecret(event.target.value);
          setLocalError(null);
        }}
        placeholder={present ? "Enter new value to replace" : "Enter credential"}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface disabled:opacity-50"
      />

      {helpText && <p className="text-xs text-on-surface-muted">{helpText}</p>}

      {metadata?.present && metadata.kind && (
        <p className="text-[11px] text-on-surface-muted">
          Stored kind: {metadata.kind.replaceAll("_", " ")}
        </p>
      )}

      {localError && (
        <p role="alert" className="text-xs text-error">
          {localError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled || busy || !secret.trim()}
          onClick={() => void handleSubmit()}
          className={primaryButtonClass(disabled || busy || !secret.trim())}
        >
          {present ? "Replace" : "Save credential"}
        </button>
        {present && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => setConfirmDelete(true)}
            className={secondaryButtonClass(disabled || busy)}
          >
            Remove
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Remove credential?"
        message="The stored credential binding will be deleted. This cannot be undone from Settings."
        confirmLabel="Remove credential"
        cancelLabel="Cancel"
        pending={busy}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
