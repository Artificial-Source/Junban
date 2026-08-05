/**
 * Hosted — allowed hosts list and one-time token rotation with ConfirmDialog.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  generateOperationId,
  getHosts,
  putHosts,
  rotateToken,
  storeToken,
} from "../../api/client";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useWorkspace } from "../../context/WorkspaceContext";
import { SettingsStatusBanner } from "./settingsComponents";
import { isValidHostname, primaryButtonClass, secondaryButtonClass } from "./settingsHelpers";

export function HostedTab() {
  const { showToast } = useWorkspace();
  const [hosts, setHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [draftHost, setDraftHost] = useState("");
  const [rotating, setRotating] = useState(false);
  const [confirmRotateOpen, setConfirmRotateOpen] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadHosts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getHosts();
      setHosts(response.hosts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load allowed hosts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHosts();
  }, [loadHosts]);

  const persistHosts = useCallback(
    async (next: string[]) => {
      setSaving(true);
      setError(null);
      setFieldError(null);
      try {
        const response = await putHosts({ hosts: next });
        setHosts(response.hosts);
        showToast("success", "Hosts updated");
      } catch (err) {
        if (err instanceof ApiError) {
          setError(err.message);
          if (err.fields) {
            const first = Object.values(err.fields)[0];
            if (first) setFieldError(first);
          }
        } else {
          setError("Could not update hosts.");
        }
      } finally {
        setSaving(false);
      }
    },
    [showToast],
  );

  const handleAdd = useCallback(() => {
    const host = draftHost.trim().toLowerCase();
    setFieldError(null);
    if (!host) {
      setFieldError("Enter a hostname.");
      return;
    }
    if (!isValidHostname(host)) {
      setFieldError("Hostname must be ASCII-only without ports, paths, or wildcards.");
      return;
    }
    if (hosts.some((existing) => existing.toLowerCase() === host)) {
      setFieldError("That host is already listed.");
      return;
    }
    setDraftHost("");
    void persistHosts([...hosts, host]);
  }, [draftHost, hosts, persistHosts]);

  const handleRemove = useCallback(
    (host: string) => {
      void persistHosts(hosts.filter((item) => item !== host));
    },
    [hosts, persistHosts],
  );

  const handleRotateConfirm = useCallback(async () => {
    if (rotating) return;
    setRotating(true);
    setError(null);
    setNewToken(null);
    setCopied(false);
    try {
      const response = await rotateToken(generateOperationId());
      setNewToken(response.token);
      storeToken(response.token);
      setConfirmRotateOpen(false);
      showToast("info", "Token rotated — copy it now");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Token rotation failed.");
      setConfirmRotateOpen(false);
    } finally {
      setRotating(false);
    }
  }, [rotating, showToast]);

  const handleCopy = useCallback(async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      showToast("success", "Token copied");
    } catch {
      setFieldError("Could not copy automatically — select and copy the token manually.");
    }
  }, [newToken, showToast]);

  return (
    <div className="space-y-8">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-on-surface">Hosted</h2>
        <p className="mt-1 text-sm text-on-surface-muted">Access control for the hosted server.</p>
      </div>

      {error && <SettingsStatusBanner kind="error">{error}</SettingsStatusBanner>}

      <section className="space-y-4">
        <h3 className="text-base font-semibold text-on-surface">Allowed hosts</h3>
        <p className="max-w-lg text-sm text-on-surface-muted">
          CLI hosts are always retained. Extra hostnames must be plain ASCII without ports.
        </p>
        {loading ? (
          <p className="text-sm text-on-surface-muted">Loading hosts…</p>
        ) : (
          <>
            <ul className="max-w-lg divide-y divide-border rounded-lg border border-border">
              {hosts.length === 0 ? (
                <li className="px-3 py-3 text-sm text-on-surface-muted">No hosts configured.</li>
              ) : (
                hosts.map((host) => (
                  <li
                    key={host}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate font-mono text-on-surface">{host}</span>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => handleRemove(host)}
                      className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-on-surface-secondary transition-colors hover:bg-surface-tertiary hover:text-on-surface focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </li>
                ))
              )}
            </ul>

            <div className="flex max-w-lg flex-col gap-2 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1 space-y-1.5">
                <span className="text-sm text-on-surface">Add hostname</span>
                <input
                  value={draftHost}
                  placeholder="example.ts.net"
                  disabled={saving}
                  onChange={(event) => setDraftHost(event.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-sm text-on-surface focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:opacity-50"
                />
                {fieldError && (
                  <span className="block text-xs text-error" role="alert">
                    {fieldError}
                  </span>
                )}
              </label>
              <button
                type="button"
                disabled={saving}
                onClick={handleAdd}
                className={primaryButtonClass(saving)}
              >
                {saving ? "Saving…" : "Add host"}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="space-y-4">
        <h3 className="text-base font-semibold text-on-surface">Access token</h3>
        <p className="max-w-lg text-sm text-on-surface-secondary">
          Rotation invalidates the previous token immediately. Save the new value somewhere safe —
          it is shown only once.
        </p>
        <button
          type="button"
          disabled={rotating}
          onClick={() => setConfirmRotateOpen(true)}
          className={secondaryButtonClass(rotating)}
        >
          {rotating ? "Rotating…" : "Rotate token"}
        </button>

        {newToken && (
          <div className="max-w-lg space-y-3 rounded-lg border border-border bg-surface-secondary p-3">
            <SettingsStatusBanner kind="warning">
              Save this token — it will not be shown again.
            </SettingsStatusBanner>
            <label htmlFor="rotated-token" className="block text-sm font-medium text-on-surface">
              New access token
            </label>
            <textarea
              id="rotated-token"
              readOnly
              value={newToken}
              rows={3}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-on-surface focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              type="button"
              onClick={() => void handleCopy()}
              className={primaryButtonClass()}
            >
              {copied ? "Copied" : "Copy to clipboard"}
            </button>
          </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmRotateOpen}
        title="Rotate access token?"
        message="Rotate the access token? Existing clients will need the new token immediately."
        confirmLabel="Rotate token"
        cancelLabel="Cancel"
        danger
        pending={rotating}
        onConfirm={() => void handleRotateConfirm()}
        onCancel={() => {
          if (!rotating) setConfirmRotateOpen(false);
        }}
      />
    </div>
  );
}
