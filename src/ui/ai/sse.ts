/**
 * Bounded local AI SSE decoder and pure run reducer.
 *
 * Accepts only envelope version 1 and known Wave 3e event types. Binds the
 * first run_id/generation, enforces strictly increasing sequence, and never
 * retains hidden reasoning text. EOF without a terminal is interrupted and
 * requires an authoritative reload — streams are not auto-replayed.
 */

import {
  AI_ASSISTANT_TEXT_BYTES_MAX,
  AI_DIAGNOSTIC_STRING_BYTES_MAX,
  AI_RUN_EVENT_TYPES,
  AI_SSE_ENVELOPE_VERSION,
  AI_SSE_MAX_BUFFER_BYTES,
  AI_SSE_MAX_FRAME_BYTES,
  AI_TOOL_ARGUMENTS_BYTES_MAX,
  AI_TOOL_EVENT_TRANSCRIPT_BYTES_MAX,
  AI_TOOL_RESULT_BYTES_MAX,
  AiSseError,
  createInitialAiRunStreamState,
  type AiContextMetadata,
  type AiRunEventTypeName,
  type AiRunStreamState,
  type AiRunTerminalView,
  type AiToolDecisionView,
  type AiToolProposalView,
  type AiToolResultView,
} from "./types";

const KNOWN_EVENT_TYPE_SET = new Set<string>(AI_RUN_EVENT_TYPES);

const ENVELOPE_KEYS = new Set([
  "version",
  "run_id",
  "generation",
  "sequence",
  "type",
  "payload",
]);

/** Vendor/provider wire keys that must never appear on local envelopes/payloads. */
const VENDOR_FIELD_REJECT = new Set([
  "choices",
  "delta",
  "content_block",
  "content_block_delta",
  "content_block_start",
  "content_block_stop",
  "system_fingerprint",
  "finish_reason",
  "native",
  "raw",
  "provider_raw",
  "model",
  "usage_metadata",
  "candidates",
  "parts",
  "safetyRatings",
  "citationMetadata",
  "logprobs",
  "tool_calls",
  "function_call",
  "reasoning_content",
  "thinking",
  "encrypted_content",
]);

// ---------------------------------------------------------------------------
// Incremental SSE frame decoder
// ---------------------------------------------------------------------------

export type DecodedSseFrame = {
  event: string | null;
  id: string | null;
  data: string;
  /** Wire bytes counted toward the frame bound. */
  frameBytes: number;
};

/**
 * Incremental SSE decoder safe across arbitrary byte chunks and UTF-8
 * fragmentation. Enforces frame and undecoded-buffer bounds.
 */
export class AiSseDecoder {
  #lineCarry = "";
  #dataLines: string[] = [];
  #eventName: string | null = null;
  #eventId: string | null = null;
  #frameBytes = 0;
  #bufferBytes = 0;
  #finished = false;
  /** fatal:true rejects invalid sequences; stream:true holds incomplete tails. */
  #textDecoder = new TextDecoder("utf-8", { fatal: true });

  get undecodedBytes(): number {
    return this.#bufferBytes + utf8Bytes(this.#lineCarry);
  }

  /** Push an arbitrary body chunk; returns completed frames. */
  push(chunk: Uint8Array): DecodedSseFrame[] {
    if (this.#finished) {
      throw new AiSseError("protocol", "SSE decoder already finished");
    }
    if (chunk.byteLength === 0) {
      return [];
    }

    let text: string;
    try {
      // stream:true retains incomplete trailing code units inside the decoder.
      text = this.#textDecoder.decode(chunk, { stream: true });
    } catch {
      throw new AiSseError("utf8", "invalid UTF-8 in AI SSE body");
    }

    // Track undecoded buffer as line carry + current frame accumulation.
    this.#bufferBytes = utf8Bytes(this.#lineCarry) + this.#frameBytes;
    this.#ensureBufferBound(this.#bufferBytes + utf8Bytes(text));

    return this.#pushText(text);
  }

