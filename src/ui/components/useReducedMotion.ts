/**
 * Hook that checks both OS `prefers-reduced-motion` and the app's `reduce_animations` setting.
 * Returns `true` when either indicates animations should be reduced.
 */
import { useState, useEffect } from "react";
import { useGeneralSettings } from "../context/SettingsContext.js";

export function useReducedMotion(): boolean {
  const { settings } = useGeneralSettings();
  const [osPrefersReduced, setOsPrefersReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => setOsPrefersReduced(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return osPrefersReduced || settings.reduce_animations === "true";
}
