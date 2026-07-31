/**
 * Browser-only Phase 2 API facade over checked generated.ts types.
 * Components never know transport details; this is the only fetch boundary.
 */

import { isCommittedEvent, isKnownEventType, isResyncRequired } from "./events";
import type {
  AcquireReminderLeaseRequest,
  AddRelationRequest,
  AppendTimeSlotTaskRequest,
  ApplyTemplateRequest,
  BulkTasksRequest,
  CalendarTasksParams,
  CalendarTasksResponse,
  CatalogResponse,
  ClaimRemindersRequest,
  ClaimRemindersResponse,
  CommentListResponse,
  CommittedEventDto,
  CreateCommentRequest,
  CreateProjectRequest,
  CreateSavedFilterRequest,
  CreateSectionRequest,
  CreateTagRequest,
  CreateTaskRequest,
  CreateTemplateRequest,
  CreateTimeBlockRequest,
  CreateTimeSlotRequest,
  DailyPlanResponse,
  DopamineMenuResponse,
  EatTheFrogResponse,
  EndOfDayResponse,
  ErrorEnvelope,
  HealthResponse,
  MarkOwnerLostRemindersRequest,
  MarkOwnerLostRemindersResponse,
  MoveTaskRequest,
  MoveTimeBlockRequest,
  MutationResponse,
  NudgesResponse,
  ParseFilterRequest,
  ParseQuickEntryRequest,
  ParseTextImportRequest,
  ParsedFilterResponse,
  PatchCommentRequest,
  PatchProjectRequest,
  PatchSavedFilterRequest,
  PatchSectionRequest,
  PatchTagRequest,
  PatchTaskRequest,
  PatchTemplateRequest,
  PatchTimeBlockRequest,
  PatchTimeSlotRequest,
  ProfileResponse,
  QuickEntryDto,
  RelationListResponse,
  ReleaseReminderLeaseRequest,
  ReminderDeliveryLeaseDto,
  ReminderListResponse,
  RenewReminderLeaseRequest,
  ReorderTasksRequest,
  ReplaceTimeSlotTasksRequest,
  ReplanTimeBlocksRequest,
  RescheduleReminderRequest,
  ResizeTimeBlockRequest,
  SettleReminderDeliveredRequest,
  SettleReminderFailedRequest,
  StatsParams,
  StatsResponse,
  TaskActivityResponse,
  TaskJarResponse,
  TaskListParams,
  TaskListResponse,
  TemporalSettingsResponse,
  TextImportResponse,
  TimeBlockListResponse,
  TimeBlockRangeParams,
  TimeSlotListResponse,
  TimeSlotRangeParams,
  WeeklyReviewResponse,
} from "./types";

export type * from "./types";
export {
  KNOWN_EVENT_TYPES,
  RESYNC_REQUIRED_TYPE,
  isCommittedEvent,
  isKnownEventType,
  isResyncRequired,
  shouldPatchTaskFromEvent,
  taskFromCommittedEvent,
  taskSnapshotFrom,
} from "./events";

const TOKEN_STORAGE_KEY = "junban-access-token";
const MAX_TASK_PAGE_LIMIT = 100;
const DEFAULT_SSE_BACKOFF_MS = 1000;
const MAX_SSE_BACKOFF_MS = 30_000;
/** Bound ordinary finite API calls; long-lived SSE opts out explicitly. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

/** A typed API error with the server's error envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly fields: Record<string, string> | null;
  readonly details: unknown | null;

  constructor(
    message: string,
    options: {
      status: number;
      code: string;
      retryable: boolean;
      requestId: string;
      fields?: Record<string, string> | null;
      details?: unknown | null;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
    this.requestId = options.requestId;
    this.fields = options.fields ?? null;
    this.details = options.details ?? null;
  }
}

/** A network-level error when the server is unreachable or returns an invalid response. */
export class NetworkError extends Error {
  readonly retryable: boolean;
  readonly aborted: boolean;

  constructor(message: string, retryable = true, aborted = false) {
    super(message);
    this.name = "NetworkError";
    this.retryable = retryable && !aborted;
    this.aborted = aborted;
  }
}

