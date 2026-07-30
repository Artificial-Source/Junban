import { useState, useEffect } from "react";
import { bootstrapFragmentToken, hasStoredToken } from "./ui/api/client";
import { initTheme, applyDefaultAccentColor } from "./ui/themes/manager";
import { useRouting } from "./ui/hooks/useRouting";
import { WorkspaceProvider } from "./ui/context/WorkspaceContext";
import { AppLayout } from "./ui/app/AppLayout";
import { ConnectionScreen } from "./ui/components/ConnectionScreen";

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);

  // Initialize the theme and accept connection links on first load or same-page navigation.
  useEffect(() => {
    initTheme();
    applyDefaultAccentColor();

    const authenticateFromLocation = () => {
      if (bootstrapFragmentToken() || hasStoredToken()) {
        setAuthenticated(true);
      }
    };

    authenticateFromLocation();
    window.addEventListener("hashchange", authenticateFromLocation);
    return () => window.removeEventListener("hashchange", authenticateFromLocation);
  }, []);

  // useRouting is called here to ensure the History API listener is registered early.
  useRouting();

  if (!authenticated) {
    return <ConnectionScreen />;
  }

  return (
    <WorkspaceProvider>
      <AppLayout />
    </WorkspaceProvider>
  );
}
