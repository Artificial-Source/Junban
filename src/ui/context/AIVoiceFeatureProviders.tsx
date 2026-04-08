import type { ReactNode } from "react";
import { AIProvider } from "./AIContext.js";
import { VoiceProvider } from "./VoiceContext.js";

export function AIVoiceFeatureProviders({ children }: { children: ReactNode }) {
  return (
    <AIProvider>
      <VoiceProvider>{children}</VoiceProvider>
    </AIProvider>
  );
}
