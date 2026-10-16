import type { ReactElement } from "react";
import { translateCount, useI18n } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { Glossary } from "../Glossary";
import { formatPassTime, needsComparison } from "../external-library/presentation";

export function LibraryPassBanner(): ReactElement | null {
  const rail = useCanvasRail();
  const { t, language } = useI18n();
  if (!rail) return null;
  const library = rail.externalLibrary;
  const uses = [...library.details.values()].flatMap((item) => item.uses);
  const modified = uses.filter(needsComparison).length;
  const removed = uses.filter((use) => use.state === "removed").length;
  const updates = uses.filter((use) => use.state === "update").length;
  const pass = library.list?.lastPass;
  const count = pass?.updates?.reduce((total, item) => total + item.copiesUpdated, 0) ?? 0;
  if (library.mode === "ask" && updates)
    return (
      <div className="external-callout">
        <b>{translateCount(t, "externalLibrary.askSummary", updates)}</b>
        <button className="canvas-secondary-button is-small" onClick={() => rail.open("review")}>
          {t("externalLibrary.view")}
        </button>
      </div>
    );
  if (count > 0)
    return (
      <div className="external-callout">
        <div>
          <b>
            {translateCount(t, "externalLibrary.autoSummary", count, {
              time: formatPassTime(pass?.finishedAt, t, language),
            })}
          </b>{" "}
          <Glossary concept="upstream" /> {t("externalLibrary.autoHint")}{" "}
          {modified ? translateCount(t, "externalLibrary.waitingHint", modified) : ""}{" "}
          {removed ? translateCount(t, "externalLibrary.removedBanner", removed) : ""}
        </div>
        <button className="canvas-secondary-button is-small" onClick={() => rail.open("activity")}>
          {t("externalLibrary.history")}
        </button>
      </div>
    );
  if (modified)
    return (
      <div className="external-callout is-warn">
        <b>{translateCount(t, "externalLibrary.waitingHint", modified)}</b>
        <button className="canvas-secondary-button is-small is-primary" onClick={() => rail.open("review")}>
          {t("externalLibrary.compare")}
        </button>
      </div>
    );
  return null;
}

export function SourcePageBanner(props: Readonly<{ sourceId: string }>): ReactElement | null {
  const rail = useCanvasRail()!;
  const { t } = useI18n();
  const details = rail.externalLibrary.details.get(props.sourceId);
  if (!details?.source) return null;
  const compare = details.uses.filter(needsComparison);
  if (compare.length)
    return (
      <div className="external-callout is-warn">
        <div>
          <b>
            {translateCount(t, "externalLibrary.modifiedCopies", compare.length, {
              projects: [...new Set(compare.map((use) => use.projectName))].join(t("externalLibrary.and")),
            })}
          </b>
          <p>{t("externalLibrary.modifiedHint")}</p>
        </div>
        <button
          className="canvas-secondary-button is-small is-primary"
          onClick={() => rail.openExternalDestination({ sourceId: props.sourceId, view: "compare" })}
        >
          {t("externalLibrary.compare")}
        </button>
      </div>
    );
  if (!details.uses.length)
    return (
      <div className="external-callout">
        <div>
          <b>{t("externalLibrary.noUses")}</b>
          <p>{t("externalLibrary.noUsesHint")}</p>
        </div>
      </div>
    );
  return null;
}
