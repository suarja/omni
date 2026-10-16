import { useEffect, useRef, useState, type ReactElement } from "react";
import type { LoginItemDesktopApi, LoginItemState } from "../../shared/login-item-ipc";
import { useI18n } from "../i18n";

export function LoginItemRow({ api }: Readonly<{ api: Partial<LoginItemDesktopApi> | null }>): ReactElement {
  const { t } = useI18n();
  const [state, setState] = useState<LoginItemState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const revision = useRef(0);
  const changing = useRef(false);
  useEffect(() => {
    const refresh = (): void => {
      if (changing.current) return;
      const request = ++revision.current;
      void api
        ?.getLoginItem?.()
        .then((value) => {
          if (revision.current !== request) return;
          setState(value);
          setError(false);
        })
        .catch(() => {
          if (revision.current !== request) return;
          setState(null);
          setError(true);
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      ++revision.current;
      window.removeEventListener("focus", refresh);
    };
  }, [api]);
  async function toggle(): Promise<void> {
    if (!state?.available || !api?.setLoginItem || changing.current) return;
    changing.current = true;
    const request = ++revision.current;
    setBusy(true);
    setError(false);
    try {
      const next = await api.setLoginItem({ openAtLogin: !state.openAtLogin });
      if (revision.current === request) setState(next);
    } catch {
      if (revision.current === request) setError(true);
    } finally {
      changing.current = false;
      if (revision.current === request) setBusy(false);
    }
  }
  const hint =
    state?.status === "requires-approval"
      ? "uxSettings.loginApproval"
      : state?.available
        ? "uxSettings.loginHint"
        : "uxSettings.loginUnavailable";
  return (
    <div className="item" data-testid="settings-login-item">
      <div className="grow">
        <b>{t("uxSettings.openAtLogin")}</b>
        <small>{t(hint)}</small>
        {error ? <small role="alert">{t("uxSettings.loginError")}</small> : null}
      </div>
      <button
        className="canvas-switch"
        type="button"
        role="switch"
        aria-label={t("uxSettings.openAtLogin")}
        aria-checked={state?.openAtLogin ?? false}
        disabled={busy || !state?.available || !api?.setLoginItem}
        onClick={() => void toggle()}
      />
    </div>
  );
}
