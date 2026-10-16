import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRequest } from "../../shared/agents-ipc";
import { samePlan } from "../../shared/agent-plan-freshness";
import type { DesktopApi } from "../../shared/ipc";

type AgentPreviewApi = Partial<Pick<DesktopApi, "listAgentRequests" | "refreshAgentRequest">> | null;
type AgentPreviewState = Readonly<{
  request: AgentRequest | null;
  updated: boolean;
  busy: boolean;
  error: string | null;
}>;

type AgentRequestPreview = AgentPreviewState &
  Readonly<{
    refresh: () => Promise<AgentRequest | null>;
    markUpdated: () => void;
  }>;

export function useAgentRequestPreview(api: AgentPreviewApi, requestId?: string): AgentRequestPreview {
  const [state, setState] = useState<AgentPreviewState>({
    request: null,
    updated: false,
    busy: Boolean(requestId),
    error: null,
  });
  const generation = useRef(0);
  const refresh = useCallback(async (): Promise<AgentRequest | null> => {
    if (!requestId) return null;
    const ticket = ++generation.current;
    setState((current) => ({ ...current, busy: true, error: null }));
    try {
      const saved = (await api?.listAgentRequests?.())?.requests.find((request) => request.requestId === requestId);
      if (ticket !== generation.current) return null;
      if (!saved) throw new Error("This request is no longer available; preview it again.");
      const request = api?.refreshAgentRequest ? await api.refreshAgentRequest(requestId) : saved;
      if (ticket !== generation.current) return null;
      setState((current) => ({
        request,
        busy: false,
        error: null,
        updated: current.updated || !samePlan(saved.plan, request.plan),
      }));
      return request;
    } catch (error: unknown) {
      if (ticket === generation.current)
        setState((current) => ({
          ...current,
          request: null,
          busy: false,
          error: error instanceof Error ? error.message : "The request could not be refreshed. Try again.",
        }));
      return null;
    }
  }, [api, requestId]);
  useEffect(() => {
    setState({ request: null, updated: false, busy: Boolean(requestId), error: null });
    if (requestId) void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh, requestId]);
  const markUpdated = useCallback((): void => setState((current) => ({ ...current, updated: true })), []);
  return { ...state, refresh, markUpdated };
}
