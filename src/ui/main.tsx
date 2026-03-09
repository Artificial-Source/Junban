import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { QuickCapture } from "./views/QuickCapture.js";
import "./index.css";
import "./themes/manager.js"; // Initialize theme before render

/** Render the quick-capture view when the URL path matches /quick-capture */
const isQuickCapture = window.location.pathname === "/quick-capture";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isQuickCapture ? <QuickCapture /> : <App />}</React.StrictMode>,
);
