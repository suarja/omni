import type { ReactElement } from "react";
import type { ExternalUse } from "../../../shared/external-library-ipc";
import { useI18n } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { formatSourceDate, needsComparison } from "./presentation";
import { Glossary } from "../Glossary";

export function SkillCallouts(
  props: Readonly<{ use: ExternalUse; onCapture: () => void; busy?: boolean }>,
): ReactElement | null {
  const rail = useCanvasRail();
  const { t, language } = useI18n();
  if (!rail) return null;
  const use = props.use,
    library = rail.externalLibrary;
  const details = library.details.get(use.sourceId);
  const source = details?.source;
  const skill = details?.skills.find((skill) => skill.useIds.includes(use.id));
  const twin = [...library.details.values()].find(
    (item) => item.source?.id !== use.sourceId && item.skills.some((skill) => skill.name === use.skillKey),
  );
  function compare(): void {
    rail!.openExternalContext({
      sourceId: use.sourceId,
      skillName: use.skillKey,
      skillPath: use.skillPath,
      useId: use.id,
      view: "compare",
    });
  }
  return (
    <>
      {use.lastAutomaticFailure ? (
        <div className="external-callout is-warn" role="alert">
          <div>
            <b>{t("externalLibrary.failed")}</b>
            <p>{use.lastAutomaticFailure.reason}</p>
          </div>
          <button type="button" className="canvas-secondary-button is-small" onClick={compare}>
            {t("externalLibrary.view")}
          </button>
        </div>
      ) : null}
      {use.state === "update" && library.mode === "ask" ? (
        <div className="external-callout">
          <div>
            <b>
              {t("externalLibrary.upstreamTitle")} <Glossary concept="upstream" />
            </b>
            <p>
              {t("externalLibrary.upstreamHint", {
                source: source?.name ?? use.sourceId,
                date: formatSourceDate(skill?.lastChangeAt, language),
              })}
            </p>
          </div>
          <button
            type="button"
            className="canvas-secondary-button is-small is-primary"
            disabled={props.busy}
            onClick={compare}
          >
            {t("externalLibrary.viewUpdate")}
          </button>
        </div>
      ) : needsComparison(use) ? (
        <div className="external-callout is-warn">
          <div>
            <b>
              {t("externalLibrary.modifiedTitle")} <Glossary concept="modified" />
            </b>
            <p>
              {t("externalLibrary.modifiedCallout", {
                source: source?.name ?? use.sourceId,
                date: formatSourceDate(skill?.lastChangeAt, language),
              })}
            </p>
          </div>
          <button
            type="button"
            className="canvas-secondary-button is-small is-primary"
            disabled={props.busy}
            onClick={compare}
          >
            {t("externalLibrary.compare")}
          </button>
        </div>
      ) : use.state === "unknown" ? (
        <div className="external-callout is-warn" role="alert">
          <div>
            <b>{t("externalLibrary.unknown")}</b>
            <p>{use.diagnostic ?? source?.lastError?.message}</p>
          </div>
        </div>
      ) : use.state === "removed" ? (
        <div className="external-callout is-gone">
          <div>
            <b>
              {t("externalLibrary.removedTitle", {
                source: source?.name ?? use.sourceId,
                date: formatSourceDate(use.removal?.date, language),
              })}{" "}
              <Glossary concept="removed" />
            </b>
            {use.removal?.subject ? <p>{t("externalLibrary.author", { subject: use.removal.subject })}</p> : null}
            <p>{t("externalLibrary.removedHint")}</p>
            {twin?.source ? (
              <p>{t("externalLibrary.sameName", { source: twin.source.name, name: use.skillKey })}</p>
            ) : null}
          </div>
          <div className="external-stack">
            {twin?.source ? (
              <button
                type="button"
                className="canvas-secondary-button is-small"
                onClick={() => rail.openExternalDestination({ sourceId: twin.source!.id, view: "source" })}
              >
                {t("externalLibrary.viewRepo", { repo: twin.source.name.split("/").at(-1)! })}
              </button>
            ) : null}
            <button
              type="button"
              className="canvas-secondary-button is-small"
              disabled={props.busy}
              onClick={props.onCapture}
            >
              {t("externalLibrary.ownCopy")}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
