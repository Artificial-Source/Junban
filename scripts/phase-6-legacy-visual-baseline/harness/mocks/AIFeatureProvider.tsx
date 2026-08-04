import type { ReactNode } from "react";
import { AIProvider } from "./AIContext";

export function AIFeatureProvider({ children }: { children: ReactNode }) {
  return <AIProvider>{children}</AIProvider>;
}
