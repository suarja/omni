import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SkillIntent, SkillPreview, SkillResult } from "../../../shared/skill-management-ipc";
import { createAgentSkillPreviewReader } from "./agent-skill-preview";
import type { DesktopApi } from "../../../shared/ipc";

type SkillOperationApi =
  | (Pick<
      DesktopApi,
      "previewSkillOperation" | "refreshSkillOperation" | "applySkillOperation" | "readSkillOperationResult"
    > &
      Partial<Pick<DesktopApi, "onReviewChanged" | "refreshAgentRequest" | "listAgentRequests">>)
  | null;

function previewError(error: unknown, fallback: string): Readonly<{ message: string; detail: string | null }> {
  const message = error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  const detail = message.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
  return {
    message: detail || fallback,
    detail:
      process.env.NODE_ENV === "production" ? null : error instanceof Error ? (error.stack ?? message) : detail || null,
  };
}

type SkillOperation = Readonly<{
  intent: SkillIntent | null;
  preview: SkillPreview | null;
  result: SkillResult | null;
  progress: SkillResult | null;
  busy: boolean;
  applying: boolean;
  error: string | null;
  errorDetail: string | null;
  updatedAgentPreview: boolean;
  inspect: (intent: SkillIntent) => Promise<void>;
  refresh: () => Promise<SkillPreview | null>;
  resume: (intent: SkillIntent, intentId?: string) => Promise<void>;
  apply: () => Promise<SkillResult | null>;
  loadResult: (intentId: string) => Promise<void>;
  clearReview: () => void;
}>;

