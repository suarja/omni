import { LoadingSkeleton } from "../../components/ui/Skeleton";
import { harnessLabel } from "../project-view-model";
import { useState, type ReactElement } from "react";
import type { SkillIntent } from "../../../shared/skill-management-ipc";
import { useI18n } from "../../i18n";
import { SheetFrame } from "../SheetFrame";
import { Glossary } from "../Glossary";
import { useCanvasRail } from "../rail/rail-context";
import { comparisonReady, formatSourceDate, waitsForUpdate } from "./presentation";
import { useExternalOperation } from "./use-external-operation";
import { ComparisonFiles } from "./ComparisonFiles";
import { OperationEvidence } from "./OperationEvidence";
import { useExternalComparisons } from "./use-external-comparisons";
import "../new-skill.css";
import { resolveExternalSkill, type ExternalSkillTarget } from "../pages/external-skill-selection";

export function UpdateSheet(
  props: Readonly<{ sourceId: string; onApplyingChange: (busy: boolean) => void }> & ExternalSkillTarget,
): ReactElement | null {
  const rail = useCanvasRail();
  const { t, language } = useI18n();
  const details = rail?.externalLibrary.details.get(props.sourceId);
  const uses = resolveExternalSkill(details, props).uses.filter(waitsForUpdate);
  const [selected, setSelected] = useState<readonly string[]>(() =>
    props.useId ? [props.useId] : uses.map((use) => use.id),
  );
  const api = rail?.canvas.api;
  const { comparisons, choices, errors, evidence, changeChoice } = useExternalComparisons(api, details, uses);
  const targets = uses.filter((use) => selected.includes(use.id));
  const ready =
    targets.length > 0 &&
    targets.every((use) => {
      const comparison = comparisons.get(use.id);
      return Boolean(
        comparison &&
        (use.state === "update"
          ? comparison.status === "ready" || comparison.base.status === "not-found"
          : comparisonReady(comparison, choices.get(use.id)?.files ?? {}, choices.get(use.id)?.wholeCopy)),
      );
    });
  const intents: SkillIntent[] = [];
  if (ready) {
    const unchanged = targets.filter((use) => use.state === "update");
    if (unchanged.length)
      intents.push({
        kind: "update-external-skills",
        sourceId: props.sourceId,
        useIds: unchanged.map((use) => use.id),
      });
    for (const use of targets.filter((use) => use.state === "modified")) {
      const choice = choices.get(use.id);
      intents.push({
        kind: "merge-external-skill",
        sourceId: props.sourceId,
        useId: use.id,
        choices: Object.entries(choice?.files ?? {}).map(([path, choice]) => ({ path, choice })),
        ...(choice?.wholeCopy ? { wholeCopy: choice.wholeCopy } : {}),
      });
    }
  }
  const operation = useExternalOperation(
    rail!.canvas,
    intents,
    props.onApplyingChange,
    rail!.externalLibrary.reload,
    JSON.stringify(targets.map((use) => evidence.get(use.id))),
  );
  if (!rail) return null;
  const source = details?.source;
  return (
    <SheetFrame
      title={t("externalLibrary.updateTitle")}
      kicker={
        <>
          {props.skillName} <Glossary concept="library" />
        </>
      }
      subtitle={`${source?.name ?? props.sourceId} · ${t("externalLibrary.versionShort", { version: source?.head?.commit.slice(0, 7) ?? "—", date: formatSourceDate(source?.head?.date, language) })}`}
      className="external-library-sheet"
      testId="external-update-sheet"
      onClose={rail.close}
      busy={operation.applying}
      footer={
        <>
          <button type="button" className="canvas-secondary-button" disabled={operation.applying} onClick={rail.close}>
            {t("externalLibrary.cancel")}
          </button>
          <span className="skill-footer-note">{t("externalLibrary.neverAuto")}</span>
          <button
            type="button"
            className="canvas-secondary-button is-primary"
            disabled={!operation.ready}
            onClick={() => void operation.apply()}
          >
            {t("externalLibrary.updateAction", { count: targets.length })}
          </button>
        </>
      }
    >
      <section className="external-section">
        <h3>
          {t("externalLibrary.sinceInstall")}{" "}
          <Glossary concept={uses.some((use) => use.state === "modified") ? "modified" : "upstream"} />
        </h3>
        {uses.map((use) => {
          const comparison = comparisons.get(use.id),
            choice = choices.get(use.id);
          return (
            <div key={use.id} data-use-id={use.id}>
              <b>{use.projectName}</b>
              {errors.has(use.id) ? (
                <p role="alert">{errors.get(use.id)}</p>
              ) : !comparison ? (
                <LoadingSkeleton label={t("projectView.loading")} variant="rows" />
              ) : comparison.base.status === "not-found" && use.state === "modified" ? (
                <>
                  <p>{t("externalLibrary.missingBase")}</p>
                  <div className="new-skill-segment" role="group" aria-label={use.projectName}>
                    {(["mine", "source"] as const).map((value) => (
                      <button
                        type="button"
                        key={value}
                        aria-pressed={choice?.wholeCopy === value}
                        disabled={operation.applying}
                        onClick={() => changeChoice(use.id, { files: {}, wholeCopy: value })}
                      >
                        {t(value === "mine" ? "externalLibrary.mineCopy" : "externalLibrary.sourceCopy")}
                      </button>
                    ))}
                  </div>
                </>
              ) : comparison.status !== "ready" ? (
                <p role="alert">
                  {comparison.diagnostic ??
                    (comparison.base.status === "unknown" ? comparison.base.reason : t("externalLibrary.missingBase"))}
                </p>
              ) : (
                <ComparisonFiles
                  busy={operation.applying}
                  comparison={comparison}
                  choices={choice?.files ?? {}}
                  onChoice={(path, value) => changeChoice(use.id, { files: { ...choice?.files, [path]: value } })}
                />
              )}
            </div>
          );
        })}
        {uses.some((use) => use.state === "modified") ? (
          <small className="skill-hint">{t("externalLibrary.baseHint")}</small>
        ) : null}
      </section>
      <section className="external-section">
        <h3>{t("externalLibrary.where")}</h3>
        <div className="external-options">
          {uses.map((use) => (
            <label className="external-option" key={use.id}>
              <input
                type="checkbox"
                checked={selected.includes(use.id)}
                disabled={operation.applying}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked ? [...current, use.id] : current.filter((id) => id !== use.id),
                  )
                }
              />
              <span>
                {use.projectName}{" "}
                <small>
                  {[
                    ...new Set(
                      operation.previews.flatMap((preview) =>
                        preview.status === "ready"
                          ? preview.scope.targets
                              .filter((target) => target.projectId === use.projectId)
                              .map((target) => harnessLabel(target.harnessId))
                          : [],
                      ),
                    ),
                  ].join(t("externalLibrary.and"))}{" "}
                  {use.state === "modified" ? t("externalLibrary.modified") : ""}
                </small>
              </span>
            </label>
          ))}
        </div>
      </section>
      <section className="external-section">
        <h3>{t("externalLibrary.changes")}</h3>
        <div className="external-rows">
          <div className="external-row">
            <div>
              <b>{targets.map((use) => use.projectName).join(", ")}</b>
              <small>{t("externalLibrary.updateEffects")}</small>
            </div>
          </div>
        </div>
      </section>
      <OperationEvidence {...operation} />
    </SheetFrame>
  );
}
