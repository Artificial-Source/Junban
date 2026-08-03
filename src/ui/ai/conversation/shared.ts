/**
 * Shared conversation surface state: generations, refs, paging reload, ops.
 *
 * Feature hooks (sessions/run/approvals) compose over this bag without context.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { mapAiMessageDtos } from "../message-mapper";
import type { ChatMessageView, ChatSessionView, ChatToolProposal } from "../message-view";
import {
  defaultConversationTransport,
  type ConversationTransport,
} from "../conversation-transport";
import { ConversationOperations } from "./operations";
import { mapSession, toError } from "./helpers";
import type { ActiveRun, ConversationError, UseAiConversationOptions } from "./types";

export type ConversationShared = {
  transport: ConversationTransport;
  enabled: boolean;
  ops: ConversationOperations;

  sessions: ChatSessionView[];
  setSessions: Dispatch<SetStateAction<ChatSessionView[]>>;
  sessionsLoading: boolean;
  setSessionsLoading: Dispatch<SetStateAction<boolean>>;
  sessionsCursor: string | null;
  setSessionsCursor: Dispatch<SetStateAction<string | null>>;
  activeSessionId: string | null;
  setActiveSessionId: Dispatch<SetStateAction<string | null>>;
  messages: ChatMessageView[];
  setMessages: Dispatch<SetStateAction<ChatMessageView[]>>;
  messagesLoading: boolean;
  setMessagesLoading: Dispatch<SetStateAction<boolean>>;
  isStreaming: boolean;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  reasoningStatus: string | null;
  setReasoningStatus: Dispatch<SetStateAction<string | null>>;
  runId: string | null;
  setRunId: Dispatch<SetStateAction<string | null>>;
  error: ConversationError | null;
  setError: Dispatch<SetStateAction<ConversationError | null>>;
  liveProposals: ChatToolProposal[];
  setLiveProposals: Dispatch<SetStateAction<ChatToolProposal[]>>;
  composerPrefill: string;
  setComposerPrefill: Dispatch<SetStateAction<string>>;

  surfaceGenRef: MutableRefObject<number>;
  sessionGenRef: MutableRefObject<number>;
  runGenRef: MutableRefObject<number>;
  activeRunRef: MutableRefObject<ActiveRun | null>;
  activeSessionIdRef: MutableRefObject<string | null>;
  focusedTaskIdRef: MutableRefObject<string | null>;
  mountedRef: MutableRefObject<boolean>;

  isCurrentSurface: (gen: number) => boolean;
  abortActiveRun: () => void;
  reloadMessages: (sessionId: string, sessionGen: number, surfaceGen: number) => Promise<void>;
  loadSessions: (cursor?: string | null) => Promise<void>;
};

export function useConversationShared(options: UseAiConversationOptions = {}): ConversationShared {
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
  const opsRef = useRef(new ConversationOperations());
  const ops = opsRef.current;

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

  return {
    transport,
    enabled,
    ops,
    sessions,
    setSessions,
    sessionsLoading,
    setSessionsLoading,
    sessionsCursor,
    setSessionsCursor,
    activeSessionId,
    setActiveSessionId,
    messages,
    setMessages,
    messagesLoading,
    setMessagesLoading,
    isStreaming,
    setIsStreaming,
    reasoningStatus,
    setReasoningStatus,
    runId,
    setRunId,
    error,
    setError,
    liveProposals,
    setLiveProposals,
    composerPrefill,
    setComposerPrefill,
    surfaceGenRef,
    sessionGenRef,
    runGenRef,
    activeRunRef,
    activeSessionIdRef,
    focusedTaskIdRef,
    mountedRef,
    isCurrentSurface,
    abortActiveRun,
    reloadMessages,
    loadSessions,
  };
}
