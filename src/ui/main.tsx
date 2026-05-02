import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "./themes/manager.js"; // Initialize theme before render
import { beginNamedPerfSpan, markPerf } from "../utils/perf.js";

const QuickCapture = lazy(() =>
  import("./views/QuickCapture.js").then((module) => ({ default: module.QuickCapture })),
);

type AppComponentType = React.ComponentType;
type RemoteAccessGateComponentType = React.ComponentType<{ children: React.ReactNode }>;

/** Render the quick-capture view when the URL path matches /quick-capture */
const isQuickCapture = window.location.pathname === "/quick-capture";

beginNamedPerfSpan("junban:startup");
markPerf("junban:main-entry");

const root = ReactDOM.createRoot(document.getElementById("root")!);

function renderQuickCapture() {
  root.render(
    <React.StrictMode>
      <Suspense fallback={null}>
        <QuickCapture />
      </Suspense>
    </React.StrictMode>,
  );
}

function renderApp(
  AppComponent: AppComponentType,
  RemoteAccessGateComponent: RemoteAccessGateComponentType,
) {
  root.render(
    <React.StrictMode>
      <RemoteAccessGateComponent>
        <AppComponent />
      </RemoteAccessGateComponent>
    </React.StrictMode>,
  );
}

function renderStartupError(message: string) {
  root.render(
    <React.StrictMode>
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-slate-100">
        <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl">
          <h1 className="text-lg font-semibold">Desktop backend unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">{message}</p>
          <p className="mt-4 text-xs leading-5 text-slate-400">
            Try relaunching the app. If the problem persists, Junban could not establish or keep its
            local desktop backend running.
          </p>
        </div>
      </div>
    </React.StrictMode>,
  );
}

void (async () => {
  try {
    const { waitForDesktopApiReady } = await import("./api/helpers.js");
    await waitForDesktopApiReady();

    if (isQuickCapture) {
      renderQuickCapture();
      return;
    }

    const [{ App }, { RemoteAccessGate }] = await Promise.all([
      import("./App.js"),
      import("./components/RemoteAccessGate.js"),
    ]);

    renderApp(App, RemoteAccessGate);
  } catch (error) {
    console.error("[desktop-backend] Failed to wait for local backend:", error);
    renderStartupError(
      error instanceof Error ? error.message : "The packaged desktop backend did not become ready.",
    );
  }
})();