export function useSkillOperation(api: SkillOperationApi, requestId?: string): SkillOperation {
  const [intent, setIntent] = useState<SkillIntent | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [result, setResult] = useState<SkillResult | null>(null);
  const [progress, setProgress] = useState<SkillResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const revision = useRef(0);
  const [updatedAgentPreview, setUpdatedAgentPreview] = useState(false);

  const reader = useMemo(() => (api ? createAgentSkillPreviewReader(api) : null), [api]);
  const recoverAgentPreview = useCallback(
    async (id: string): Promise<SkillPreview> => {
      if (!reader) throw new Error("Agent request refresh is unavailable.");
      return reader.recover(id);
    },
    [reader],
  );

  const recoverPreview = useCallback(
    async (response: SkillPreview, id?: string): Promise<SkillPreview> => {
      if (
        !id ||
        (response.status !== "stale" &&
          !(response.status === "blocked" && response.details.some((item) => item.code === "intent-unavailable")))
      )
        return response;
      return recoverAgentPreview(id);
    },
    [recoverAgentPreview],
  );

  useEffect(
    () => () => {
      revision.current += 1;
    },
    [],
  );

  const inspect = useCallback(
    async (nextIntent: SkillIntent): Promise<void> => {
      const ticket = ++revision.current;
      const operationRequestId = nextIntent.kind === "write" ? requestId : undefined;
      setIntent(nextIntent);
      setActiveRequestId(operationRequestId);
      setPreview(null);
      setResult(null);
      setProgress(null);
      setError(null);
      setErrorDetail(null);
      if (!api?.previewSkillOperation) {
        setError("Skill changes are unavailable in this session.");
        return;
      }
      setBusy(true);
      try {
        const saved = await api.previewSkillOperation({
          intent: nextIntent,
          ...(operationRequestId ? { requestId: operationRequestId } : {}),
        });
        const response = await recoverPreview(saved, operationRequestId);
        if (ticket === revision.current) {
          setPreview(response);
          setUpdatedAgentPreview(response !== saved);
        }
      } catch (error) {
        if (ticket === revision.current) {
          const failure = previewError(error, "The preview could not be prepared. Refresh and try again.");
          setError(failure.message);
          setErrorDetail(failure.detail);
        }
      } finally {
        if (ticket === revision.current) setBusy(false);
      }
    },
    [api, requestId, recoverPreview],
  );

  const refresh = useCallback(async (): Promise<SkillPreview | null> => {
    if (!preview || !api?.refreshSkillOperation) return null;
    const ticket = ++revision.current;
    setBusy(true);
    setError(null);
    setErrorDetail(null);
    try {
      const refreshed = await reader!.read(preview.intentId, activeRequestId);
      const response = refreshed.preview;
      if (ticket !== revision.current) return null;
      if (refreshed.updated) setUpdatedAgentPreview(true);
      setPreview(response);
      return response;
    } catch (error) {
      if (ticket === revision.current) {
        const failure = previewError(error, "The preview could not be refreshed. Review the operation again.");
        setError(failure.message);
        setErrorDetail(failure.detail);
      }
      return null;
    } finally {
      if (ticket === revision.current) setBusy(false);
    }
  }, [activeRequestId, api, preview, reader]);

  const resume = useCallback(
    async (nextIntent: SkillIntent, intentId?: string): Promise<void> => {
      const ticket = ++revision.current;
      setIntent(nextIntent);
      setActiveRequestId(requestId);
      setPreview(null);
      setResult(null);
      setProgress(null);
      setError(null);
      setErrorDetail(null);
      if (!api?.refreshSkillOperation) {
        setError("Skill changes are unavailable in this session.");
        return;
      }
      setBusy(true);
      try {
        if (!intentId && !requestId) throw new Error("The saved request identity is unavailable.");
        const refreshed = intentId
          ? await reader!.read(intentId, requestId)
          : { preview: await reader!.recover(requestId!), updated: true };
        const response = refreshed.preview;
        if (ticket === revision.current) {
          setPreview(response);
          setUpdatedAgentPreview(refreshed.updated);
        }
      } catch {
        if (ticket === revision.current)
          setError("The saved skill request could not be reopened. Refresh and try again.");
      } finally {
        if (ticket === revision.current) setBusy(false);
      }
    },
    [api, requestId, reader],
  );

  const apply = useCallback(async (): Promise<SkillResult | null> => {
    if (preview?.status !== "ready" || !api?.applySkillOperation) return null;
    setApplying(true);
    const ticket = ++revision.current;
    setBusy(true);
    setError(null);
    setErrorDetail(null);
    try {
      let approvedPreview = preview;
      if (activeRequestId && api.refreshSkillOperation) {
        const refreshed = await reader!.read(preview.intentId, activeRequestId);
        const fresh = refreshed.preview;
        if (ticket !== revision.current) return null;
        if (refreshed.updated || fresh.status !== "ready" || fresh.effectFingerprint !== preview.effectFingerprint) {
          setPreview(fresh);
          setUpdatedAgentPreview(true);
          return null;
        }
        approvedPreview = fresh;
      }
      const response = await api.applySkillOperation({
        intentId: approvedPreview.intentId,
        effectFingerprint: approvedPreview.effectFingerprint,
        ...(activeRequestId ? { requestId: activeRequestId } : {}),
      });
      if (ticket === revision.current) setResult(response);
      return response;
    } catch (error) {
      if (activeRequestId && error instanceof Error && error.message.includes("does not match this operation")) {
        try {
          const fresh = await reader!.recover(activeRequestId);
          if (ticket === revision.current) {
            setPreview(fresh);
            setUpdatedAgentPreview(true);
          }
          return null;
        } catch {
          // Keep the failed apply visible if the request cannot be recovered safely.
        }
      }
      if (ticket === revision.current)
        setError("The operation could not be completed. Refresh the preview before retrying.");
      return null;
    } finally {
      setApplying(false);
      if (ticket === revision.current) setBusy(false);
    }
  }, [activeRequestId, api, preview, reader]);

  useEffect(() => {
    if (!applying || !preview || !api?.readSkillOperationResult) return;
    const readResult = api.readSkillOperationResult;
    let active = true;
    const read = (): void => {
      void readResult({ intentId: preview.intentId })
        .then((saved) => {
          if (active && saved) setProgress(saved);
        })
        .catch(() => undefined);
    };
    read();
    const unsubscribe = api.onReviewChanged?.(read);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [api, applying, preview]);

  const loadResult = useCallback(
    async (intentId: string): Promise<void> => {
      const ticket = ++revision.current;
      setBusy(true);
      setError(null);
      setErrorDetail(null);
      try {
        const response = await api?.readSkillOperationResult?.({ intentId });
        if (ticket === revision.current) {
          if (response) setResult(response);
          else setError("The saved operation result is unavailable; no effect was repeated.");
        }
      } catch {
        if (ticket === revision.current) setError("The saved operation result could not be opened.");
      } finally {
        if (ticket === revision.current) setBusy(false);
      }
    },
    [api],
  );

  const clearReview = useCallback((): void => {
    revision.current += 1;
    setBusy(false);
    setUpdatedAgentPreview(false);
    setIntent(null);
    setActiveRequestId(undefined);
    setPreview(null);
    setResult(null);
    setProgress(null);
    setError(null);
    setErrorDetail(null);
  }, []);

  return {
    intent,
    updatedAgentPreview,
    preview,
    result,
    progress,
    busy,
    applying,
    error,
    errorDetail,
    inspect,
    refresh,
    resume,
    apply,
    loadResult,
    clearReview,
  };
}
