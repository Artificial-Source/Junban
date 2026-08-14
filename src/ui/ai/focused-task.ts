/**
 * Focused-task launch query helpers for /ai-chat.
 * Query-only; does not invent route authority.
 */

/** Same UUID grammar as useRouting (not re-exported from there). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FOCUSED_TASK_QUERY = "focusedTaskId";
export const FOCUSED_TASK_PROMPT_QUERY = "prompt";

/** Extract a validated focused task UUID from a location search string. */
export function readFocusedTaskId(search: string = window.location.search): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const raw = params.get(FOCUSED_TASK_QUERY)?.trim() ?? "";
  if (!raw || !UUID_RE.test(raw)) return null;
  return raw;
}

/** Optional concrete prompt carried with a focused-task launch. */
export function readFocusedTaskPrompt(search: string = window.location.search): string | null {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const raw = params.get(FOCUSED_TASK_PROMPT_QUERY)?.trim() ?? "";
  return raw.length > 0 ? raw : null;
}

/** Build the canonical focused-task AI chat URL. */
export function aiChatFocusedTaskUrl(taskId: string, prompt?: string | null): string {
  const params = new URLSearchParams();
  params.set(FOCUSED_TASK_QUERY, taskId);
  if (prompt && prompt.trim()) {
    params.set(FOCUSED_TASK_PROMPT_QUERY, prompt.trim());
  }
  return `/ai-chat?${params.toString()}`;
}
