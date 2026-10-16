import { useEffect, useRef, useState } from "react";
import type { AppUpdatesDesktopApi, AppUpdateState } from "../../shared/app-updates-ipc";

export type UpdateApi = Partial<AppUpdatesDesktopApi> | null | undefined;
export function useAppUpdates(api: UpdateApi): Readonly<{
  state: AppUpdateState | null;
  busy: boolean;
  error: boolean;
  toggle: () => Promise<void>;
}> {
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  const changing = useRef(false);
  useEffect(() => {
    const request = ++revision.current;
    let active = true;
    const stop = api?.onAppUpdatesChanged?.((value) => {
      if (!active) return;
      ++revision.current;
      setState(value);
    });
    void api
      ?.getAppUpdates?.()
      .then((value) => {
        if (active && revision.current === request) setState(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      ++revision.current;
      stop?.();
    };
  }, [api]);
  async function toggle(): Promise<void> {
    if (!state?.available || !api?.setAppUpdates || changing.current) return;
    changing.current = true;
    setBusy(true);
    setError(false);
    const request = ++revision.current;
    try {
      const next = await api.setAppUpdates({ enabled: !state.enabled });
      if (revision.current === request) setState(next);
    } catch {
      if (revision.current === request) setError(true);
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }
  return { state, busy, error, toggle };
}
