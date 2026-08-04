/**
 * Run streaming, send/edit/retry/regenerate/briefing, and durable stop.
 *
 * Operation retention is driven by AiStreamResult.state.terminal — never by
 * Promise resolution alone. Local abort does not auto-replay POSTs.
 */

import { useCallback } from "react";
import { createAiOperationId } from "../operation-id";
import type { ChatMessageView, ChatToolProposal } from "../message-view";
import type { AiRunStreamState } from "../types";
import type { AiStreamResult } from "../transport";
import { boundUtf8 } from "../utf8";
import { ActionKeys, terminalFromStreamResult, terminalFromThrown } from "./operations";
import { proposalFromStream, toError } from "./helpers";
import type { ConversationShared } from "./shared";
import { AI_USER_INPUT_BYTES_MAX, type ActiveRun, type StreamActionKind } from "./types";

export type AiRunApi = {
  messages: ChatMessageView[];
  isStreaming: boolean;
  reasoningStatus: string | null;
  runId: string | null;
  liveProposals: ChatToolProposal[];
  sendMessage: (text: string) => Promise<void>;
  sendDailyBriefing: () => Promise<void>;
  editAndResend: (messageId: string, text: string) => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;
  regenerateMessage: (messageId: string) => Promise<void>;
  stop: () => Promise<void>;
};

