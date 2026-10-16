import { useEffect, useRef, useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import { useOptionalCanvasToast } from "../canvas/CanvasToast";
import { useAppUpdates, type UpdateApi } from "./use-app-updates";

export function AppUpdateRow({ api }: Readonly<{ api: UpdateApi }>): ReactElement {
  const { t } = useI18n();
  const { state, busy, error, toggle } = useAppUpdates(api);
  const [restartError, setRestartError] = useState(false);
  return (
    <div className="item" data-testid="settings-app-updates">
      <div className="grow">
        <b>{t("uxSettings.installUpdates")}</b>
        <small>{t(state?.available ? "uxSettings.updatesHint" : "uxSettings.updatesUnavailable")}</small>
        {error || restartError || state?.error ? <small role="alert">{t("uxSettings.updatesError")}</small> : null}
        {state?.downloaded ? (
          <button
            className="canvas-secondary-button is-small"
            type="button"
            onClick={() => void api?.restartForUpdate?.().catch(() => setRestartError(true))}
          >
            {t("uxSettings.restartUpdate")}
          </button>
        ) : null}
      </div>
      <button
        className="canvas-switch"
        type="button"
        role="switch"
        aria-label={t("uxSettings.installUpdates")}
        aria-checked={state?.enabled ?? true}
        disabled={busy || !state?.available || !api?.setAppUpdates}
        onClick={() => void toggle()}
      />
    </div>
  );
}

export function AppUpdateNotification({ api }: Readonly<{ api: UpdateApi }>): null {
  const { state } = useAppUpdates(api);
  const { t } = useI18n();
  const toast = useOptionalCanvasToast();
  const show = toast?.show;
  const dismiss = toast?.dismiss;
  const announced = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!state?.downloaded) {
      if (announced.current) dismiss?.(announced.current);
      announced.current = undefined;
      return;
    }
    const message = t("uxSettings.updateReady");
    if (announced.current === message || !show) return;
    announced.current = message;
    show({
      message,
      action: {
        label: t("uxSettings.restartUpdate"),
        run: () => {
          void api?.restartForUpdate?.().catch(() => show({ message: t("uxSettings.updatesError") }));
        },
      },
    });
  }, [state?.downloaded, show, dismiss, api, t]);
  return null;
}
