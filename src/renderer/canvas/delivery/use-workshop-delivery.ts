import { useEffect, useState, useCallback } from "react";
import type { DesktopApi } from "../../../shared/ipc";
import { parseWorkshopDelivery, type WorkshopDeliveryStatus } from "../../../shared/workshop-delivery-ipc";
import { useReviewRevision } from "../../review/use-review-revision";

export function useWorkshopDelivery(
  api: Partial<DesktopApi> | null,
  snapshot: unknown,
): Readonly<{
  status: WorkshopDeliveryStatus | null;
  loading: boolean;
  error: boolean;
  refresh: () => void;
}> {
  const revision = useReviewRevision(api);
  const [refreshKey, setRefreshKey] = useState(0);
  const [status, setStatus] = useState<WorkshopDeliveryStatus | null>(null);
  const [loading, setLoading] = useState(Boolean(api?.getWorkshopDelivery));
  const [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    if (!api?.getWorkshopDelivery) return;
    setLoading(true);
    void api
      .getWorkshopDelivery()
      .then((value) => {
        if (!current) return;
        setStatus(parseWorkshopDelivery(value));
        setError(false);
      })
      .catch(() => {
        if (current) setError(true);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, revision, snapshot, refreshKey]);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  return { status, loading, error, refresh };
}
