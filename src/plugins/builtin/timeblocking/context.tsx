import { createContext, useContext } from "react";
import type TimeblockingPlugin from "./index.js";

const TimeblockingContext = createContext<TimeblockingPlugin | null>(null);

export function useTimeblocking(): TimeblockingPlugin {
  const plugin = useContext(TimeblockingContext);
  if (!plugin) {
    throw new Error("useTimeblocking must be used within a TimeblockingProvider");
  }
  return plugin;
}

export { TimeblockingContext };