  /**
   * Finish the stream. A trailing partial event without a blank line is
   * dispatched when it has fields (SSE EOF rule); truncated UTF-8 is rejected.
   */
  finish(): DecodedSseFrame[] {
    if (this.#finished) {
      return [];
    }
    this.#finished = true;

    let tail = "";
    try {
      // End-of-stream flush: incomplete UTF-8 sequences fail closed.
      tail = this.#textDecoder.decode();
    } catch {
      throw new AiSseError("utf8", "truncated UTF-8 sequence at end of AI SSE body");
    }

    const frames: DecodedSseFrame[] = [];
    if (tail) {
      frames.push(...this.#pushText(tail));
    }
    if (this.#lineCarry.length > 0) {
      const line = this.#lineCarry;
      this.#lineCarry = "";
      const frame = this.#pushLine(line);
      if (frame) frames.push(frame);
    }
    if (this.#hasPendingFields()) {
      const frame = this.#dispatch();
      if (frame) frames.push(frame);
    }
    return frames;
  }

  #pushText(text: string): DecodedSseFrame[] {
    const frames: DecodedSseFrame[] = [];
    // Normalize CRLF / lone CR so fragmented endings never leave bare `\r`.
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let rest = normalized;
    while (true) {
      const newlineAt = rest.indexOf("\n");
      if (newlineAt < 0) break;
      let line = rest.slice(0, newlineAt);
      rest = rest.slice(newlineAt + 1);
      if (this.#lineCarry.length > 0) {
        line = this.#lineCarry + line;
        this.#lineCarry = "";
      }
      const frame = this.#pushLine(line);
      if (frame) frames.push(frame);
    }
    if (rest.length > 0) {
      this.#lineCarry += rest;
      this.#bufferBytes = utf8Bytes(this.#lineCarry) + this.#frameBytes;
      this.#ensureBufferBound(this.#bufferBytes);
      this.#ensureFrameBound(this.#frameBytes + utf8Bytes(this.#lineCarry));
    } else {
      this.#bufferBytes = this.#frameBytes;
    }
    return frames;
  }

  #pushLine(line: string): DecodedSseFrame | null {
    if (line.length === 0) {
      return this.#dispatch();
    }
    // Comment / keepalive.
    if (line.startsWith(":")) {
      return null;
    }

    const lineBytes = utf8Bytes(line) + 1;
    this.#frameBytes += lineBytes;
    this.#ensureFrameBound(this.#frameBytes);
    this.#bufferBytes = this.#frameBytes + utf8Bytes(this.#lineCarry);
    this.#ensureBufferBound(this.#bufferBytes);

    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.#dataLines.push(value);
        break;
      case "event":
        this.#eventName = value;
        break;
      case "id":
        if (!value.includes("\0")) {
          this.#eventId = value;
        }
        break;
      case "retry":
        break;
      default:
        // Ignore unknown SSE fields (forward-compatible); vendor JSON is checked later.
        break;
    }
    return null;
  }

  #dispatch(): DecodedSseFrame | null {
    if (!this.#hasPendingFields()) {
      this.#resetFrame();
      return null;
    }
    const frame: DecodedSseFrame = {
      event: this.#eventName,
      id: this.#eventId,
      data: this.#dataLines.join("\n"),
      frameBytes: this.#frameBytes,
    };
    this.#resetFrame();
    return frame;
  }

  #hasPendingFields(): boolean {
    return this.#dataLines.length > 0 || this.#eventName !== null || this.#eventId !== null;
  }

  #resetFrame(): void {
    this.#dataLines = [];
    this.#eventName = null;
    this.#eventId = null;
    this.#frameBytes = 0;
    this.#bufferBytes = utf8Bytes(this.#lineCarry);
  }

  #ensureFrameBound(bytes: number): void {
    if (bytes > AI_SSE_MAX_FRAME_BYTES) {
      throw new AiSseError("frame_bound", "AI SSE frame exceeds the configured byte bound");
    }
  }

  #ensureBufferBound(bytes: number): void {
    if (bytes > AI_SSE_MAX_BUFFER_BYTES) {
      throw new AiSseError("buffer_bound", "AI SSE undecoded buffer exceeds the configured byte bound");
    }
  }
}

// ---------------------------------------------------------------------------
// Pure envelope reducer
// ---------------------------------------------------------------------------