/** Read the bearer token from sessionStorage. Returns null if absent. */
export function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Save the bearer token to sessionStorage. */
export function storeToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

/** Remove the bearer token from sessionStorage. */
export function clearStoredToken(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

/** Check whether a token is present (without exposing it). */
export function hasStoredToken(): boolean {
  return getStoredToken() !== null;
}

function decodeFragmentToken(fragment: string): string | null {
  const prefix = "access_token=";
  if (!fragment.startsWith(prefix)) return null;

  const encodedToken = fragment.slice(prefix.length);
  if (!encodedToken || encodedToken.includes("&")) return null;

  try {
    const token = decodeURIComponent(encodedToken.replace(/\+/g, " "));
    return token ? token : null;
  } catch {
    return null;
  }
}

/**
 * Parse and save an exact URL-fragment token, then scrub all token-bearing URL parts.
 * Query-string tokens are deliberately discarded and never used for authentication.
 * Tokens are never written to localStorage or logs.
 */
export function bootstrapFragmentToken(): boolean {
  const fragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const token = decodeFragmentToken(fragment);
  const query = new URLSearchParams(window.location.search);
  const hadQueryToken = query.has("access_token");
  query.delete("access_token");

  if (window.location.hash || hadQueryToken) {
    const search = query.toString();
    history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  }

  if (!token) return false;
  storeToken(token);
  return true;
}

/** Generate a UUID v4 idempotency key for one logical operation. */
export function generateOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older browsers.
  return "00000000-0000-4000-8000-000000000000".replace(/0/g, () =>
    Math.floor(Math.random() * 16).toString(16),
  );
}

function authHeaders(): Record<string, string> {
  const token = getStoredToken();
  if (!token) throw new NetworkError("No access token available", false);
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(operationId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    "Content-Type": "application/json",
  };
  if (operationId) {
    headers["Idempotency-Key"] = operationId;
  }
  return headers;
}

function mutationHeaders(operationId: string): Record<string, string> {
  return {
    ...authHeaders(),
    "Idempotency-Key": operationId,
  };
}

type RawFetchOptions = {
  /**
   * Milliseconds before the request is aborted as a retryable timeout.
   * `null` disables the timer (authenticated SSE). Default: {@link DEFAULT_REQUEST_TIMEOUT_MS}.
   */
  timeoutMs?: number | null;
};

async function rawFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: RawFetchOptions,
): Promise<Response> {
  const timeoutMs =
    options && "timeoutMs" in options ? options.timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  const externalSignal = init?.signal ?? undefined;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onExternalAbort = () => {
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      throw new NetworkError("Request aborted", false, true);
    }
    externalSignal.addEventListener("abort", onExternalAbort);
  }

  if (timeoutMs !== null && timeoutMs !== undefined) {
    const ms = Math.max(1, timeoutMs);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
      // Never send cookies cross-origin; same-origin is enough for the hosted shell.
      credentials: "same-origin",
    });
  } catch (error) {
    if (timedOut) {
      // Retryable transport failure — not a caller abort. Outcome may be unknown.
      throw new NetworkError("Request timed out", true, false);
    }
    if (isAbortError(error) || externalSignal?.aborted) {
      throw new NetworkError("Request aborted", false, true);
    }
    throw new NetworkError("Network request failed");
  } finally {
    if (timer !== null) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  if (!body || typeof body !== "object") return false;
  const envelope = body as Record<string, unknown>;
  if (
    typeof envelope.request_id !== "string" ||
    !envelope.error ||
    typeof envelope.error !== "object"
  ) {
    return false;
  }
  const error = envelope.error as Record<string, unknown>;
  return (
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean"
  );
}

