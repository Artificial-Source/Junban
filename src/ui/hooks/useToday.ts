/** Returns the browser's local civil day as a YYYY-MM-DD string. */
import { useEffect, useState } from "react";
import { todayKey } from "../lib/dates";

export function useToday(): string {
  const [today, setToday] = useState(() => todayKey());

  useEffect(() => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();
    const timeout = setTimeout(() => {
      setToday(todayKey());
    }, msUntilMidnight + 50);
    return () => clearTimeout(timeout);
  }, [today]);

  return today;
}