export class AiRunSseReducer {
  #state: AiRunStreamState = createInitialAiRunStreamState();
  #toolRetainedBytes = 0;
  #lastPulledTextRevision = 0;

  get state(): AiRunStreamState {
    return this.#state;
  }

  /** Pull visible text only when it advanced since the last pull. */
  pullVisibleText(): { text: string; revision: number } | null {
    if (this.#state.textRevision === this.#lastPulledTextRevision) {
      return null;
    }
    this.#lastPulledTextRevision = this.#state.textRevision;
    return { text: this.#state.visibleText, revision: this.#state.textRevision };
  }

  /** Apply one decoded SSE frame. */
  pushFrame(frame: DecodedSseFrame): AiRunStreamState {
    if (this.#state.terminal && this.#state.terminal.kind !== "interrupted") {
      // Duplicate frames after a terminal are rejected.
      throw new AiSseError("duplicate_terminal", "AI run already reached a terminal event");
    }

    if (!frame.data) {
      // id/event-only frames are ignored.
      return this.#state;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      throw new AiSseError("malformed_json", "AI SSE frame contained invalid JSON");
    }

    this.#acceptEnvelope(parsed, frame.id);
    return this.#state;
  }

  /**
   * Mark the stream finished. EOF without a terminal becomes interrupted and
   * requires an authoritative reload (no auto-replay).
   */
  finish(options?: { aborted?: boolean }): AiRunStreamState {
    if (this.#state.terminal) {
      return this.#state;
    }
    if (options?.aborted) {
      this.#state = {
        ...this.#state,
        terminal: {
          kind: "interrupted",
          reason: "aborted",
          message: "AI run stream was aborted",
        },
      };
      return this.#state;
    }
    this.#state = {
      ...this.#state,
      terminal: {
        kind: "interrupted",
        reason: "eof_without_terminal",
        message: "AI run stream ended without a terminal event; reload authoritative state",
      },
    };
    return this.#state;
  }

  #acceptEnvelope(raw: unknown, sseId: string | null): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AiSseError("payload", "AI SSE envelope must be a JSON object");
    }
    const envelope = raw as Record<string, unknown>;

    for (const key of Object.keys(envelope)) {
      if (!ENVELOPE_KEYS.has(key)) {
        if (VENDOR_FIELD_REJECT.has(key)) {
          throw new AiSseError("vendor_field", "AI SSE envelope contained a provider vendor field");
        }
        throw new AiSseError("payload", "AI SSE envelope contained an unknown field");
      }
      if (VENDOR_FIELD_REJECT.has(key)) {
        throw new AiSseError("vendor_field", "AI SSE envelope contained a provider vendor field");
      }
    }

    if (envelope.version !== AI_SSE_ENVELOPE_VERSION) {
      throw new AiSseError("version", "AI SSE envelope version is not supported");
    }
    if (typeof envelope.run_id !== "string" || envelope.run_id.length === 0) {
      throw new AiSseError("identity", "AI SSE envelope run_id is invalid");
    }
    if (!isFiniteNumber(envelope.generation) || envelope.generation < 0) {
      throw new AiSseError("identity", "AI SSE envelope generation is invalid");
    }
    if (!isFiniteNumber(envelope.sequence) || envelope.sequence < 1) {
      throw new AiSseError("sequence", "AI SSE envelope sequence is invalid");
    }
    if (typeof envelope.type !== "string" || !KNOWN_EVENT_TYPE_SET.has(envelope.type)) {
      throw new AiSseError("event_type", "AI SSE envelope event type is unknown");
    }
    if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) {
      throw new AiSseError("payload", "AI SSE envelope payload must be a JSON object");
    }

    const payload = envelope.payload as Record<string, unknown>;
    rejectVendorFields(payload);

    const runId = envelope.run_id;
    const generation = envelope.generation as number;
    const sequence = envelope.sequence as number;
    const type = envelope.type as AiRunEventTypeName;

    if (this.#state.runId === null) {
      this.#state = {
        ...this.#state,
        runId,
        generation,
      };
    } else if (this.#state.runId !== runId || this.#state.generation !== generation) {
      throw new AiSseError("identity", "AI SSE envelope run identity changed");
    }

    if (this.#state.lastSequence !== null && sequence <= this.#state.lastSequence) {
      throw new AiSseError("sequence", "AI SSE envelope sequence must strictly increase");
    }

    if (sseId !== null && sseId !== "") {
      // When present, Last-Event-ID / id must agree with sequence semantics.
      const idAsNumber = Number(sseId);
      if (Number.isFinite(idAsNumber) && idAsNumber !== sequence) {
        throw new AiSseError("sequence", "AI SSE id does not match envelope sequence");
      }
      if (
        this.#state.lastEventId !== null &&
        Number.isFinite(Number(this.#state.lastEventId)) &&
        Number.isFinite(idAsNumber) &&
        idAsNumber <= Number(this.#state.lastEventId)
      ) {
        throw new AiSseError("sequence", "AI SSE Last-Event-ID must strictly increase");
      }
    }

    this.#state = {
      ...this.#state,
      lastSequence: sequence,
      lastEventId: sseId && sseId.length > 0 ? sseId : String(sequence),
    };

    switch (type) {
      case "run_started":
        this.#onRunStarted(payload);
        break;
      case "text_delta":
        this.#onTextDelta(payload);
        break;
      case "reasoning_status":
        this.#onReasoningStatus(payload);
        break;
      case "usage":
        this.#onUsage(payload);
        break;
      case "tool_proposed":
        this.#onToolProposed(payload);
        break;
      case "tool_approved":
        this.#onToolDecision(payload, "approved");
        break;
      case "tool_rejected":
        this.#onToolDecision(payload, "rejected");
        break;
      case "tool_result":
        this.#onToolResult(payload);
        break;
      case "run_completed":
        this.#setTerminal(parseSuccessTerminal(payload, "completed"));
        break;
      case "run_cancelled":
        this.#setTerminal(parseSuccessTerminal(payload, "cancelled"));
        break;
      case "run_failed":
        this.#setTerminal(parseFailedTerminal(payload));
        break;
      default: {
        const _exhaustive: never = type;
        void _exhaustive;
        throw new AiSseError("event_type", "AI SSE envelope event type is unknown");
      }
    }
  }

  #onRunStarted(payload: Record<string, unknown>): void {
    if (payload.replay === true) {
      this.#state = { ...this.#state, replay: true };
      return;
    }
    if ("context" in payload) {
      const context = payload.context;
      if (!context || typeof context !== "object" || Array.isArray(context)) {
        throw new AiSseError("payload", "run_started context is invalid");
      }
      rejectVendorFields(context as Record<string, unknown>);
      this.#state = {
        ...this.#state,
        context: context as AiContextMetadata,
      };
      return;
    }
    // Empty / unknown start payloads are accepted without context.
  }

  #onTextDelta(payload: Record<string, unknown>): void {
    if (typeof payload.text !== "string") {
      throw new AiSseError("payload", "text_delta payload requires text");
    }
    assertOnlyKeys(payload, ["text"]);
    const delta = payload.text;
    const nextBytes = utf8Bytes(this.#state.visibleText) + utf8Bytes(delta);
    if (nextBytes > AI_ASSISTANT_TEXT_BYTES_MAX) {
      throw new AiSseError("text_bound", "visible assistant text exceeds the configured byte bound");
    }
    this.#state = {
      ...this.#state,
      visibleText: this.#state.visibleText + delta,
      textRevision: this.#state.textRevision + 1,
    };
  }

  #onReasoningStatus(payload: Record<string, unknown>): void {
    if (typeof payload.status !== "string") {
      throw new AiSseError("payload", "reasoning_status payload requires status");
    }
    assertOnlyKeys(payload, ["status"]);
    // Status label only — never retain hidden chain-of-thought blobs.
    const status = boundDiagnostic(payload.status);
    this.#state = {
      ...this.#state,
      reasoningStatus: status,
    };
  }

  #onUsage(payload: Record<string, unknown>): void {
    assertOnlyKeys(payload, ["input_tokens", "output_tokens"]);
    if (!isFiniteNumber(payload.input_tokens) || payload.input_tokens < 0) {
      throw new AiSseError("payload", "usage input_tokens is invalid");
    }
    if (!isFiniteNumber(payload.output_tokens) || payload.output_tokens < 0) {
      throw new AiSseError("payload", "usage output_tokens is invalid");
    }
    this.#state = {
      ...this.#state,
      usage: {
        inputTokens: payload.input_tokens as number,
        outputTokens: payload.output_tokens as number,
      },
    };
  }

  #onToolProposed(payload: Record<string, unknown>): void {
    assertOnlyKeys(payload, ["approval_id", "tool", "arguments", "action_hash", "expires_at"]);
    if (typeof payload.approval_id !== "string" || payload.approval_id.length === 0) {
      throw new AiSseError("payload", "tool_proposed approval_id is invalid");
    }
    if (typeof payload.tool !== "string" || payload.tool.length === 0) {
      throw new AiSseError("payload", "tool_proposed tool is invalid");
    }
    if (
      !payload.arguments ||
      typeof payload.arguments !== "object" ||
      Array.isArray(payload.arguments)
    ) {
      throw new AiSseError("payload", "tool_proposed arguments must be an object");
    }
    if (typeof payload.action_hash !== "string" || payload.action_hash.length === 0) {
      throw new AiSseError("payload", "tool_proposed action_hash is invalid");
    }
    if (typeof payload.expires_at !== "string" || payload.expires_at.length === 0) {
      throw new AiSseError("payload", "tool_proposed expires_at is invalid");
    }
    boundDiagnostic(payload.tool);
    boundDiagnostic(payload.action_hash);
    boundDiagnostic(payload.approval_id);
    boundDiagnostic(payload.expires_at);

    const argsJson = stableJsonBytes(payload.arguments);
    if (argsJson > AI_TOOL_ARGUMENTS_BYTES_MAX) {
      throw new AiSseError("tool_bound", "tool arguments exceed the configured byte bound");
    }
    this.#retainToolBytes(argsJson + utf8Bytes(payload.action_hash) + utf8Bytes(payload.tool));

    const proposal: AiToolProposalView = {
      approvalId: payload.approval_id,
      tool: payload.tool,
      arguments: payload.arguments as Record<string, unknown>,
      actionHash: payload.action_hash,
      expiresAt: payload.expires_at,
    };
    this.#state = {
      ...this.#state,
      proposals: [...this.#state.proposals, proposal],
    };
  }

  #onToolDecision(
    payload: Record<string, unknown>,
    decision: AiToolDecisionView["decision"],
  ): void {
    assertOnlyKeys(payload, ["approval_id"]);
    if (typeof payload.approval_id !== "string" || payload.approval_id.length === 0) {
      throw new AiSseError("payload", "tool decision approval_id is invalid");
    }
    boundDiagnostic(payload.approval_id);
    this.#retainToolBytes(utf8Bytes(payload.approval_id));
    const entry: AiToolDecisionView = {
      approvalId: payload.approval_id,
      decision,
    };
    this.#state = {
      ...this.#state,
      decisions: [...this.#state.decisions, entry],
    };
  }

  #onToolResult(payload: Record<string, unknown>): void {
    const allowed = [
      "tool",
      "outcome",
      "data",
      "truncated",
      "operation_id",
      "revision",
    ];
    assertOnlyKeys(payload, allowed);
    if (typeof payload.tool !== "string" || payload.tool.length === 0) {
      throw new AiSseError("payload", "tool_result tool is invalid");
    }
    if (typeof payload.outcome !== "string" || payload.outcome.length === 0) {
      throw new AiSseError("payload", "tool_result outcome is invalid");
    }
    if (!("data" in payload)) {
      throw new AiSseError("payload", "tool_result data is required");
    }
    if (typeof payload.truncated !== "boolean") {
      throw new AiSseError("payload", "tool_result truncated must be boolean");
    }
    if (
      payload.operation_id !== undefined &&
      payload.operation_id !== null &&
      typeof payload.operation_id !== "string"
    ) {
      throw new AiSseError("payload", "tool_result operation_id is invalid");
    }
    if (
      payload.revision !== undefined &&
      payload.revision !== null &&
      (!isFiniteNumber(payload.revision) || (payload.revision as number) < 1)
    ) {
      throw new AiSseError("payload", "tool_result revision is invalid");
    }
    boundDiagnostic(payload.tool);
    boundDiagnostic(payload.outcome);

    const dataBytes = stableJsonBytes(payload.data);
    if (dataBytes > AI_TOOL_RESULT_BYTES_MAX) {
      throw new AiSseError("tool_bound", "tool result exceeds the configured byte bound");
    }
    this.#retainToolBytes(dataBytes + utf8Bytes(payload.tool));

    const result: AiToolResultView = {
      tool: payload.tool,
      outcome: payload.outcome,
      data: payload.data,
      truncated: payload.truncated,
      operationId:
        typeof payload.operation_id === "string" ? payload.operation_id : null,
      revision: isFiniteNumber(payload.revision) ? (payload.revision as number) : null,
    };
    this.#state = {
      ...this.#state,
      results: [...this.#state.results, result],
    };
  }

  #setTerminal(terminal: AiRunTerminalView): void {
    if (this.#state.terminal && this.#state.terminal.kind !== "interrupted") {
      throw new AiSseError("duplicate_terminal", "AI run already reached a terminal event");
    }
    this.#state = {
      ...this.#state,
      terminal,
    };
  }

  #retainToolBytes(extra: number): void {
    const next = this.#toolRetainedBytes + extra;
    if (next > AI_TOOL_EVENT_TRANSCRIPT_BYTES_MAX) {
      throw new AiSseError("tool_bound", "retained tool events exceed the configured byte bound");
    }
    this.#toolRetainedBytes = next;
  }
}