function fieldsFromError(error: Record<string, unknown>): Record<string, string> | null {
  const fields = error.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function detailsFromError(error: Record<string, unknown>): unknown | null {
  if (!("details" in error)) return null;
  const details = error.details;
  if (details === null || details === undefined) return null;
  // Accept only JSON-ish values; never surface HTML response text here.
  if (
    typeof details === "string" ||
    typeof details === "number" ||
    typeof details === "boolean" ||
    (typeof details === "object" && !Array.isArray(details)) ||
    Array.isArray(details)
  ) {
    return details;
  }
  return null;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (isAbortError(error)) {
      throw new NetworkError("Request aborted", false, true);
    }
    throw new NetworkError("Could not read the server response", response.ok);
  }
  if (!text) {
    throw new NetworkError(
      `Server returned an empty response (status ${response.status})`,
      response.ok,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Never include response body text (may be HTML) in the thrown message.
    throw new NetworkError(
      `Server returned non-JSON response (status ${response.status})`,
      response.ok,
    );
  }

  if (!response.ok) {
    if (!isErrorEnvelope(body)) {
      throw new NetworkError(
        `Server returned an invalid error response (status ${response.status})`,
        false,
      );
    }
    const error = body.error as unknown as Record<string, unknown>;
    throw new ApiError(body.error.message, {
      status: response.status,
      code: body.error.code,
      retryable: body.error.retryable,
      requestId: body.request_id,
      fields: fieldsFromError(error),
      details: detailsFromError(error),
    });
  }
  return body as T;
}

/**
 * Retry only ambiguous network failures, once, with the same key/body.
 * HTTP error envelopes and aborts are never retried.
 */
async function withNetworkRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof NetworkError) || !error.retryable || error.aborted) {
      throw error;
    }
    return operation();
  }
}

function clampLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(Math.trunc(limit), MAX_TASK_PAGE_LIMIT);
}

function toQuery(params: TaskListParams | undefined): string {
  if (!params) return "";
  const search = new URLSearchParams();
  const limit = clampLimit(params.limit);
  const entries: [string, string | number | boolean | undefined][] = [
    ["view", params.view],
    ["search", params.search],
    ["status", params.status],
    ["project_id", params.project_id],
    ["section_id", params.section_id],
    ["parent_id", params.parent_id],
    ["tag_id", params.tag_id],
    ["tag_ids", params.tag_ids],
    ["priority", params.priority],
    ["due_on", params.due_on],
    ["due_before", params.due_before],
    ["due_after", params.due_after],
    ["someday", params.someday],
    ["overdue", params.overdue],
    ["sort", params.sort],
    ["cursor", params.cursor],
    ["limit", limit],
  ];
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

function toSimpleQuery(
  params: Record<string, string | number | boolean | null | undefined> | undefined,
): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Authenticated JSON POST/PUT without an idempotency key (control-plane). */
async function sendJsonNoIdempotency<T>(
  path: string,
  options: {
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
  },
): Promise<T> {
  return withNetworkRetry(async () => {
    const headers =
      options.body === undefined
        ? authHeaders()
        : { ...authHeaders(), "Content-Type": "application/json" };
    const response = await rawFetch(path, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return parseResponse<T>(response);
  });
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await rawFetch(path, {
    ...init,
    method: "GET",
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
  return parseResponse<T>(response);
}

async function sendMutation<T>(
  path: string,
  options: {
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    operationId: string;
    body?: unknown;
    json?: boolean;
  },
): Promise<T> {
  const headers =
    options.body !== undefined || options.json
      ? jsonHeaders(options.operationId)
      : mutationHeaders(options.operationId);
  return withNetworkRetry(async () => {
    const response = await rawFetch(path, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return parseResponse<T>(response);
  });
}

// ---------------------------------------------------------------------------
// Health / profile
// ---------------------------------------------------------------------------

/** Check server health (unauthenticated). */
export async function checkHealth(): Promise<boolean> {
  try {
    const response = await rawFetch("/api/v1/health");
    return response.ok;
  } catch {
    return false;
  }
}

/** Health payload (unauthenticated). */
export async function getHealth(): Promise<HealthResponse> {
  const response = await rawFetch("/api/v1/health");
  return parseResponse(response);
}

export async function getProfile(): Promise<ProfileResponse> {
  return getJson<ProfileResponse>("/api/v1/profile");
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** Keyset task list/view/filter page. Limit is clamped to 1–100. */
export async function listTasks(params?: TaskListParams): Promise<TaskListResponse> {
  return getJson<TaskListResponse>(`/api/v1/tasks${toQuery(params)}`);
}

export async function getTask(taskId: string): Promise<TaskListResponse["tasks"][number]> {
  return getJson(`/api/v1/tasks/${taskId}`);
}

export async function createTask(
  body: CreateTaskRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/tasks", { method: "POST", operationId, body });
}

export async function patchTask(
  taskId: string,
  body: PatchTaskRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}`, { method: "PATCH", operationId, body });
}

export async function deleteTask(taskId: string, operationId: string): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}`, { method: "DELETE", operationId });
}

export async function completeTask(taskId: string, operationId: string): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}/complete`, { method: "POST", operationId });
}

export async function uncompleteTask(
  taskId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}/uncomplete`, { method: "POST", operationId });
}

export async function cancelTask(taskId: string, operationId: string): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}/cancel`, { method: "POST", operationId });
}

export async function reopenTask(taskId: string, operationId: string): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}/reopen`, { method: "POST", operationId });
}

