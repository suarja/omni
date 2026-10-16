import { useEffect, useState, type ReactElement } from "react";
import type { DesktopApi } from "../../shared/ipc";
import { useI18n } from "../i18n";
import { Glossary } from "./Glossary";
export function ProjectProtection(
  props: Readonly<{ api: Partial<DesktopApi> | null | undefined; projectId: string }>,
): ReactElement {
  const { t } = useI18n();
  const [warn, setWarn] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    void props.api
      ?.getSettings?.()
      .then((settings) => {
        if (active) {
          setWarn(settings.agents.guard.warnProjectIds.includes(props.projectId));
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active) setError(t("projectView.operationFailed"));
      });
    return () => {
      active = false;
    };
  }, [props.api, props.projectId]);
  async function select(next: boolean): Promise<void> {
    if (busy || !props.api?.setGuardProjectMode) return;
    setBusy(true);
    setError(null);
    try {
      const response = await props.api.setGuardProjectMode({ projectId: props.projectId, warn: next });
      setWarn(response.warnProjectIds.includes(props.projectId));
    } catch {
      setError(t("projectView.operationFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sec" data-testid="project-protection">
      <h3>
        {t("projectView.protection")} <Glossary concept="guard" />
      </h3>
      <div className="item">
        <div className="grow">
          <b>{t("projectView.directChanges")}</b>
          <small>
            {loaded ? t(warn ? "projectView.guardWarn" : "projectView.guardBlock") : t("projectView.notObserved")}
          </small>
        </div>
        <div className="seg" role="group" aria-label={t("projectView.protection")}>
          {([false, true] as const).map((next) => (
            <button
              key={String(next)}
              type="button"
              disabled={!loaded || busy || !props.api?.setGuardProjectMode}
              aria-pressed={loaded && warn === next}
              onClick={() => void select(next)}
            >
              {t(next ? "projectView.warnOnly" : "projectView.throughOmni")}
            </button>
          ))}
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
