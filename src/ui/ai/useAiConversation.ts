/**
 * Session/message/run lifecycle for the AI chat surface.
 *
 * Owns AbortController generations so stale callbacks never mutate state.
 * Creates a session only on the first concrete send/briefing action.
 * One operation UUID per logical action; never auto-replays POSTs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, NetworkError } from "../api/client";
import { mapAiMessageDtos } from "./message-mapper";
import type { ChatMessageView, ChatSessionView, ChatToolProposal } from "./message-view";
import { createAiOperationId, RetainedOperationId } from "./operation-id";
import type { AiRunStreamState, AiToolProposalView } from "./types";
import { defaultConversationTransport, type ConversationTransport } from "./conversation-transport";
import { boundUtf8 } from "./utf8";

/** Domain AI_USER_INPUT_BYTES_MAX. */
export const AI_USER_INPUT_BYTES_MAX = 32 * 1024;

export type ConversationError = {
  message: string;
  retryable: boolean;
  code?: string;
};

export type UseAiConversationOptions = {
  transport?: ConversationTransport;
  /** Focused task id included on create/edit/retry/regenerate. */
  focusedTaskId?: string | null;
  /** When true, hook is active and loads session history. */
  enabled?: boolean;
};

export type UseAiConversationResult = {
  sessions: ChatSessionView[];
  sessionsLoading: boolean;
  sessionsCursor: string | null;
  activeSessionId: string | null;
  messages: ChatMessageView[];
  messagesLoading: boolean;
  isStreaming: boolean;
  reasoningStatus: string | null;
  runId: string | null;
  error: ConversationError | null;
  /** Pending streamed proposals not yet folded into messages. */
  liveProposals: ChatToolProposal[];
  composerPrefill: string;
  setComposerPrefill: (value: string) => void;
  loadMoreSessions: () => Promise<void>;
  selectSession: (sessionId: string | null) => Promise<void>;
  createNewSession: () => void;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  clearSession: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  sendDailyBriefing: () => Promise<void>;
  editAndResend: (messageId: string, text: string) => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;
  regenerateMessage: (messageId: string) => Promise<void>;
  stop: () => Promise<void>;
  approveProposal: (approvalId: string, actionHash: string) => Promise<void>;
  rejectProposal: (approvalId: string, actionHash: string) => Promise<void>;
  dismissError: () => void;
  /** Surface generation (increments on unmount fence). */
  surfaceGeneration: number;
};

type ActiveRun = {
  runGeneration: number;
  sessionId: string;
  controller: AbortController;
  operation: RetainedOperationId;
  runId: string | null;
  kind: "send" | "edit" | "retry" | "regenerate" | "briefing";
  /** Message id for edit/retry/regenerate. */
  messageId?: string;
};

function mapSession(dto: {
  id: string;
  title: string;
  message_count: number;
  created_at: string;
  updated_at: string;
  last_message_at?: string | null;
  status: "active" | "archived";
}): ChatSessionView {
  return {
    id: dto.id,
    title: dto.title,
    messageCount: dto.message_count,
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
    lastMessageAt: dto.last_message_at ?? null,
    status: dto.status,
  };
}

function toError(error: unknown): ConversationError {
  if (error instanceof ApiError) {
    return { message: error.message, retryable: error.retryable, code: error.code };
  }
  if (error instanceof NetworkError) {
    if (error.aborted) {
      return { message: "Request cancelled.", retryable: false, code: "aborted" };
    }
    return { message: error.message, retryable: error.retryable };
  }
  if (error instanceof Error) {
    return { message: error.message, retryable: false };
  }
  return { message: "Something went wrong.", retryable: false };
}

function proposalFromStream(view: AiToolProposalView): ChatToolProposal {
  return {
    approvalId: view.approvalId,
    tool: view.tool,
    arguments: view.arguments,
    actionHash: view.actionHash,
    expiresAt: view.expiresAt,
    decision: "pending",
  };
}

