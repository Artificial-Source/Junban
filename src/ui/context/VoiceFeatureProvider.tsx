import type { ReactNode } from "react";
import { VoiceProvider } from "./VoiceContext.js";

export function VoiceFeatureProvider({ children }: { children: ReactNode }) {
  return <VoiceProvider>{children}</VoiceProvider>;
}
