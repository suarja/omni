import { useRef, useState, type ReactElement } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import { useAppUpdates, type UpdateApi } from "./use-app-updates";

export function AppUpdateRestartControl({ api }: Readonly<{ api: UpdateApi }>): ReactElement | null {
  const { state } = useAppUpdates(api);
  const { t } = useI18n();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!state?.downloaded) return null;
  async function restart(): Promise<void> {
    if (pending.current || !api?.restartForUpdate) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      await api.restartForUpdate();
    } catch {
      setError(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <span className="app-update-restart" aria-busy={busy}>
      <button
        className="canvas-secondary-button is-primary is-small"
        data-testid="restart-to-update"
        type="button"
        disabled={busy || !state.available || !api?.restartForUpdate}
        onClick={() => void restart()}
      >
        <Icon name="refresh" size={16} />
        {t("uxSettings.restartUpdate")}
        <span className="app-update-attention" aria-hidden="true" />
      </button>
      {error ? <small role="alert">{t("uxSettings.updatesError")}</small> : null}
    </span>
  );
}