export function useAiConversation(options: UseAiConversationOptions = {}): UseAiConversationResult {
  const transport = options.transport ?? defaultConversationTransport;
  const enabled = options.enabled ?? true;
  const focusedTaskId = options.focusedTaskId ?? null;

  const [sessions, setSessions] = useState<ChatSessionView[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [reasoningStatus, setReasoningStatus] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<ConversationError | null>(null);
  const [liveProposals, setLiveProposals] = useState<ChatToolProposal[]>([]);
  const [composerPrefill, setComposerPrefill] = useState("");

  const surfaceGenRef = useRef(0);
  const sessionGenRef = useRef(0);
  const runGenRef = useRef(0);
  const activeRunRef = useRef<ActiveRun | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const focusedTaskIdRef = useRef<string | null>(focusedTaskId);
  const mountedRef = useRef(true);
  // Retain op ids per logical action kind for explicit same-action retry.
  const actionOps = useRef({
    send: new RetainedOperationId(),
    edit: new RetainedOperationId(),
    retry: new RetainedOperationId(),
    regenerate: new RetainedOperationId(),
    briefing: new RetainedOperationId(),
    approve: new Map<string, RetainedOperationId>(),
    reject: new Map<string, RetainedOperationId>(),
    rename: new Map<string, RetainedOperationId>(),
    delete: new Map<string, RetainedOperationId>(),
    clear: new RetainedOperationId(),
    createSession: new RetainedOperationId(),
  });

  useEffect(() => {
    focusedTaskIdRef.current = focusedTaskId;
  }, [focusedTaskId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const isCurrentSurface = useCallback((gen: number) => {
    return mountedRef.current && gen === surfaceGenRef.current;
  }, []);

  const abortActiveRun = useCallback(() => {
    const active = activeRunRef.current;
    if (!active) return;
    active.controller.abort();
    activeRunRef.current = null;
  }, []);

  const reloadMessages = useCallback(
    async (sessionId: string, sessionGen: number, surfaceGen: number) => {
      setMessagesLoading(true);
      try {
        // Page from the start; server returns up to 100 ordered by sequence.
        const page = await transport.listMessages(sessionId, { limit: 100 });
        if (!isCurrentSurface(surfaceGen)) return;
        if (sessionGen !== sessionGenRef.current) return;
        if (activeSessionIdRef.current !== sessionId) return;
        setMessages(mapAiMessageDtos(page.messages));
      } catch (err) {
        if (!isCurrentSurface(surfaceGen)) return;
        if (sessionGen !== sessionGenRef.current) return;
        setError(toError(err));
      } finally {
        if (isCurrentSurface(surfaceGen) && sessionGen === sessionGenRef.current) {
          setMessagesLoading(false);
        }
      }
    },
    [isCurrentSurface, transport],
  );

  const loadSessions = useCallback(
    async (cursor?: string | null) => {
      if (!enabled) return;
      const surfaceGen = surfaceGenRef.current;
      setSessionsLoading(true);
      try {
        const page = await transport.listSessions({
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (!isCurrentSurface(surfaceGen)) return;
        const mapped = page.sessions.map(mapSession);
        setSessions((prev) => (cursor ? [...prev, ...mapped] : mapped));
        setSessionsCursor(page.next_cursor ?? null);
      } catch (err) {
        if (!isCurrentSurface(surfaceGen)) return;
        setError(toError(err));
      } finally {
        if (isCurrentSurface(surfaceGen)) setSessionsLoading(false);
      }
    },
    [enabled, isCurrentSurface, transport],
  );

  // Initial session list when enabled.
  useEffect(() => {
    if (!enabled) return;
    void loadSessions();
  }, [enabled, loadSessions]);

  // Cleanup on unmount: abort and fence generations.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortActiveRun();
      surfaceGenRef.current += 1;
      sessionGenRef.current += 1;
      runGenRef.current += 1;
    };
  }, [abortActiveRun]);

  const selectSession = useCallback(
    async (sessionId: string | null) => {
      abortActiveRun();
      setIsStreaming(false);
      setReasoningStatus(null);
      setRunId(null);
      setLiveProposals([]);
      setError(null);
      sessionGenRef.current += 1;
      const sessionGen = sessionGenRef.current;
      const surfaceGen = surfaceGenRef.current;
      setActiveSessionId(sessionId);
      setMessages([]);
      if (!sessionId) return;
      await reloadMessages(sessionId, sessionGen, surfaceGen);
    },
    [abortActiveRun, reloadMessages],
  );

  const createNewSession = useCallback(() => {
    // Deferred create: only clear local selection. Session is created on first send.
    abortActiveRun();
    sessionGenRef.current += 1;
    setActiveSessionId(null);
    setMessages([]);
    setIsStreaming(false);
    setReasoningStatus(null);
    setRunId(null);
    setLiveProposals([]);
    setError(null);
    actionOps.current.createSession.reset();
    actionOps.current.send.reset();
    actionOps.current.briefing.reset();
  }, [abortActiveRun]);

  const ensureSession = useCallback(
    async (surfaceGen: number): Promise<string | null> => {
      if (activeSessionIdRef.current) return activeSessionIdRef.current;
      try {
        const op = actionOps.current.createSession;
        const title = "New chat";
        const result = await transport.createSession({ title }, { operationId: op.id });
        if (!isCurrentSurface(surfaceGen)) return null;
        const session = mapSession(result.session);
        setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
        sessionGenRef.current += 1;
        setActiveSessionId(session.id);
        activeSessionIdRef.current = session.id;
        actionOps.current.createSession.reset();
        return session.id;
      } catch (err) {
        if (isCurrentSurface(surfaceGen)) setError(toError(err));
        return null;
      }
    },
    [isCurrentSurface, transport],
  );

  const applyStreamState = useCallback(
    (
      state: AiRunStreamState,
      runGeneration: number,
      sessionId: string,
      optimisticUser?: ChatMessageView | null,
    ) => {
      if (runGeneration !== runGenRef.current) return;
      if (activeSessionIdRef.current !== sessionId) return;

      if (state.runId) setRunId(state.runId);
      setReasoningStatus(state.reasoningStatus);

      const proposals = state.proposals.map(proposalFromStream);
      // Fold stream decisions into proposals.
      for (const decision of state.decisions) {
        const match = proposals.find((p) => p.approvalId === decision.approvalId);
        if (match) match.decision = decision.decision;
      }
      setLiveProposals(proposals);

      setMessages((prev) => {
        const base = optimisticUser
          ? [...prev.filter((m) => !m.optimistic && m.id !== optimisticUser.id), optimisticUser]
          : prev.filter((m) => !m.streaming);

        const streamingId = `streaming:${state.runId ?? "pending"}`;
        const existingIdx = base.findIndex((m) => m.id === streamingId || m.streaming);
        const streamingMsg: ChatMessageView = {
          id: streamingId,
          role: "assistant",
          status: "streaming",
          text: state.visibleText,
          createdAt: new Date().toISOString(),
          sequence: Number.MAX_SAFE_INTEGER,
          turnId: "",
          focusedTaskId: focusedTaskIdRef.current,
          briefingDate: null,
          segments: state.visibleText ? [{ kind: "text", text: state.visibleText }] : [],
          proposals,
          isError: false,
          retryable: false,
          streaming: true,
          reasoningStatus: state.reasoningStatus,
        };

        // Attach live tool badges from proposals/results.
        for (const p of proposals) {
          streamingMsg.segments.push({
            kind: "tool_badge",
            tool: p.tool,
            arguments: p.arguments,
            complete: p.decision !== "pending",
          });
          streamingMsg.segments.push({ kind: "tool_proposed", proposal: p });
        }
        for (const r of state.results) {
          streamingMsg.segments.push({
            kind: "tool_result",
            result: {
              tool: r.tool,
              outcome: r.outcome,
              data: r.data,
              truncated: r.truncated,
              operationId: r.operationId,
              revision: r.revision,
            },
          });
        }

        if (existingIdx >= 0) {
          const next = [...base];
          next[existingIdx] = streamingMsg;
          return next;
        }
        return [...base, streamingMsg];
      });
    },
    [],
  );

  const finishRun = useCallback(
    async (sessionId: string, runGeneration: number, surfaceGen: number, sessionGen: number) => {
      if (runGeneration !== runGenRef.current) return;
      activeRunRef.current = null;
      setIsStreaming(false);
      setReasoningStatus(null);
      setRunId(null);
      setLiveProposals([]);
      // Authoritative reload on terminal/interrupted.
      await reloadMessages(sessionId, sessionGen, surfaceGen);
      // Refresh session list metadata (counts/titles).
      void loadSessions();
    },
    [loadSessions, reloadMessages],
  );

  const runStream = useCallback(
    async (args: {
      kind: ActiveRun["kind"];
      sessionId: string;
      operation: RetainedOperationId;
      messageId?: string;
      text?: string;
      optimisticUser?: ChatMessageView | null;
      invoke: (opts: {
        signal: AbortSignal;
        operationId: string;
        onState: (state: AiRunStreamState) => void;
      }) => Promise<unknown>;
    }) => {
      const surfaceGen = surfaceGenRef.current;
      const sessionGen = sessionGenRef.current;
      runGenRef.current += 1;
      const runGeneration = runGenRef.current;
      const controller = new AbortController();
      activeRunRef.current = {
        runGeneration,
        sessionId: args.sessionId,
        controller,
        operation: args.operation,
        runId: null,
        kind: args.kind,
        messageId: args.messageId,
      };

      setIsStreaming(true);
      setError(null);
      setReasoningStatus(null);
      setLiveProposals([]);

      if (args.optimisticUser) {
        setMessages((prev) => [...prev.filter((m) => !m.optimistic), args.optimisticUser!]);
      }

      try {
        await args.invoke({
          signal: controller.signal,
          operationId: args.operation.id,
          onState: (state) => {
            if (activeRunRef.current?.runGeneration === runGeneration && state.runId) {
              activeRunRef.current.runId = state.runId;
            }
            applyStreamState(state, runGeneration, args.sessionId, args.optimisticUser);
          },
        });
      } catch (err) {
        if (!isCurrentSurface(surfaceGen)) return;
        if (runGeneration !== runGenRef.current) return;
        const mapped = toError(err);
        if (mapped.code !== "aborted") {
          setError(mapped);
        }
      } finally {
        if (isCurrentSurface(surfaceGen) && runGeneration === runGenRef.current) {
          // Reset action op only after a definitive terminal outcome so explicit
          // same-action retry can reuse the id when the caller chooses to retry.
          // Ambiguous network errors keep the id; successful completion resets.
          if (!controller.signal.aborted) {
            args.operation.reset();
          }
          await finishRun(args.sessionId, runGeneration, surfaceGen, sessionGen);
        }
      }
    },
    [applyStreamState, finishRun, isCurrentSurface],
  );

  const sendMessage = useCallback(
    async (rawText: string) => {
      const text = boundUtf8(rawText.trim(), AI_USER_INPUT_BYTES_MAX);
      if (!text || isStreaming) return;
      const surfaceGen = surfaceGenRef.current;
      actionOps.current.send = new RetainedOperationId();
      const sessionId = await ensureSession(surfaceGen);
      if (!sessionId || !isCurrentSurface(surfaceGen)) return;

      const optimistic: ChatMessageView = {
        id: `optimistic:${createAiOperationId()}`,
        role: "user",
        status: "pending",
        text,
        createdAt: new Date().toISOString(),
        sequence: Number.MAX_SAFE_INTEGER - 1,
        turnId: "",
        focusedTaskId: focusedTaskIdRef.current,
        briefingDate: null,
        segments: [{ kind: "text", text }],
        proposals: [],
        isError: false,
        retryable: false,
        optimistic: true,
      };

      await runStream({
        kind: "send",
        sessionId,
        operation: actionOps.current.send,
        text,
        optimisticUser: optimistic,
        invoke: ({ signal, operationId, onState }) =>
          transport.createResponse(
            sessionId,
            {
              message: text,
              focused_task_id: focusedTaskIdRef.current,
            },
            {
              signal,
              operationId,
              handlers: { onState },
            },
          ),
      });
    },
    [ensureSession, isCurrentSurface, isStreaming, runStream, transport],
  );

  const sendDailyBriefing = useCallback(async () => {
    if (isStreaming) return;
    const surfaceGen = surfaceGenRef.current;
    actionOps.current.briefing = new RetainedOperationId();
    const sessionId = await ensureSession(surfaceGen);
    if (!sessionId || !isCurrentSurface(surfaceGen)) return;

    await runStream({
      kind: "briefing",
      sessionId,
      operation: actionOps.current.briefing,
      invoke: ({ signal, operationId, onState }) =>
        transport.createDailyBriefing(sessionId, {
          signal,
          operationId,
          handlers: { onState },
        }),
    });
  }, [ensureSession, isCurrentSurface, isStreaming, runStream, transport]);

  const editAndResend = useCallback(
    async (messageId: string, rawText: string) => {
      const text = boundUtf8(rawText.trim(), AI_USER_INPUT_BYTES_MAX);
      const sessionId = activeSessionIdRef.current;
      if (!text || !sessionId || isStreaming) return;
      actionOps.current.edit = new RetainedOperationId();

      await runStream({
        kind: "edit",
        sessionId,
        operation: actionOps.current.edit,
        messageId,
        text,
        invoke: ({ signal, operationId, onState }) =>
          transport.editResponse(
            sessionId,
            messageId,
            {
              message: text,
              focused_task_id: focusedTaskIdRef.current,
            },
            {
              signal,
              operationId,
              handlers: { onState },
            },
          ),
      });
    },
    [isStreaming, runStream, transport],
  );

  const retryMessage = useCallback(
    async (messageId: string) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || isStreaming) return;
      // Explicit retry: mint a new op only when previous completed; if prior
      // ambiguous failure retained an id, reuse it when assigned.
      if (!actionOps.current.retry.assigned) {
        actionOps.current.retry = new RetainedOperationId();
      }

      await runStream({
        kind: "retry",
        sessionId,
        operation: actionOps.current.retry,
        messageId,
        invoke: ({ signal, operationId, onState }) =>
          transport.retryResponse(sessionId, messageId, {
            signal,
            operationId,
            handlers: { onState },
          }),
      });
    },
    [isStreaming, runStream, transport],
  );

  const regenerateMessage = useCallback(
    async (messageId: string) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || isStreaming) return;
      actionOps.current.regenerate = new RetainedOperationId();

      await runStream({
        kind: "regenerate",
        sessionId,
        operation: actionOps.current.regenerate,
        messageId,
        invoke: ({ signal, operationId, onState }) =>
          transport.regenerateResponse(sessionId, messageId, {
            signal,
            operationId,
            handlers: { onState },
          }),
      });
    },
    [isStreaming, runStream, transport],
  );

  const stop = useCallback(async () => {
    const active = activeRunRef.current;
    if (!active) return;
    const knownRunId = active.runId;
    // Durable cancel first while identity is known, then abort local stream.
    if (knownRunId) {
      try {
        await transport.cancelRun(knownRunId);
      } catch {
        // Cancel is best-effort; local abort still proceeds.
      }
    }
    active.controller.abort();
  }, [transport]);

  const approveProposal = useCallback(
    async (approvalId: string, actionHash: string) => {
      const surfaceGen = surfaceGenRef.current;
      const sessionId = activeSessionIdRef.current;
      let op = actionOps.current.approve.get(approvalId);
      if (!op) {
        op = new RetainedOperationId();
        actionOps.current.approve.set(approvalId, op);
      }

      setLiveProposals((prev) =>
        prev.map((p) => (p.approvalId === approvalId ? { ...p, decisionPending: true } : p)),
      );
      setMessages((prev) =>
        prev.map((m) => ({
          ...m,
          proposals: m.proposals.map((p) =>
            p.approvalId === approvalId ? { ...p, decisionPending: true } : p,
          ),
          segments: m.segments.map((s) =>
            s.kind === "tool_proposed" && s.proposal.approvalId === approvalId
              ? {
                  ...s,
                  proposal: { ...s.proposal, decisionPending: true },
                }
              : s,
          ),
        })),
      );

      try {
        await transport.approveApproval(
          approvalId,
          { action_hash: actionHash },
          { operationId: op.id },
        );
        if (!isCurrentSurface(surfaceGen)) return;
        op.reset();
        actionOps.current.approve.delete(approvalId);
        // Refresh authoritative messages + approval.
        if (sessionId) {
          await reloadMessages(sessionId, sessionGenRef.current, surfaceGen);
        }
        try {
          await transport.getApproval(approvalId);
        } catch {
          // Listing approval after decision is best-effort confirmation.
        }
      } catch (err) {
        if (!isCurrentSurface(surfaceGen)) return;
        setError(toError(err));
        setLiveProposals((prev) =>
          prev.map((p) => (p.approvalId === approvalId ? { ...p, decisionPending: false } : p)),
        );
      }
    },
    [isCurrentSurface, reloadMessages, transport],
  );

  const rejectProposal = useCallback(
    async (approvalId: string, actionHash: string) => {
      const surfaceGen = surfaceGenRef.current;
      const sessionId = activeSessionIdRef.current;
      let op = actionOps.current.reject.get(approvalId);
      if (!op) {
        op = new RetainedOperationId();
        actionOps.current.reject.set(approvalId, op);
      }

      setLiveProposals((prev) =>
        prev.map((p) => (p.approvalId === approvalId ? { ...p, decisionPending: true } : p)),
      );

      try {
        await transport.rejectApproval(
          approvalId,
          { action_hash: actionHash },
          { operationId: op.id },
        );
        if (!isCurrentSurface(surfaceGen)) return;
        op.reset();
        actionOps.current.reject.delete(approvalId);
        if (sessionId) {
          await reloadMessages(sessionId, sessionGenRef.current, surfaceGen);
        }
      } catch (err) {
        if (!isCurrentSurface(surfaceGen)) return;
        setError(toError(err));
        setLiveProposals((prev) =>
          prev.map((p) => (p.approvalId === approvalId ? { ...p, decisionPending: false } : p)),
        );
      }
    },
    [isCurrentSurface, reloadMessages, transport],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      const surfaceGen = surfaceGenRef.current;
      let op = actionOps.current.rename.get(sessionId);
      if (!op) {
        op = new RetainedOperationId();
        actionOps.current.rename.set(sessionId, op);
      }
      try {
        const result = await transport.updateSession(sessionId, { title }, { operationId: op.id });
        if (!isCurrentSurface(surfaceGen)) return;
        op.reset();
        actionOps.current.rename.delete(sessionId);
        const mapped = mapSession(result.session);
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? mapped : s)));
      } catch (err) {
        if (isCurrentSurface(surfaceGen)) setError(toError(err));
      }
    },
    [isCurrentSurface, transport],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const surfaceGen = surfaceGenRef.current;
      let op = actionOps.current.delete.get(sessionId);
      if (!op) {
        op = new RetainedOperationId();
        actionOps.current.delete.set(sessionId, op);
      }
      try {
        await transport.deleteSession(sessionId, { operationId: op.id });
        if (!isCurrentSurface(surfaceGen)) return;
        op.reset();
        actionOps.current.delete.delete(sessionId);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (activeSessionIdRef.current === sessionId) {
          createNewSession();
        }
      } catch (err) {
        if (isCurrentSurface(surfaceGen)) setError(toError(err));
      }
    },
    [createNewSession, isCurrentSurface, transport],
  );

  const clearSession = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      setMessages([]);
      return;
    }
    const surfaceGen = surfaceGenRef.current;
    const op = actionOps.current.clear;
    try {
      await transport.clearSession(sessionId, { operationId: op.id });
      if (!isCurrentSurface(surfaceGen)) return;
      op.reset();
      setMessages([]);
      void loadSessions();
    } catch (err) {
      if (isCurrentSurface(surfaceGen)) setError(toError(err));
    }
  }, [isCurrentSurface, loadSessions, transport]);

  const loadMoreSessions = useCallback(async () => {
    if (!sessionsCursor || sessionsLoading) return;
    await loadSessions(sessionsCursor);
  }, [loadSessions, sessionsCursor, sessionsLoading]);

  const dismissError = useCallback(() => setError(null), []);

  return {
    sessions,
    sessionsLoading,
    sessionsCursor,
    activeSessionId,
    messages,
    messagesLoading,
    isStreaming,
    reasoningStatus,
    runId,
    error,
    liveProposals,
    composerPrefill,
    setComposerPrefill,
    loadMoreSessions,
    selectSession,
    createNewSession,
    renameSession,
    deleteSession,
    clearSession,
    sendMessage,
    sendDailyBriefing,
    editAndResend,
    retryMessage,
    regenerateMessage,
    stop,
    approveProposal,
    rejectProposal,
    dismissError,
    surfaceGeneration: surfaceGenRef.current,
  };
}
