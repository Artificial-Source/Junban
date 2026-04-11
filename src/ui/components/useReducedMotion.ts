/**
 * Hook that checks both OS `prefers-reduced-motion` and the app's `reduce_animations` setting.
 * Returns `true` when either indicates animations should be reduced.
 */
import { useState, useEffect } from "react";

export function useReducedMotion(): boolean {
  const [osPrefersReduced, setOsPrefersReduced] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  const [appPrefersReduced, setAppPrefersReduced] = useState(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.classList.contains("reduce-motion");
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (e: MediaQueryListEvent) => {
      setOsPrefersReduced((prev) => (prev === e.matches ? prev : e.matches));
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;

    const root = document.documentElement;
    const sync = () => {
      const next = root.classList.contains("reduce-motion");
      setAppPrefersReduced((prev) => (prev === next ? prev : next));
    };

    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return osPrefersReduced || appPrefersReduced;
}