// ---------------------------------------------------------------------------
// Stream pump + animation-frame batching
// ---------------------------------------------------------------------------

export type AiRunStreamHandlers = {
  /** Fired after each accepted envelope (may be high frequency). */
  onState?: (state: AiRunStreamState) => void;
  /** Fired at most once per animation frame when visible text changes. */
  onVisibleText?: (text: string, state: AiRunStreamState) => void;
};

/**
 * Animation-frame batching helper so React can update visible text at most
 * once per frame without living inside the parser.
 */
export function createVisibleTextFrameBatcher(
  onFlush: (text: string, state: AiRunStreamState) => void,
  schedule: (cb: () => void) => number = defaultRaf,
  cancel: (id: number) => void = defaultCancelRaf,
): {
  notify: (state: AiRunStreamState) => void;
  flushNow: () => void;
  dispose: () => void;
} {
  let scheduled = false;
  let handle: number | null = null;
  let pending: AiRunStreamState | null = null;
  let lastRevision = -1;

  const flush = () => {
    scheduled = false;
    handle = null;
    if (!pending) return;
    if (pending.textRevision === lastRevision) return;
    lastRevision = pending.textRevision;
    onFlush(pending.visibleText, pending);
  };

  return {
    notify(state: AiRunStreamState) {
      pending = state;
      if (scheduled) return;
      scheduled = true;
      handle = schedule(flush);
    },
    flushNow() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      flush();
    },
    dispose() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      scheduled = false;
      pending = null;
    },
  };
}

