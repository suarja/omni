import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../../../shared/ipc";
import type { PreviewMarketplaceResponse, ApplyOperationResponse } from "../../../shared/operations-ipc";
import { parsePreviewMarketplaceResponse, parseApplyOperationResponse } from "../../../shared/operations-ipc";
import type {
  PublishPluginRequest,
  CreateStorefrontRequest,
  RetryPushRequest,
} from "../../../shared/publication-operations-ipc";
import type { AgentRequest } from "../../../shared/agents-ipc";
import {
  authorizeAssignmentRequest,
  releaseAssignmentRequest,
  completeAssignmentRequest,
  recordAssignmentFailure,
} from "../../operations/assignment-agent-outcome";

type Request = PublishPluginRequest | CreateStorefrontRequest | RetryPushRequest;
export function usePublication(
  api: Partial<DesktopApi> | null,
  request: Request | null,
  agentRequest: AgentRequest | undefined,
  onBusy: (busy: boolean) => void,
): Readonly<{
  preview: PreviewMarketplaceResponse | null;
  result: ApplyOperationResponse | null;
  checking: boolean;
  busy: boolean;
  error: string | null;
  recheck: () => Promise<void>;
  apply: () => Promise<ApplyOperationResponse | null>;
}> {
  const key = JSON.stringify(request);
  const inputs = useRef({ api, request, agentRequest, onBusy });
  inputs.current = { api, request, agentRequest, onBusy };
  const [preview, setPreview] = useState<PreviewMarketplaceResponse | null>(null);
  const [result, setResult] = useState<ApplyOperationResponse | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    locked = useRef(false);
  const recheck = useCallback(async (): Promise<void> => {
    if (locked.current) return;
    const current = ++generation.current;
    const { api, request, agentRequest } = inputs.current;
    setPreview(null);
    setResult(null);
    setError(null);
    if (!request || !api?.previewOperation) {
      setChecking(false);
      return;
    }
    setChecking(true);
    try {
      if (agentRequest && api.refreshAgentRequest) await api.refreshAgentRequest(agentRequest.requestId);
      const response = parsePreviewMarketplaceResponse(await api.previewOperation(request));
      if (generation.current === current) {
        setPreview(response);
        setPreviewKey(JSON.stringify(request));
      }
    } catch (error) {
      if (generation.current === current)
        setError(
          error instanceof Error ? error.message : "Publication preview failed. Read the storefront and preview again.",
        );
    } finally {
      if (generation.current === current) setChecking(false);
    }
  }, []);
  useEffect(() => {
    void recheck();
    return () => {
      generation.current += 1;
    };
  }, [key, api, recheck]);
  async function apply(): Promise<ApplyOperationResponse | null> {
    const { api, agentRequest, onBusy } = inputs.current;
    if (
      locked.current ||
      checking ||
      previewKey !== key ||
      preview?.status !== "ready" ||
      !api?.applyOperation ||
      preview.plan.publication?.findings.length ||
      preview.plan.publication?.conflicts.length
    )
      return null;
    locked.current = true;
    setBusy(true);
    setError(null);
    onBusy(true);
    let authorization: Awaited<ReturnType<typeof authorizeAssignmentRequest>>;
    let applied: ApplyOperationResponse | null = null;
    try {
      authorization = await authorizeAssignmentRequest(api, agentRequest?.requestId);
      applied = parseApplyOperationResponse(
        await api.applyOperation({
          planId: preview.plan.planId,
          provenance: {
            approval: "omni",
            ...(agentRequest?.harness
              ? {
                  agent: {
                    harness: agentRequest.harness,
                    ...(agentRequest.sessionName ? { sessionName: agentRequest.sessionName } : {}),
                    requestedAt: agentRequest.createdAt,
                  },
                }
              : {}),
          },
          ...(inputs.current.request?.kind === "publish-plugin"
            ? { conflictChoices: inputs.current.request.conflictChoices }
            : {}),
        }),
      );
      setResult(applied);
      setPreview(null);
      if (applied.status === "applied")
        await completeAssignmentRequest(api, agentRequest?.requestId, [applied.receipt], authorization);
      else
        await recordAssignmentFailure(
          api,
          agentRequest?.requestId,
          [applied.receipt],
          applied.receipt.diagnostic ?? "Publication failed.",
          authorization,
        );
      return applied;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Publication failed. Read History before retrying.");
      return null;
    } finally {
      try {
        await releaseAssignmentRequest(api, agentRequest?.requestId, authorization);
      } catch {
        setError("The publication approval lease could not be released. Inspect the request in Review.");
      }
      setPreview(null);
      locked.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return { preview: previewKey === key ? preview : null, result, checking, busy, error, recheck, apply };
}
