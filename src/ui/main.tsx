import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import "./index.css";
import "./themes/manager.js"; // Initialize theme before render

const QuickCapture = lazy(() =>
  import("./views/QuickCapture.js").then((module) => ({ default: module.QuickCapture })),
);

/** Render the quick-capture view when the URL path matches /quick-capture */
const isQuickCapture = window.location.pathname === "/quick-capture";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isQuickCapture ? (
      <Suspense fallback={null}>
        <QuickCapture />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
