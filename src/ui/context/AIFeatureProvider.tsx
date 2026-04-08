import type { ReactNode } from "react";
import { AIProvider } from "./AIContext.js";

export function AIFeatureProvider({ children }: { children: ReactNode }) {
  return <AIProvider>{children}</AIProvider>;
}
