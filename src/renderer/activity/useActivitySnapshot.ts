import { useCallback, useEffect, useState } from "react";

import type { ActivitySnapshot } from "../../shared/activity-ipc";
import type { DesktopApi } from "../../shared/ipc";

const EMPTY_SNAPSHOT: ActivitySnapshot = {
  sessions: [],
  processes: [],
  worktrees: [],
  platformSupported: true,
};

export function useActivitySnapshot(
  api: DesktopApi | null | undefined,
  paused: boolean,
): Readonly<{
  /** The diagnostic of the last failed refresh (bridge unavailable, rejected snapshot); `null` once a refresh succeeds. */
  failure: string | null;
  loaded: boolean;
  refresh: () => Promise<void>;
  snapshot: ActivitySnapshot;
}> {
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>(EMPTY_SNAPSHOT);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!api?.getActivitySnapshot) return;
    try {
      const response = await api.getActivitySnapshot();
      if (response.status === "ready") {
        setSnapshot(response.snapshot);
        setLoaded(true);
        setFailure(null);
      } else {
        setFailure(response.diagnostic);
      }
    } catch (error: unknown) {
      // Keep the last local snapshot, but say why this refresh failed instead of showing
      // "Loading…" forever — Activity must stay usable exactly when the machine is struggling.
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (paused) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [paused, refresh]);

  return { failure, loaded, refresh, snapshot };
}
