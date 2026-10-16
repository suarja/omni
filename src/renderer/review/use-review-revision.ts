import { useEffect, useState } from "react";

import type { ReviewEventsDesktopApi } from "../../shared/review-events";

/** Re-read on persisted changes and on focus, which recovers missed background events. */
export function useReviewRevision(api: Partial<ReviewEventsDesktopApi> | null | undefined): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (): void => setRevision((current) => current + 1);
    const unsubscribe = api?.onReviewChanged?.(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", refresh);
    };
  }, [api]);
  return revision;
}