/**
 * Read a fetch SSE body through the bounded decoder/reducer until terminal,
 * abort, or EOF. Does not auto-replay.
 */
export async function consumeAiRunSseStream(
  body: ReadableStream<Uint8Array>,
  options: {
    signal?: AbortSignal;
    handlers?: AiRunStreamHandlers;
  } = {},
): Promise<AiRunStreamState> {
  const decoder = new AiSseDecoder();
  const reducer = new AiRunSseReducer();
  const reader = body.getReader();
  const batcher = options.handlers?.onVisibleText
    ? createVisibleTextFrameBatcher(options.handlers.onVisibleText)
    : null;

  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (options.signal) {
    if (options.signal.aborted) {
      batcher?.dispose();
      return reducer.finish({ aborted: true });
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const emit = (state: AiRunStreamState) => {
    options.handlers?.onState?.(state);
    if (batcher) batcher.notify(state);
  };

  try {
    while (true) {
      if (options.signal?.aborted) {
        batcher?.flushNow();
        return reducer.finish({ aborted: true });
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const frames = decoder.push(value);
      for (const frame of frames) {
        const state = reducer.pushFrame(frame);
        emit(state);
        if (state.terminal && state.terminal.kind !== "interrupted") {
          batcher?.flushNow();
          // Drain is not required; terminal ends logical consumption.
          await reader.cancel().catch(() => undefined);
          return state;
        }
      }
    }

    const trailing = decoder.finish();
    for (const frame of trailing) {
      const state = reducer.pushFrame(frame);
      emit(state);
      if (state.terminal && state.terminal.kind !== "interrupted") {
        batcher?.flushNow();
        return state;
      }
    }

    const finished = reducer.finish({ aborted: Boolean(options.signal?.aborted) });
    emit(finished);
    batcher?.flushNow();
    return finished;
  } catch (error) {
    batcher?.dispose();
    if (options.signal?.aborted) {
      return reducer.finish({ aborted: true });
    }
    if (error instanceof AiSseError) {
      // Protocol failure becomes interrupted so callers reload; error remains typed.
      const interrupted = reducer.finish();
      if (interrupted.terminal?.kind === "interrupted") {
        const withProtocol: AiRunStreamState = {
          ...interrupted,
          terminal: {
            kind: "interrupted",
            reason: "protocol",
            message: error.message,
          },
        };
        // Re-throw so callers can branch on AiSseError codes; state is still available
        // via the error cause pattern below.
        throw Object.assign(error, { state: withProtocol });
      }
      throw error;
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    batcher?.dispose();
    reader.releaseLock?.();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultRaf(cb: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(cb);
  }
  return setTimeout(cb, 16) as unknown as number;
}

function defaultCancelRaf(id: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(id);
    return;
  }
  clearTimeout(id);
}

function utf8Bytes(value: string): number {
  // Byte length matters for server bounds; TextEncoder matches Rust UTF-8.
  return new TextEncoder().encode(value).byteLength;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function rejectVendorFields(object: Record<string, unknown>): void {
  for (const key of Object.keys(object)) {
    if (VENDOR_FIELD_REJECT.has(key)) {
      throw new AiSseError("vendor_field", "AI SSE payload contained a provider vendor field");
    }
  }
}

function assertOnlyKeys(object: Record<string, unknown>, allowed: string[]): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (VENDOR_FIELD_REJECT.has(key)) {
      throw new AiSseError("vendor_field", "AI SSE payload contained a provider vendor field");
    }
    if (!allow.has(key)) {
      throw new AiSseError("payload", "AI SSE payload contained an unexpected field");
    }
  }
}

function boundDiagnostic(value: string): string {
  if (utf8Bytes(value) > AI_DIAGNOSTIC_STRING_BYTES_MAX) {
    throw new AiSseError("diagnostic_bound", "diagnostic string exceeds the configured byte bound");
  }
  return value;
}

function stableJsonBytes(value: unknown): number {
  try {
    return utf8Bytes(JSON.stringify(value));
  } catch {
    throw new AiSseError("payload", "AI SSE payload could not be measured");
  }
}

function parseSuccessTerminal(
  payload: Record<string, unknown>,
  kind: "completed" | "cancelled",
): AiRunTerminalView {
  assertOnlyKeys(payload, ["assistant_message_id"]);
  if (typeof payload.assistant_message_id !== "string" || payload.assistant_message_id.length === 0) {
    throw new AiSseError("payload", `${kind} payload requires assistant_message_id`);
  }
  boundDiagnostic(payload.assistant_message_id);
  return { kind, assistantMessageId: payload.assistant_message_id };
}

function parseFailedTerminal(payload: Record<string, unknown>): AiRunTerminalView {
  assertOnlyKeys(payload, ["assistant_message_id", "error"]);
  const assistantMessageId =
    typeof payload.assistant_message_id === "string" && payload.assistant_message_id.length > 0
      ? boundDiagnostic(payload.assistant_message_id)
      : null;
  if (typeof payload.error !== "string" || payload.error.length === 0) {
    throw new AiSseError("payload", "run_failed payload requires error");
  }
  return {
    kind: "failed",
    assistantMessageId,
    error: boundDiagnostic(payload.error),
  };
}
