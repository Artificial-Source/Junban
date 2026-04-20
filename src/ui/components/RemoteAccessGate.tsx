import { useEffect, useState } from "react";
import { Globe, Loader2, Lock } from "lucide-react";
import {
  claimRemoteSession,
  getRemoteSessionStatus,
  loginRemoteSession,
  type RemoteSessionStatus,
} from "../api/desktop-server.js";
import { isRemoteDesktopRuntime } from "../../utils/runtime.js";

export function RemoteAccessGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<RemoteSessionStatus | null>(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isRemoteDesktopRuntime()) {
      return;
    }

    void getRemoteSessionStatus()
      .then(setStatus)
      .catch((err: unknown) => {
        console.error("[remote-access] Failed to load session status:", err);
        setError("Could not connect to the desktop app.");
      });
  }, []);

  if (!isRemoteDesktopRuntime()) {
    return <>{children}</>;
  }

  if (status?.authorized) {
    return <>{children}</>;
  }

  const refresh = async () => {
    try {
      setStatus(await getRemoteSessionStatus());
      setError(null);
    } catch (err) {
      console.error("[remote-access] Failed to refresh session status:", err);
      setError("Could not connect to the desktop app.");
    }
  };

  const unlock = async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await loginRemoteSession(password));
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlock remote access.");
    } finally {
      setLoading(false);
    }
  };

  const claim = async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await claimRemoteSession());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect this browser.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface text-on-surface flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface-secondary/40 p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="rounded-xl bg-accent/10 p-3 text-accent">
            {status?.requiresPassword ? <Lock size={22} /> : <Globe size={22} />}
          </div>
          <div>
            <h1 className="text-lg font-semibold text-on-surface">Remote Access</h1>
            <p className="text-sm text-on-surface-secondary">
              Connect to your desktop Junban session.
            </p>
          </div>
        </div>

        {status?.sessionLocked ? (
          <p className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-on-surface-secondary">
            Another remote browser session is already connected. Stop and restart remote access from
            the desktop app to switch devices.
          </p>
        ) : status?.requiresPassword ? (
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-sm text-on-surface-secondary">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void unlock();
                  }
                }}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-on-surface"
              />
            </label>
            <button
              onClick={() => {
                void unlock();
              }}
              disabled={loading || password.trim().length === 0}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />}
              Unlock
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-on-surface-secondary">
              Connect this browser to become the active remote session.
            </p>
            <button
              onClick={() => {
                void claim();
              }}
              disabled={loading}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-sm text-on-surface hover:bg-surface-tertiary"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Globe size={16} />}
              Connect
            </button>
            <button
              onClick={() => {
                void refresh();
              }}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-sm text-on-surface hover:bg-surface-tertiary"
            >
              Refresh status
            </button>
          </div>
        )}

        <p
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className={`mt-3 min-h-5 text-sm ${error ? "text-error" : "text-transparent"}`}
        >
          {error ?? ""}
        </p>
      </div>
    </div>
  );
}
