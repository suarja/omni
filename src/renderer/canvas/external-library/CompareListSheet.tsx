import type { ReactElement } from "react";
import { useI18n, translateCount } from "../../i18n";
import { SheetFrame } from "../SheetFrame";
import { Glossary } from "../Glossary";
import { useCanvasRail } from "../rail/rail-context";
import { needsComparison, formatSourceDate, useProjectLabel } from "./presentation";
import { useComparisonCounts } from "./use-comparison-counts";

export function CompareListSheet(props: Readonly<{ sourceId: string }>): ReactElement | null {
  const rail = useCanvasRail();
  const { t, language } = useI18n();
  const details = rail?.externalLibrary.details.get(props.sourceId);
  const rows =
    details?.uses.filter(
      (use) => needsComparison(use) || (rail?.externalLibrary.mode === "ask" && use.state === "update"),
    ) ?? [];
  const counts = useComparisonCounts(rail?.canvas.api ?? null, details?.source?.head?.commit, rows);
  if (!rail) return null;
  return (
    <SheetFrame
      title={t("externalLibrary.compareTitle")}
      subtitle={t("externalLibrary.versionShort", {
        version: details?.source?.head?.commit.slice(0, 7) ?? "—",
        date: formatSourceDate(details?.source?.head?.date, language),
      })}
      kicker={
        <>
          {details?.source?.name ?? props.sourceId} <Glossary concept="modified" />
        </>
      }
      testId="external-compare-list"
      className="external-library-sheet"
      onClose={rail.close}
      footer={
        <button
          className="canvas-secondary-button"
          type="button"
          onClick={() => rail.openExternalDestination({ sourceId: props.sourceId, view: "source" })}
        >
          {t("externalLibrary.back")}
        </button>
      }
    >
      <p className="sh-sub">{t("externalLibrary.compareIntro")}</p>
      <div className="external-rows">
        {rows.map((use) => (
          <div key={use.id} className="external-row">
            <div>
              <b>{use.skillKey}</b>
              <small data-comparison-ready={counts.has(use.id) || undefined}>
                {useProjectLabel(use, details?.uses ?? [])}
                {counts.get(use.id)?.files !== undefined
                  ? ` · ${translateCount(t, "externalLibrary.changedFiles", counts.get(use.id)!.files!)}`
                  : counts.get(use.id)?.missingBase
                    ? ` · ${t("externalLibrary.missingBase")}`
                    : ""}
              </small>
              {counts.get(use.id)?.error ? (
                <small className="external-error" role="alert">
                  {counts.get(use.id)!.error}
                </small>
              ) : null}
            </div>
            <button
              className="canvas-secondary-button is-small"
              type="button"
              onClick={() =>
                rail.openExternalDestination({
                  sourceId: props.sourceId,
                  skillName: use.skillKey,
                  skillPath: use.skillPath,
                  useId: use.id,
                  view: "compare",
                })
              }
            >
              {t("externalLibrary.compare")}
            </button>
          </div>
        ))}
      </div>
    </SheetFrame>
  );
}
