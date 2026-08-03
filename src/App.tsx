import { lazy, Suspense, useState, useEffect } from "react";
import { bootstrapFragmentToken, hasStoredToken } from "./ui/api/client";
import { initTheme, applyDefaultAccentColor } from "./ui/themes/manager";
import { useRouting } from "./ui/hooks/useRouting";
import { WorkspaceProvider } from "./ui/context/WorkspaceContext";
import { AppLayout } from "./ui/app/AppLayout";
import { ConnectionScreen } from "./ui/components/ConnectionScreen";
import { readPhase6VisualScene } from "./ui/lib/phase6VisualFixture";

// Lazy so Phase 6 harness / voice presentation never enter the ordinary startup graph.
const Phase6VisualRoot = lazy(() =>
  import("./ui/ai/phase6/Phase6VisualRoot").then((module) => ({
    default: module.Phase6VisualRoot,
  })),
);

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  // Pin fixture identity at first paint so later navigations cannot arm side effects.
  const [phase6Scene] = useState(() => readPhase6VisualScene());

  // Initialize the theme and accept connection links on first load or same-page navigation.
  useEffect(() => {
    // Phase 6 harness owns theme/accent; do not let initTheme clobber dark scenes.
    if (!phase6Scene) {
      initTheme();
      applyDefaultAccentColor();
    }

    const authenticateFromLocation = () => {
      if (bootstrapFragmentToken() || hasStoredToken()) {
        setAuthenticated(true);
      }
    };

    authenticateFromLocation();
    window.addEventListener("hashchange", authenticateFromLocation);
    return () => window.removeEventListener("hashchange", authenticateFromLocation);
  }, [phase6Scene]);

  // useRouting is called here to ensure the History API listener is registered early.
  useRouting();

  // Explicit Phase 6 visual harness — no workspace, config, session, voice, or network.
  if (phase6Scene) {
    return (
      <Suspense fallback={null}>
        <Phase6VisualRoot scene={phase6Scene} />
      </Suspense>
    );
  }

  if (!authenticated) {
    return <ConnectionScreen />;
  }

  return (
    <WorkspaceProvider>
      <AppLayout />
    </WorkspaceProvider>
  );
}
