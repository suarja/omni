import { useCallback, useEffect, useRef, useState } from "react";
import { activeStorefronts } from "../../../domain/source-roles";
import type { StorefrontDetails } from "../../../shared/storefront-presentation-ipc";
import { parseStorefrontDetails } from "../../../shared/storefront-presentation-ipc";
import { parseStorefrontDriftReport, type StorefrontDriftReport } from "../../../shared/storefronts-ipc";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import { parseListOperationsResponse } from "../../../shared/operations-receipt-parsers";
import { useReviewRevision } from "../../review/use-review-revision";
import type { ResourceCanvasProps } from "../resource-canvas-types";

export function useStorefronts(canvas: ResourceCanvasProps): Readonly<{
  drift: Extract<StorefrontDriftReport, { status: "ready" }> | null;
  details: ReadonlyMap<string, StorefrontDetails>;
  receipts: readonly OperationReceipt[];
  loading: boolean;
  error: boolean;
  reload: () => Promise<void>;
}> {
  const api = canvas.api;
  const revision = useReviewRevision(api);
  const sourceKey = JSON.stringify(activeStorefronts(canvas.snapshot.registry).map((source) => source.ref.id));
  const [drift, setDrift] = useState<Extract<StorefrontDriftReport, { status: "ready" }> | null>(null);
  const [details, setDetails] = useState<ReadonlyMap<string, StorefrontDetails>>(new Map());
  const [receipts, setReceipts] = useState<readonly OperationReceipt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const ticket = useRef(0);
  const reload = useCallback(async (): Promise<void> => {
    const current = ++ticket.current;
    const sourceIds = JSON.parse(sourceKey) as string[];
    setLoading(true);
    setError(false);
    setDrift(null);
    setDetails(new Map());
    const results = await Promise.allSettled([
      api?.readStorefrontDrift?.(),
      api?.listOperations?.(),
      ...sourceIds.map(
        async (sourceId) =>
          [
            sourceId,
            api?.readStorefrontDetails
              ? parseStorefrontDetails(await api.readStorefrontDetails({ sourceId }))
              : undefined,
          ] as const,
      ),
    ]);
    if (ticket.current !== current) return;
    try {
      const read = results[0];
      if (read.status !== "fulfilled" || !read.value) {
        if (sourceIds.length) setError(true);
      } else {
        const parsed = parseStorefrontDriftReport(read.value);
        if (parsed.status === "ready") setDrift(parsed);
        else setError(true);
      }
      const history = results[1];
      setReceipts(
        history.status === "fulfilled" && history.value ? parseListOperationsResponse(history.value).receipts : [],
      );
      const next = new Map<string, StorefrontDetails>();
      results.slice(2).forEach((result, index) => {
        if (result.status === "fulfilled" && Array.isArray(result.value) && result.value[1])
          next.set(sourceIds[index]!, result.value[1] as StorefrontDetails);
        else
          next.set(sourceIds[index]!, {
            status: "blocked",
            code: "read-unavailable",
            message: "Storefront details are unavailable. Read the storefront again.",
          });
      });
      setDetails(next);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [api, sourceKey]);
  useEffect(() => {
    void reload();
    return () => {
      ticket.current += 1;
    };
  }, [reload, revision]);
  return { drift, details, receipts, loading, error, reload };
}
