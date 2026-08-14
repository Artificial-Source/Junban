import { lazy, Suspense, useState, useEffect } from "react";
import { bootstrapFragmentToken, hasStoredToken } from "./ui/api/client";
import { initTheme, applyDefaultAccentColor } from "./ui/themes/manager";
import { useRouting } from "./ui/hooks/useRouting";
import { WorkspaceProvider } from "./ui/context/WorkspaceContext";
import { PluginProvider } from "./ui/plugins/PluginProvider";
import { AppLayout } from "./ui/app/AppLayout";
import { ConnectionScreen } from "./ui/components/ConnectionScreen";
import { isPhase6LocalVoiceAcceptance } from "./ui/lib/phase6LocalVoiceAcceptance";
import { readPhase6VisualScene } from "./ui/lib/phase6VisualFixture";
import { readPhase7VisualScene } from "./ui/lib/phase7VisualFixture";

// Lazy so Phase 6 harness / voice presentation never enter the ordinary startup graph.
const Phase6VisualRoot = lazy(() =>
  import("./ui/ai/phase6/Phase6VisualRoot").then((module) => ({
    default: module.Phase6VisualRoot,
  })),
);

const Phase7VisualRoot = lazy(() =>
  import("./ui/plugins/phase7/Phase7VisualRoot").then((module) => ({
    default: module.Phase7VisualRoot,
  })),
);

// Opt-in Wave 5 local-voice acceptance only — never in the ordinary chunk graph until gated.
const LocalVoiceAcceptanceRoot = lazy(() =>
  import("./ui/voice/acceptance/LocalVoiceAcceptanceRoot").then((module) => ({
    default: module.LocalVoiceAcceptanceRoot,
  })),
);

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  // Pin fixture identity at first paint so later navigations cannot arm side effects.
  const [phase6Scene] = useState(() => readPhase6VisualScene());
  const [phase7Scene] = useState(() => readPhase7VisualScene());
  const [localVoiceAcceptance] = useState(() => isPhase6LocalVoiceAcceptance());

  // Initialize the theme and accept connection links on first load or same-page navigation.
  useEffect(() => {
    // Phase 6 harness owns theme/accent; do not let initTheme clobber dark scenes.
    if (!phase6Scene && !phase7Scene) {
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
  }, [phase6Scene, phase7Scene]);

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

  // Explicit Phase 7 Extensions/plugin visual harness — offline fixture only.
  if (phase7Scene) {
    return (
      <Suspense fallback={null}>
        <Phase7VisualRoot scene={phase7Scene} />
      </Suspense>
    );
  }

  // Explicit opt-in local-voice acceptance — authenticated shell without ordinary chrome.
  if (localVoiceAcceptance) {
    if (!authenticated) {
      return <ConnectionScreen />;
    }
    return (
      <Suspense fallback={null}>
        <LocalVoiceAcceptanceRoot />
      </Suspense>
    );
  }

  if (!authenticated) {
    return <ConnectionScreen />;
  }

  return (
    <WorkspaceProvider>
      <PluginProvider>
        <AppLayout />
      </PluginProvider>
    </WorkspaceProvider>
  );
}