export async function moveTask(
  taskId: string,
  body: MoveTaskRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}/move`, { method: "POST", operationId, body });
}

export async function reorderTasks(
  body: ReorderTasksRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/tasks/reorder", { method: "POST", operationId, body });
}

export async function bulkTasks(
  body: BulkTasksRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/tasks/actions", { method: "POST", operationId, body });
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export async function getCatalog(): Promise<CatalogResponse> {
  return getJson<CatalogResponse>("/api/v1/catalog");
}

export async function createProject(
  body: CreateProjectRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/projects", { method: "POST", operationId, body });
}

export async function patchProject(
  projectId: string,
  body: PatchProjectRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/projects/${projectId}`, { method: "PATCH", operationId, body });
}

export async function deleteProject(
  projectId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/projects/${projectId}`, { method: "DELETE", operationId });
}

export async function createSection(
  body: CreateSectionRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/sections", { method: "POST", operationId, body });
}

export async function patchSection(
  sectionId: string,
  body: PatchSectionRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/sections/${sectionId}`, { method: "PATCH", operationId, body });
}

export async function deleteSection(
  sectionId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/sections/${sectionId}`, { method: "DELETE", operationId });
}

export async function createTag(
  body: CreateTagRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/tags", { method: "POST", operationId, body });
}

export async function patchTag(
  tagId: string,
  body: PatchTagRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tags/${tagId}`, { method: "PATCH", operationId, body });
}

export async function deleteTag(tagId: string, operationId: string): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tags/${tagId}`, { method: "DELETE", operationId });
}

export async function createTemplate(
  body: CreateTemplateRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/templates", { method: "POST", operationId, body });
}

export async function patchTemplate(
  templateId: string,
  body: PatchTemplateRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/templates/${templateId}`, { method: "PATCH", operationId, body });
}

export async function deleteTemplate(
  templateId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/templates/${templateId}`, { method: "DELETE", operationId });
}

export async function applyTemplate(
  body: ApplyTemplateRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/templates/apply", { method: "POST", operationId, body });
}

export async function createSavedFilter(
  body: CreateSavedFilterRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/saved_filters", { method: "POST", operationId, body });
}

export async function patchSavedFilter(
  filterId: string,
  body: PatchSavedFilterRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/saved_filters/${filterId}`, {
    method: "PATCH",
    operationId,
    body,
  });
}

export async function deleteSavedFilter(
  filterId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/saved_filters/${filterId}`, { method: "DELETE", operationId });
}

// ---------------------------------------------------------------------------
// Comments / relations / activity
// ---------------------------------------------------------------------------

export async function listComments(taskId: string): Promise<CommentListResponse> {
  return getJson(`/api/v1/tasks/${taskId}/comments`);
}

export async function createComment(
  taskId: string,
  body: CreateCommentRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}/comments`, { method: "POST", operationId, body });
}

