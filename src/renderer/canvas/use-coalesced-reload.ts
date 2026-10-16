import { useCallback, useEffect, useRef } from "react";

/** Serialize invalidations; callers await the fresh read queued behind an unfinished read. */
export function useCoalescedReload(read: () => Promise<void>): () => Promise<void> {
  const latest = useRef(read);
  latest.current = read;
  const pending = useRef(false);
  const flight = useRef<Promise<void> | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      pending.current = false;
    };
  }, []);
  return useCallback((): Promise<void> => {
    if (!active.current) return Promise.resolve();
    pending.current = true;
    if (!flight.current) {
      flight.current = Promise.resolve().then(async () => {
        try {
          while (pending.current && active.current) {
            pending.current = false;
            await latest.current();
          }
        } finally {
          flight.current = null;
        }
      });
    }
    return flight.current;
  }, []);
}
