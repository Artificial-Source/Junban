/** Simple real-path routing using the History API. No hash routing (fragment reserved for auth). */

import { useCallback, useEffect, useState } from "react";

export type View = "today" | "inbox";

/** Parse the current path to a view. */
export function pathToView(path: string): View {
  if (path === "/inbox") return "inbox";
  // Default and /today both map to today
  return "today";
}

/** Get the URL path for a view. */
export function viewToPath(view: View): string {
  return view === "today" ? "/" : "/inbox";
}

export function useRouting(): {
  view: View;
  navigate: (view: View) => void;
} {
  const [view, setView] = useState<View>(() => pathToView(window.location.pathname));

  useEffect(() => {
    const handlePopState = () => {
      setView(pathToView(window.location.pathname));
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((target: View) => {
    const path = viewToPath(target);
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
      setView(target);
    }
  }, []);

  return { view, navigate };
}