export async function patchComment(
  commentId: string,
  body: PatchCommentRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/comments/${commentId}`, { method: "PATCH", operationId, body });
}

export async function deleteComment(
  commentId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/comments/${commentId}`, { method: "DELETE", operationId });
}

export async function listRelations(taskId: string): Promise<RelationListResponse> {
  return getJson(`/api/v1/tasks/${taskId}/relations`);
}

export async function addRelation(
  taskId: string,
  body: AddRelationRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}/relations`, { method: "POST", operationId, body });
}

export async function removeRelation(
  taskId: string,
  toTaskId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}/relations/${toTaskId}`, {
    method: "DELETE",
    operationId,
  });
}

export async function listTaskActivity(taskId: string): Promise<TaskActivityResponse> {
  return getJson(`/api/v1/tasks/${taskId}/activity`);
}

// ---------------------------------------------------------------------------
// Parsers (read-only; no idempotency key)
// ---------------------------------------------------------------------------

export async function parseQuickEntry(body: ParseQuickEntryRequest): Promise<QuickEntryDto> {
  const response = await rawFetch("/api/v1/parse/quick-entry", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

export async function parseFilter(body: ParseFilterRequest): Promise<ParsedFilterResponse> {
  const response = await rawFetch("/api/v1/parse/filter", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

export async function parseTextImport(body: ParseTextImportRequest): Promise<TextImportResponse> {
  const response = await rawFetch("/api/v1/parse/text-import", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  return parseResponse(response);
}

// ---------------------------------------------------------------------------
// Phase 3: calendar / planning / stats / motivation / nudges / settings
// ---------------------------------------------------------------------------

/** Bounded calendar range read. Civil `from`/`to` are required by the server. */
export async function listCalendarTasks(
  params: CalendarTasksParams,
): Promise<CalendarTasksResponse> {
  return getJson<CalendarTasksResponse>(`/api/v1/calendar/tasks${toSimpleQuery(params)}`);
}

export async function getDailyPlan(): Promise<DailyPlanResponse> {
  return getJson<DailyPlanResponse>("/api/v1/planning/daily");
}

export async function getEndOfDayPlan(): Promise<EndOfDayResponse> {
  return getJson<EndOfDayResponse>("/api/v1/planning/end-of-day");
}

export async function getWeeklyReview(): Promise<WeeklyReviewResponse> {
  return getJson<WeeklyReviewResponse>("/api/v1/planning/weekly");
}

export async function getTemporalSettings(): Promise<TemporalSettingsResponse> {
  return getJson<TemporalSettingsResponse>("/api/v1/settings/temporal");
}

/** Server-authoritative stats aggregates for an inclusive civil range. */
export async function getStats(params: StatsParams): Promise<StatsResponse> {
  return getJson<StatsResponse>(`/api/v1/stats${toSimpleQuery(params)}`);
}

export async function getNudges(): Promise<NudgesResponse> {
  return getJson<NudgesResponse>("/api/v1/nudges");
}

export async function getDopamineMenu(): Promise<DopamineMenuResponse> {
  return getJson<DopamineMenuResponse>("/api/v1/motivation/dopamine-menu");
}

export async function getEatTheFrog(): Promise<EatTheFrogResponse> {
  return getJson<EatTheFrogResponse>("/api/v1/motivation/eat-the-frog");
}

export async function getTaskJar(): Promise<TaskJarResponse> {
  return getJson<TaskJarResponse>("/api/v1/motivation/task-jar");
}

// ---------------------------------------------------------------------------
// Phase 3: time blocks / slots
// ---------------------------------------------------------------------------

export async function listTimeBlocks(
  params?: TimeBlockRangeParams,
): Promise<TimeBlockListResponse> {
  return getJson<TimeBlockListResponse>(`/api/v1/time-blocks${toSimpleQuery(params)}`);
}

export async function createTimeBlock(
  body: CreateTimeBlockRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/time-blocks", { method: "POST", operationId, body });
}

export async function patchTimeBlock(
  timeBlockId: string,
  body: PatchTimeBlockRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/time-blocks/${timeBlockId}`, {
    method: "PATCH",
    operationId,
    body,
  });
}

export async function deleteTimeBlock(
  timeBlockId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/time-blocks/${timeBlockId}`, {
    method: "DELETE",
    operationId,
  });
}

export async function moveTimeBlock(
  timeBlockId: string,
  body: MoveTimeBlockRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/time-blocks/${timeBlockId}/move`, {
    method: "POST",
    operationId,
    body,
  });
}

export async function resizeTimeBlock(
  timeBlockId: string,
  body: ResizeTimeBlockRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/time-blocks/${timeBlockId}/resize`, {
    method: "POST",
    operationId,
    body,
  });
}

export async function replanTimeBlocks(
  body: ReplanTimeBlocksRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/time-blocks/replan", { method: "POST", operationId, body });
}

export async function listTimeSlots(params?: TimeSlotRangeParams): Promise<TimeSlotListResponse> {
  return getJson<TimeSlotListResponse>(`/api/v1/time-slots${toSimpleQuery(params)}`);
}

export async function createTimeSlot(
  body: CreateTimeSlotRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation("/api/v1/time-slots", { method: "POST", operationId, body });
}

export async function patchTimeSlot(
  timeSlotId: string,
  body: PatchTimeSlotRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/time-slots/${timeSlotId}`, {
    method: "PATCH",
    operationId,
    body,
  });
}

export async function deleteTimeSlot(
  timeSlotId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/time-slots/${timeSlotId}`, {
    method: "DELETE",
    operationId,
  });
}

export async function replaceTimeSlotTasks(
  timeSlotId: string,
  body: ReplaceTimeSlotTasksRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/time-slots/${timeSlotId}/tasks`, {
    method: "PUT",
    operationId,
    body,
    json: true,
  });
}

export async function appendTimeSlotTask(
  timeSlotId: string,
  body: AppendTimeSlotTaskRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/time-slots/${timeSlotId}/tasks`, {
    method: "POST",
    operationId,
    body,
  });
}

export async function removeTimeSlotTask(
  timeSlotId: string,
  taskId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/time-slots/${timeSlotId}/tasks/${taskId}`, {
    method: "DELETE",
    operationId,
  });
}

// ---------------------------------------------------------------------------
// Phase 3: reminders (user mutations + control-plane delivery)
// ---------------------------------------------------------------------------

export async function listTaskReminders(taskId: string): Promise<ReminderListResponse> {
  return getJson<ReminderListResponse>(`/api/v1/tasks/${taskId}/reminders`);
}

export async function rescheduleReminder(
  taskId: string,
  body: RescheduleReminderRequest,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}/reminders/reschedule`, {
    method: "POST",
    operationId,
    body,
  });
}

