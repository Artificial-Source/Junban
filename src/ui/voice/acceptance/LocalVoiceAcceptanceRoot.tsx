/**
 * Opt-in Phase 6 Wave 5 local-voice acceptance surface.
 *
 * Mounted only when `acceptance=phase-6-local-voice`. Lazy-loaded from App so
 * ordinary startup never imports local engines, workers, or this module.
 * Non-secret, allowlisted, inaccessible from normal navigation chrome.
 */

import { useCallback, useEffect, useState } from "react";
import type { LocalVoiceAcceptanceInput, LocalVoiceAcceptanceReport } from "./types.ts";

declare global {
  interface Window {
    __junbanLocalVoiceAcceptanceInput?: LocalVoiceAcceptanceInput;
    __junbanLocalVoiceAcceptanceResult?: LocalVoiceAcceptanceReport;
    __junbanLocalVoiceAcceptanceRun?: () => Promise<LocalVoiceAcceptanceReport>;
  }
}

export function LocalVoiceAcceptanceRoot() {
  const [status, setStatus] = useState<"idle" | "running" | "done">("idle");
  const [progress, setProgress] = useState("Waiting for fixture input…");
  const [report, setReport] = useState<LocalVoiceAcceptanceReport | null>(null);

  const run = useCallback(async () => {
    const input = window.__junbanLocalVoiceAcceptanceInput;
    if (!input?.fixtureWavBase64) {
      setProgress("Missing window.__junbanLocalVoiceAcceptanceInput.fixtureWavBase64");
      return null;
    }
    setStatus("running");
    setProgress("Starting…");
    const { runLocalVoiceAcceptance } = await import("./runLocalVoiceAcceptance.ts");
    const result = await runLocalVoiceAcceptance(input, (message) => setProgress(message));
    window.__junbanLocalVoiceAcceptanceResult = result;
    setReport(result);
    setStatus("done");
    setProgress(result.status === "passed" ? "Passed" : `Finished: ${result.status}`);
    return result;
  }, []);

  useEffect(() => {
    document.documentElement.dataset.localVoiceAcceptance = "1";
    window.__junbanLocalVoiceAcceptanceRun = () =>
      run().then((r) => {
        if (!r) {
          throw new Error("Local voice acceptance input missing");
        }
        return r;
      });
    return () => {
      delete document.documentElement.dataset.localVoiceAcceptance;
      delete window.__junbanLocalVoiceAcceptanceRun;
    };
  }, [run]);

  return (
    <main
      data-testid="local-voice-acceptance-root"
      className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 bg-surface p-6 text-on-surface"
    >
      <header>
        <h1 className="text-xl font-semibold">Phase 6 local-voice acceptance</h1>
        <p className="mt-1 text-sm text-on-surface-muted">
          Opt-in harness only. Downloads hash-pinned Whisper, Kokoro, and Piper weights after
          explicit run, executes real inference, and records cleanup evidence. Not linked from
          ordinary navigation.
        </p>
      </header>

      <p
        className="text-sm"
        role="status"
        aria-live="polite"
        data-testid="local-voice-acceptance-progress"
      >
        {progress}
      </p>

      <div className="flex gap-3">
        <button
          type="button"
          data-testid="local-voice-acceptance-run"
          disabled={status === "running"}
          onClick={() => void run()}
          className="rounded-lg bg-accent-action px-4 py-2 text-sm font-medium text-on-accent-action disabled:opacity-50"
        >
          {status === "running" ? "Running…" : "Run acceptance"}
        </button>
      </div>

      {report && (
        <section
          data-testid="local-voice-acceptance-report"
          data-status={report.status}
          className="rounded-lg border border-border bg-surface-secondary p-4"
        >
          <h2 className="mb-2 text-sm font-semibold">Report: {report.status}</h2>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-on-surface-secondary">
            {JSON.stringify(report, null, 2)}
          </pre>
        </section>
      )}
    </main>
  );
}

export default LocalVoiceAcceptanceRoot;
