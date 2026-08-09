/** Offline harness stubs for StatusBar and related helpers. */

export function isTauri(): boolean {
  return false;
}

export function useDirectServices(): boolean {
  // Prefer direct onClick handlers from fixture status items; no REST traffic.
  return true;
}

export const BASE = "http://127.0.0.1/__phase7_offline__";

export async function apiFetch(): Promise<Response> {
  throw new Error("Network disabled in Phase 7 legacy visual harness");
}

export async function handleResponse<T>(): Promise<T> {
  throw new Error("Network disabled in Phase 7 legacy visual harness");
}

export async function handleVoidResponse(): Promise<void> {
  throw new Error("Network disabled in Phase 7 legacy visual harness");
}
