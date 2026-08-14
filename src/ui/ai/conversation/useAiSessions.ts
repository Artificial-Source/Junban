/**
 * Session list, selection, deferred create, rename/delete/clear mutations.
 */

import { useCallback } from "react";
import type { ChatSessionView } from "../message-view";
import { ActionKeys } from "./operations";
import { mapSession, toError } from "./helpers";
import type { ConversationShared } from "./shared";

export type AiSessionsApi = {
  sessions: ChatSessionView[];
  sessionsLoading: boolean;
  sessionsCursor: string | null;
  activeSessionId: string | null;
  messagesLoading: boolean;
  loadMoreSessions: () => Promise<void>;
  selectSession: (sessionId: string | null) => Promise<void>;
  createNewSession: () => void;
  ensureSession: (surfaceGen: number) => Promise<string | null>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  clearSession: () => Promise<void>;
};

export function useAiSessions(shared: ConversationShared): AiSessionsApi {
  const {
    transport,
    ops,
    sessions,
    setSessions,
    sessionsLoading,
    sessionsCursor,
    activeSessionId,
    setActiveSessionId,
    messagesLoading,
    setMessages,
    setIsStreaming,
    setReasoningStatus,
    setRunId,
    setLiveProposals,
    setError,
    surfaceGenRef,
    sessionGenRef,
    runGenRef,
    activeSessionIdRef,
    isCurrentSurface,
    abortActiveRun,
    reloadMessages,
    loadSessions,
  } = shared;

  const selectSession = useCallback(
    async (sessionId: string | null) => {
      abortActiveRun();
      // Fence in-flight stream finally/onState so a prior run cannot mutate after switch.
      runGenRef.current += 1;
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
    [
      abortActiveRun,
      reloadMessages,
      runGenRef,
      sessionGenRef,
      setActiveSessionId,
      setError,
      setIsStreaming,
      setLiveProposals,
      setMessages,
      setReasoningStatus,
      setRunId,
      surfaceGenRef,
    ],
  );

  const createNewSession = useCallback(() => {
    // Deferred create: only clear local selection. Session is created on first send.
    abortActiveRun();
    runGenRef.current += 1;
    sessionGenRef.current += 1;
    setActiveSessionId(null);
    setMessages([]);
    setIsStreaming(false);
    setReasoningStatus(null);
    setRunId(null);
    setLiveProposals([]);
    setError(null);
    ops.resetDeferredChat();
  }, [
    abortActiveRun,
    ops,
    runGenRef,
    sessionGenRef,
    setActiveSessionId,
    setError,
    setIsStreaming,
    setLiveProposals,
    setMessages,
    setReasoningStatus,
    setRunId,
  ]);

  const ensureSession = useCallback(
    async (surfaceGen: number): Promise<string | null> => {
      if (activeSessionIdRef.current) return activeSessionIdRef.current;
      const title = "New chat";
      const key = ActionKeys.createSession(title);
      const op = ops.retain(key);
      try {
        const result = await transport.createSession({ title }, { operationId: op.id });
        if (!isCurrentSurface(surfaceGen)) return null;
        const session = mapSession(result.session);
        setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
        sessionGenRef.current += 1;
        setActiveSessionId(session.id);
        activeSessionIdRef.current = session.id;
        // Definitive success — release create identity so a later draft cannot replay it.
        ops.release(key);
        return session.id;
      } catch (err) {
        // Ambiguous/network failure retains create identity for exact retry.
        if (isCurrentSurface(surfaceGen)) setError(toError(err));
        return null;
      }
    },
    [
      activeSessionIdRef,
      isCurrentSurface,
      ops,
      sessionGenRef,
      setActiveSessionId,
      setError,
      setSessions,
      transport,
    ],
  );

  const renameSession = useCallback(
    async (sessionId: string, title: string) => {
      const surfaceGen = surfaceGenRef.current;
      const key = ActionKeys.rename(sessionId, title);
      const op = ops.retain(key);
      try {
        const result = await transport.updateSession(sessionId, { title }, { operationId: op.id });
        if (!isCurrentSurface(surfaceGen)) return;
        ops.release(key);
        const mapped = mapSession(result.session);
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? mapped : s)));
      } catch (err) {
        if (isCurrentSurface(surfaceGen)) setError(toError(err));
      }
    },
    [isCurrentSurface, ops, setError, setSessions, surfaceGenRef, transport],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const surfaceGen = surfaceGenRef.current;
      const key = ActionKeys.delete(sessionId);
      const op = ops.retain(key);
      try {
        await transport.deleteSession(sessionId, { operationId: op.id });
        if (!isCurrentSurface(surfaceGen)) return;
        ops.release(key);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (activeSessionIdRef.current === sessionId) {
          createNewSession();
        }
      } catch (err) {
        if (isCurrentSurface(surfaceGen)) setError(toError(err));
      }
    },
    [
      activeSessionIdRef,
      createNewSession,
      isCurrentSurface,
      ops,
      setError,
      setSessions,
      surfaceGenRef,
      transport,
    ],
  );

  const clearSession = useCallback(async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      setMessages([]);
      return;
    }
    const surfaceGen = surfaceGenRef.current;
    const key = ActionKeys.clear(sessionId);
    const op = ops.retain(key);
    try {
      await transport.clearSession(sessionId, { operationId: op.id });
      if (!isCurrentSurface(surfaceGen)) return;
      ops.release(key);
      setMessages([]);
      void loadSessions();
    } catch (err) {
      if (isCurrentSurface(surfaceGen)) setError(toError(err));
    }
  }, [
    activeSessionIdRef,
    isCurrentSurface,
    loadSessions,
    ops,
    setError,
    setMessages,
    surfaceGenRef,
    transport,
  ]);

  const loadMoreSessions = useCallback(async () => {
    if (!sessionsCursor || sessionsLoading) return;
    await loadSessions(sessionsCursor);
  }, [loadSessions, sessionsCursor, sessionsLoading]);

  return {
    sessions,
    sessionsLoading,
    sessionsCursor,
    activeSessionId,
    messagesLoading,
    loadMoreSessions,
    selectSession,
    createNewSession,
    ensureSession,
    renameSession,
    deleteSession,
    clearSession,
  };
}