export async function dismissReminder(
  taskId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/tasks/${taskId}/reminders/dismiss`, {
    method: "POST",
    operationId,
  });
}

/** Control-plane lease acquire — no user revision / idempotency key. */
export async function acquireReminderLease(
  body: AcquireReminderLeaseRequest = {},
): Promise<ReminderDeliveryLeaseDto> {
  return sendJsonNoIdempotency("/api/v1/reminders/lease", { method: "POST", body });
}

export async function renewReminderLease(
  body: RenewReminderLeaseRequest,
): Promise<ReminderDeliveryLeaseDto> {
  return sendJsonNoIdempotency("/api/v1/reminders/lease/renew", { method: "POST", body });
}

export async function releaseReminderLease(body: ReleaseReminderLeaseRequest): Promise<void> {
  return sendJsonNoIdempotency("/api/v1/reminders/lease/release", { method: "POST", body });
}

export async function claimDueReminders(
  body: ClaimRemindersRequest,
): Promise<ClaimRemindersResponse> {
  return sendJsonNoIdempotency("/api/v1/reminders/claim", { method: "POST", body });
}

export async function settleReminderDelivered(body: SettleReminderDeliveredRequest): Promise<void> {
  return sendJsonNoIdempotency("/api/v1/reminders/settle/delivered", { method: "POST", body });
}

export async function settleReminderFailed(body: SettleReminderFailedRequest): Promise<void> {
  return sendJsonNoIdempotency("/api/v1/reminders/settle/failed", { method: "POST", body });
}

export async function markOwnerLostReminders(
  body: MarkOwnerLostRemindersRequest,
): Promise<MarkOwnerLostRemindersResponse> {
  return sendJsonNoIdempotency("/api/v1/reminders/owner-lost", { method: "POST", body });
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** Undo uses the source operation id in the path and a fresh Idempotency-Key. */
export async function undoOperation(
  sourceOperationId: string,
  operationId: string,
): Promise<MutationResponse> {
  return sendMutation(`/api/v1/operations/${sourceOperationId}/undo`, {
    method: "POST",
    operationId,
  });
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/** SSE event parsed from the authenticated fetch stream. */
export interface SseEvent {
  id: string;
  event: string;
  data: CommittedEventDto;
}

export type SseTerminalError = {
  kind: "authentication" | "protocol";
  message: string;
};

export type SseSubscribeHandlers = {
  onEvent: (event: SseEvent) => void;
  /** Called when the stream asks for a coalesced query/catalog refresh. */
  onResync: (scope: { tasks: boolean; catalog: boolean }, reason: string) => void;
  onReconnect: () => void;
  onTerminal: (error: SseTerminalError) => void;
};

function reconnectDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, ms);
    const onAbort = () => {
      window.clearTimeout(timeout);
      done();
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function nextBackoff(current: number): number {
  return Math.min(current * 2, MAX_SSE_BACKOFF_MS);
}

/**
 * Subscribe to the revisioned SSE event stream using authenticated fetch.
 * Supports Last-Event-ID catch-up, bounded reconnect backoff, and treats unknown
 * event types / sync.resync_required as resync signals rather than fatal errors.
 * Browser EventSource is not used because the Authorization header is required.
 */
export function subscribeToEvents(
  onEvent: (event: SseEvent) => void,
  onReconnect: () => void,
  onTerminal: (error: SseTerminalError) => void,
  initialSince: number = 0,
  onResync?: (scope: { tasks: boolean; catalog: boolean }, reason: string) => void,
): () => void {
  const controller = new AbortController();
  let lastRevision = initialSince;
  let lastEventId: string | null = initialSince > 0 ? String(initialSince) : null;
  let stopped = false;
  let backoffMs = DEFAULT_SSE_BACKOFF_MS;

  const stopWithError = (error: SseTerminalError) => {
    if (stopped) return;
    stopped = true;
    onTerminal(error);
    controller.abort();
  };

  const emitResync = (scope: { tasks: boolean; catalog: boolean }, reason: string) => {
    if (onResync) onResync(scope, reason);
    else onReconnect();
  };

  const connect = async () => {
    while (!stopped) {
      try {
        const headers: Record<string, string> = { ...authHeaders() };
        if (lastEventId) {
          headers["Last-Event-ID"] = lastEventId;
        }
        const since = lastRevision > 0 ? `?since=${lastRevision}` : "";
        const response = await rawFetch(
          `/api/v1/events${since}`,
          {
            headers,
            signal: controller.signal,
          },
          { timeoutMs: null },
        );
        if (response.status === 401 || response.status === 403) {
          stopWithError({ kind: "authentication", message: "Event stream authentication failed." });
          return;
        }
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          stopWithError({
            kind: "protocol",
            message: "Event stream returned an invalid response.",
          });
          return;
        }

        // Successful open resets backoff.
        backoffMs = DEFAULT_SSE_BACKOFF_MS;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentEvent = "";
        let currentId = "";
        let currentData = "";

        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith("event:")) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("id:")) {
              currentId = line.slice(3).trim();
            } else if (line.startsWith("data:")) {
              // SSE allows optional leading space after the colon.
              const dataValue = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
              currentData += (currentData ? "\n" : "") + dataValue;
            } else if (line === "" && currentData) {
              let data: unknown;
              try {
                data = JSON.parse(currentData);
              } catch {
                stopWithError({
                  kind: "protocol",
                  message: "Event stream contained invalid JSON.",
                });
                return;
              }
              if (!isCommittedEvent(data)) {
                stopWithError({
                  kind: "protocol",
                  message: "Event stream contained an invalid event.",
                });
                return;
              }

              if (currentId) {
                lastEventId = currentId;
              } else if (data.revision > 0) {
                lastEventId = String(data.revision);
              }

              // Monotonic delivery: ignore duplicates and rewound catch-up frames.
              if (data.revision > lastRevision) {
                lastRevision = data.revision;

                if (isResyncRequired(data.event_type)) {
                  emitResync({ tasks: true, catalog: true }, "sync.resync_required");
                } else if (!isKnownEventType(data.event_type)) {
                  // Unknown committed types are not fatal; request one coalesced resync.
                  const tasks = data.resync.tasks;
                  const catalog = data.resync.catalog;
                  emitResync(
                    tasks || catalog ? { tasks, catalog } : { tasks: true, catalog: true },
                    "unknown_event_type",
                  );
                } else {
                  onEvent({
                    id: currentId || String(data.revision),
                    event: currentEvent,
                    data,
                  });
                }
              }

              currentEvent = "";
              currentId = "";
              currentData = "";
            }
          }
        }

        if (!stopped) {
          onReconnect();
          await reconnectDelay(backoffMs, controller.signal);
          backoffMs = nextBackoff(backoffMs);
        }
      } catch {
        if (stopped || controller.signal.aborted) break;
        onReconnect();
        await reconnectDelay(backoffMs, controller.signal);
        backoffMs = nextBackoff(backoffMs);
      }
    }
  };

  void connect();

  return () => {
    stopped = true;
    controller.abort();
  };
}

// ---------------------------------------------------------------------------
// Reminder wake SSE (control-plane, not revisioned)
// ---------------------------------------------------------------------------

export type ReminderWakeHandler = (payload: { sequence: number; server_now: string }) => void;

/**
 * Subscribe to content-free `reminders_due` wakes.
 * Authenticated fetch stream — no EventSource (Authorization header required).
 * No polling; the caller claims work only on wake or after lease acquire.
 */
export function subscribeReminderWakes(onWake: ReminderWakeHandler): () => void {
  const controller = new AbortController();
  let stopped = false;
  let backoffMs = DEFAULT_SSE_BACKOFF_MS;

  const connect = async () => {
    while (!stopped) {
      try {
        const response = await rawFetch(
          "/api/v1/reminders/events",
          {
            headers: { ...authHeaders() },
            signal: controller.signal,
          },
          { timeoutMs: null },
        );
        if (response.status === 401 || response.status === 403) return;
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          await reconnectDelay(backoffMs, controller.signal);
          backoffMs = nextBackoff(backoffMs);
          continue;
        }
        backoffMs = DEFAULT_SSE_BACKOFF_MS;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentData = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith("data:")) {
              const dataValue = line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5);
              currentData += (currentData ? "\n" : "") + dataValue;
            } else if (line === "" && currentData) {
              try {
                const payload = JSON.parse(currentData) as {
                  sequence?: number;
                  server_now?: string;
                };
                if (
                  typeof payload.sequence === "number" &&
                  typeof payload.server_now === "string"
                ) {
                  onWake({ sequence: payload.sequence, server_now: payload.server_now });
                } else {
                  // Content-free wakes may still arrive as empty/minimal frames.
                  onWake({ sequence: 0, server_now: new Date().toISOString() });
                }
              } catch {
                onWake({ sequence: 0, server_now: new Date().toISOString() });
              }
              currentData = "";
            }
          }
        }
        if (!stopped) {
          await reconnectDelay(backoffMs, controller.signal);
          backoffMs = nextBackoff(backoffMs);
        }
      } catch {
        if (stopped || controller.signal.aborted) break;
        await reconnectDelay(backoffMs, controller.signal);
        backoffMs = nextBackoff(backoffMs);
      }
    }
  };

  void connect();
  return () => {
    stopped = true;
    controller.abort();
  };
}

export const TASK_PAGE_LIMIT = MAX_TASK_PAGE_LIMIT;
