import type { DailyStat } from "../../core/types.js";
import { useDirectServices, BASE, buildApiUrl, handleResponse, getServices } from "./helpers.js";

export async function getDailyStats(startDate: string, endDate: string): Promise<DailyStat[]> {
  if (useDirectServices()) {
    const svc = await getServices();
    return svc.statsService.getStats(startDate, endDate);
  }
  const res = await fetch(
    buildApiUrl("/stats/daily", {
      startDate,
      endDate,
    }),
  );
  return handleResponse<DailyStat[]>(res);
}

export async function getTodayStats(): Promise<DailyStat> {
  if (useDirectServices()) {
    const svc = await getServices();
    return svc.statsService.getToday();
  }
  const res = await fetch(`${BASE}/stats/today`);
  return handleResponse<DailyStat>(res);
}
