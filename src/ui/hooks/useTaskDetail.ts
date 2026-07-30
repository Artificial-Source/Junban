/**
 * Task detail data hooks: comments, relations, activity.
 * Each loads lazily when a task detail panel/page is opened.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommentDto,
  CommentListResponse,
  RelationListResponse,
  TaskActivityResponse,
  TaskActivityDto,
  RelationDto,
} from "../api/client";
import {
  listComments,
  listRelations,
  listTaskActivity,
  ApiError,
  hasStoredToken,
} from "../api/client";

type LoadState = "idle" | "loading" | "ready" | "error";

export interface CommentsState {
  comments: CommentDto[];
  loading: LoadState;
  error: string | null;
}

export function useComments(taskId: string | null) {
  const [state, setState] = useState<CommentsState>({
    comments: [],
    loading: "idle",
    error: null,
  });
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!taskId || !hasStoredToken()) return;
    const requestId = ++requestIdRef.current;
    setState((prev) => ({ ...prev, loading: "loading", error: null }));
    try {
      const result: CommentListResponse = await listComments(taskId);
      if (requestIdRef.current !== requestId) return;
      setState({ comments: result.comments, loading: "ready", error: null });
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setState((prev) => ({
        comments: prev.comments,
        loading: "error",
        error: err instanceof ApiError ? err.message : "Could not load comments.",
      }));
    }
  }, [taskId]);

  useEffect(() => {
    if (taskId) void load();
    else setState({ comments: [], loading: "idle", error: null });
  }, [taskId, load]);

  return { ...state, reload: load };
}

export interface RelationsState {
  blocks: RelationDto[];
  blockedBy: RelationDto[];
  loading: LoadState;
  error: string | null;
}

export function useRelations(taskId: string | null) {
  const [state, setState] = useState<RelationsState>({
    blocks: [],
    blockedBy: [],
    loading: "idle",
    error: null,
  });
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!taskId || !hasStoredToken()) return;
    const requestId = ++requestIdRef.current;
    setState((prev) => ({ ...prev, loading: "loading", error: null }));
    try {
      const result: RelationListResponse = await listRelations(taskId);
      if (requestIdRef.current !== requestId) return;
      setState({
        blocks: result.relations.filter((r) => r.from_task_id === taskId),
        blockedBy: result.relations.filter((r) => r.to_task_id === taskId),
        loading: "ready",
        error: null,
      });
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setState((prev) => ({
        blocks: prev.blocks,
        blockedBy: prev.blockedBy,
        loading: "error",
        error: err instanceof ApiError ? err.message : "Could not load relations.",
      }));
    }
  }, [taskId]);

  useEffect(() => {
    if (taskId) void load();
    else setState({ blocks: [], blockedBy: [], loading: "idle", error: null });
  }, [taskId, load]);

  return { ...state, reload: load };
}

export interface ActivityState {
  activity: TaskActivityDto[];
  loading: LoadState;
  error: string | null;
}

export function useTaskActivity(taskId: string | null) {
  const [state, setState] = useState<ActivityState>({
    activity: [],
    loading: "idle",
    error: null,
  });
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!taskId || !hasStoredToken()) return;
    const requestId = ++requestIdRef.current;
    setState((prev) => ({ ...prev, loading: "loading", error: null }));
    try {
      const result: TaskActivityResponse = await listTaskActivity(taskId);
      if (requestIdRef.current !== requestId) return;
      setState({ activity: result.activity, loading: "ready", error: null });
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setState((prev) => ({
        activity: prev.activity,
        loading: "error",
        error: err instanceof ApiError ? err.message : "Could not load activity.",
      }));
    }
  }, [taskId]);

  useEffect(() => {
    if (taskId) void load();
    else setState({ activity: [], loading: "idle", error: null });
  }, [taskId, load]);

  return { ...state, reload: load };
}