export function useAiRun(
  shared: ConversationShared,
  ensureSession: (surfaceGen: number) => Promise<string | null>,
): AiRunApi {
  const {
    transport,
    ops,
    messages,
    setMessages,
    isStreaming,
    setIsStreaming,
    reasoningStatus,
    setReasoningStatus,
    runId,
    setRunId,
    setError,
    liveProposals,
    setLiveProposals,
    surfaceGenRef,
    sessionGenRef,
    runGenRef,
    activeRunRef,
    activeSessionIdRef,
    focusedTaskIdRef,
    isCurrentSurface,
    reloadMessages,
    loadSessions,
  } = shared;

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
    [
      activeSessionIdRef,
      focusedTaskIdRef,
      runGenRef,
      setLiveProposals,
      setMessages,
      setReasoningStatus,
      setRunId,
    ],
  );

  const finishRun = useCallback(
    async (sessionId: string, runGeneration: number, surfaceGen: number, sessionGen: number) => {
      if (runGeneration !== runGenRef.current) return;
      activeRunRef.current = null;
      setIsStreaming(false);
      setReasoningStatus(null);
      setRunId(null);
      setLiveProposals([]);
      // Authoritative reload after terminal and interrupted outcomes alike.
      await reloadMessages(sessionId, sessionGen, surfaceGen);
      void loadSessions();
    },
    [
      activeRunRef,
      loadSessions,
      reloadMessages,
      runGenRef,
      setIsStreaming,
      setLiveProposals,
      setReasoningStatus,
      setRunId,
    ],
  );

  const runStream = useCallback(
    async (args: {
      kind: StreamActionKind;
      sessionId: string;
      actionKey: string;
      messageId?: string;
      optimisticUser?: ChatMessageView | null;
      invoke: (opts: {
        signal: AbortSignal;
        operationId: string;
        onState: (state: AiRunStreamState) => void;
      }) => Promise<AiStreamResult | unknown>;
    }) => {
      const surfaceGen = surfaceGenRef.current;
      const sessionGen = sessionGenRef.current;
      runGenRef.current += 1;
      const runGeneration = runGenRef.current;
      const controller = new AbortController();
      const operation = ops.retain(args.actionKey);
      const active: ActiveRun = {
        runGeneration,
        sessionId: args.sessionId,
        controller,
        operation,
        actionKey: args.actionKey,
        runId: null,
        kind: args.kind,
        messageId: args.messageId,
      };
      activeRunRef.current = active;

      setIsStreaming(true);
      setError(null);
      setReasoningStatus(null);
      setLiveProposals([]);

      if (args.optimisticUser) {
        setMessages((prev) => [...prev.filter((m) => !m.optimistic), args.optimisticUser!]);
      }

      let terminal = null as ReturnType<typeof terminalFromStreamResult>;

      try {
        const result = await args.invoke({
          signal: controller.signal,
          operationId: operation.id,
          onState: (state) => {
            if (activeRunRef.current?.runGeneration === runGeneration && state.runId) {
              activeRunRef.current.runId = state.runId;
            }
            applyStreamState(state, runGeneration, args.sessionId, args.optimisticUser);
          },
        });
        terminal = terminalFromStreamResult(result);
      } catch (err) {
        terminal = terminalFromThrown(err);
        if (!isCurrentSurface(surfaceGen)) return;
        if (runGeneration !== runGenRef.current) return;
        const mapped = toError(err);
        if (mapped.code !== "aborted") {
          setError(mapped);
        }
      } finally {
        if (isCurrentSurface(surfaceGen) && runGeneration === runGenRef.current) {
          // Release only on definitive local v1 terminal. Interrupted/EOF,
          // thrown network/protocol errors, and local abort retain the UUID.
          ops.releaseIfDefinitive(args.actionKey, terminal);
          await finishRun(args.sessionId, runGeneration, surfaceGen, sessionGen);
        }
      }
    },
    [
      activeRunRef,
      applyStreamState,
      finishRun,
      isCurrentSurface,
      ops,
      runGenRef,
      sessionGenRef,
      setError,
      setIsStreaming,
      setLiveProposals,
      setMessages,
      setReasoningStatus,
      surfaceGenRef,
    ],
  );

  const sendMessage = useCallback(
    async (rawText: string) => {
      const text = boundUtf8(rawText.trim(), AI_USER_INPUT_BYTES_MAX);
      if (!text || isStreaming) return;
      const surfaceGen = surfaceGenRef.current;
      const sessionId = await ensureSession(surfaceGen);
      if (!sessionId || !isCurrentSurface(surfaceGen)) return;

      const actionKey = ActionKeys.send(sessionId, text, focusedTaskIdRef.current);
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
        actionKey,
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
    [
      ensureSession,
      focusedTaskIdRef,
      isCurrentSurface,
      isStreaming,
      runStream,
      surfaceGenRef,
      transport,
    ],
  );

  const sendDailyBriefing = useCallback(async () => {
    if (isStreaming) return;
    const surfaceGen = surfaceGenRef.current;
    const sessionId = await ensureSession(surfaceGen);
    if (!sessionId || !isCurrentSurface(surfaceGen)) return;

    await runStream({
      kind: "briefing",
      sessionId,
      actionKey: ActionKeys.briefing(sessionId),
      invoke: ({ signal, operationId, onState }) =>
        transport.createDailyBriefing(sessionId, {
          signal,
          operationId,
          handlers: { onState },
        }),
    });
  }, [ensureSession, isCurrentSurface, isStreaming, runStream, surfaceGenRef, transport]);

  const editAndResend = useCallback(
    async (messageId: string, rawText: string) => {
      const text = boundUtf8(rawText.trim(), AI_USER_INPUT_BYTES_MAX);
      const sessionId = activeSessionIdRef.current;
      if (!text || !sessionId || isStreaming) return;

      await runStream({
        kind: "edit",
        sessionId,
        actionKey: ActionKeys.edit(sessionId, messageId, text, focusedTaskIdRef.current),
        messageId,
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
    [activeSessionIdRef, focusedTaskIdRef, isStreaming, runStream, transport],
  );

  const retryMessage = useCallback(
    async (messageId: string) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || isStreaming) return;

      await runStream({
        kind: "retry",
        sessionId,
        actionKey: ActionKeys.retry(sessionId, messageId),
        messageId,
        invoke: ({ signal, operationId, onState }) =>
          transport.retryResponse(sessionId, messageId, {
            signal,
            operationId,
            handlers: { onState },
          }),
      });
    },
    [activeSessionIdRef, isStreaming, runStream, transport],
  );

  const regenerateMessage = useCallback(
    async (messageId: string) => {
      const sessionId = activeSessionIdRef.current;
      if (!sessionId || isStreaming) return;

      await runStream({
        kind: "regenerate",
        sessionId,
        actionKey: ActionKeys.regenerate(sessionId, messageId),
        messageId,
        invoke: ({ signal, operationId, onState }) =>
          transport.regenerateResponse(sessionId, messageId, {
            signal,
            operationId,
            handlers: { onState },
          }),
      });
    },
    [activeSessionIdRef, isStreaming, runStream, transport],
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
  }, [activeRunRef, transport]);

  return {
    messages,
    isStreaming,
    reasoningStatus,
    runId,
    liveProposals,
    sendMessage,
    sendDailyBriefing,
    editAndResend,
    retryMessage,
    regenerateMessage,
    stop,
  };
}
